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
  if (!filepath.startsWith(SRC_DIR + '/')) {
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
  return {
    format: 'module',
    source: transformed.outputText,
    shortCircuit: true,
  };
}
