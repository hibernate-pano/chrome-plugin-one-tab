// Custom Node module loader that:
// 1. Resolves the project's "@/" path alias to "src/"
// 2. Resolves TypeScript-style relative imports (without .ts extension)
// 3. Transforms .ts source code via TypeScript compiler to handle
//    value imports of type-only exports (which --experimental-strip-types
//    does not handle on its own).
// 4. Replaces `import.meta.env` (Vite API) with a Node-side stub.

import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve as resolvePath, dirname, extname } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import ts from 'typescript';

const PROJECT_ROOT = '/Users/panbo/Code/Demos/chrome-plugin-one-tab';
const SRC_DIR = resolvePath(PROJECT_ROOT, 'src');

// Vite-style env stub used to satisfy `import.meta.env` reads.
globalThis.__TABSTACK_META_ENV__ = globalThis.__TABSTACK_META_ENV__ || {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

function tryResolve(target) {
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.mts`,
    `${target}.mjs`,
    `${target}.js`,
    resolvePath(target, 'index.ts'),
    resolvePath(target, 'index.tsx'),
    resolvePath(target, 'index.mts'),
    resolvePath(target, 'index.mjs'),
    resolvePath(target, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL;
  let baseDir = null;

  if (parentURL && parentURL.startsWith('file://')) {
    baseDir = dirname(fileURLToPath(parentURL));
  }

  if (specifier.startsWith('@/')) {
    const target = resolvePath(SRC_DIR, specifier.slice(2));
    const resolved = tryResolve(target);
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true, format: 'module' };
    }
  }

  if (baseDir && (baseDir.startsWith(SRC_DIR)) &&
      (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const target = resolvePath(baseDir, specifier);
    const resolved = tryResolve(target);
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true, format: 'module' };
    }
  }

  if (parentURL && parentURL.startsWith('file://')) {
    const parentPath = fileURLToPath(parentURL);
    if (extname(parentPath) === '') {
      const parentResolved = tryResolve(parentPath);
      if (parentResolved && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        const newTarget = resolvePath(dirname(parentResolved), specifier);
        const resolved = tryResolve(newTarget);
        if (resolved) {
          return { url: pathToFileURL(resolved).href, shortCircuit: true, format: 'module' };
        }
      }
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file://')) {
    return nextLoad(url, context);
  }
  const filepath = fileURLToPath(url);
  if (!filepath.endsWith('.ts') && !filepath.endsWith('.tsx') && !filepath.endsWith('.mts')) {
    return nextLoad(url, context);
  }
  // Restrict TypeScript transpilation to source and test directories.
  // Test files outside SRC_DIR (e.g. tests/components/*.tsx) also need
  // transformation because --experimental-strip-types handles .ts but not
  // .tsx. The loader is the single shared transpilation path.
  const inScope =
    filepath.startsWith(SRC_DIR + '/') ||
    filepath.startsWith(resolvePath(PROJECT_ROOT, 'tests') + '/');
  if (!inScope) {
    return nextLoad(url, context);
  }
  if (!filepath.endsWith('.ts') && !filepath.endsWith('.tsx') && !filepath.endsWith('.mts')) {
    return nextLoad(url, context);
  }

  const source = readFileSync(filepath, 'utf8');
  const compilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    isolatedModules: true,
    importHelpers: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    // JSX support for .tsx files under both src/ and tests/. The runtime
    // JSX helper (`react/jsx-runtime`) is matched automatically by the
    // `react-jsx` transform.
    jsx: ts.JsxEmit.ReactJSX,
  };
  let transformed = ts.transpileModule(source, {
    compilerOptions,
    fileName: filepath,
    reportDiagnostics: false,
  });
  // Replace Vite's `import.meta.env` with our Node-side stub.
  transformed.outputText = transformed.outputText.replace(
    /import\.meta\.env/g,
    'globalThis.__TABSTACK_META_ENV__'
  );
  // Rewrite `import { throttle } from 'lodash'` (and similar named
  // imports from the lodash CJS bundle) into the per-function default
  // import path. Node's ESM loader cannot extract named exports from a
  // CJS package, so the original source-level named import never resolves
  // at runtime. The source code is untouched; this is a test-infra-only
  // transformation to make the existing src importable under node:test.
  transformed.outputText = rewriteLodashNamedImports(transformed.outputText);
  return {
    format: 'module',
    source: transformed.outputText,
    shortCircuit: true,
  };
}

/**
 * Convert `import { foo, bar } from 'lodash'` to
 * `import foo from 'lodash/foo.js'; import bar from 'lodash/bar.js';`
 * for the top-level `lodash` specifier only. Local subpath imports
 * (`lodash/foo`) are passed through unchanged.
 */
function rewriteLodashNamedImports(source) {
  const namedImportFromLodash = /import\s*\{([^}]+)\}\s*from\s*['"]lodash['"];?/g;
  return source.replace(namedImportFromLodash, (_match, namesRaw) => {
    const names = namesRaw
      .split(',')
      .map(n => n.trim())
      .filter(n => n.length > 0)
      // `foo as bar` or default `foo` are both valid bindings; keep the
      // local identifier (the part after `as` if present, else the name).
      .map(binding => {
        const asMatch = binding.match(/^(\S+)\s+as\s+(\S+)$/);
        return {
          imported: asMatch ? asMatch[1] : binding,
          local: asMatch ? asMatch[2] : binding,
        };
      });
    return names
      .map(n => `import ${n.local} from 'lodash/${n.imported}.js';`)
      .join(' ');
  });
}
