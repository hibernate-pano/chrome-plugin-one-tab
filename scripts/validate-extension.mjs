import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const readJson = (relativePath) => {
  const filePath = resolve(root, relativePath);
  return JSON.parse(readFileSync(filePath, 'utf8'));
};

const readText = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

const fail = (message) => {
  console.error(`Validation failed: ${message}`);
  process.exit(1);
};

const packageJson = readJson('package.json');
const manifestJson = readJson('manifest.json');
const readme = readText('README.md');

if (packageJson.version !== manifestJson.version) {
  fail(`package.json version ${packageJson.version} does not match manifest.json version ${manifestJson.version}`);
}

const readmeVersionMatch = readme.match(/当前版本：`([^`]+)`/);
if (!readmeVersionMatch) {
  fail('README.md must declare the current version in the expected format');
}

if (readmeVersionMatch[1] !== packageJson.version) {
  fail(`README.md version ${readmeVersionMatch[1]} does not match package.json version ${packageJson.version}`);
}

if (manifestJson.background?.service_worker !== 'service-worker.js') {
  fail('manifest.json background.service_worker must be service-worker.js');
}

if (existsSync(resolve(root, 'src/service-worker.js'))) {
  fail('Legacy src/service-worker.js should not exist');
}

if (!existsSync(resolve(root, 'PRIVACY_POLICY.md'))) {
  fail('PRIVACY_POLICY.md must exist for Chrome Web Store disclosure');
}

const envExamplePath = resolve(root, '.env.example');
if (existsSync(envExamplePath)) {
  const envExample = readFileSync(envExamplePath, 'utf8');
  const supabaseUrlMatch = envExample.match(/^VITE_SUPABASE_URL=(.+)$/m);

  if (supabaseUrlMatch) {
    const supabaseUrl = supabaseUrlMatch[1].trim();
    if (!supabaseUrl.includes('your-project-id.supabase.co')) {
      const expectedOrigin = new URL(supabaseUrl).origin;
      const csp = manifestJson.content_security_policy?.extension_pages ?? '';
      const hostPermissions = manifestJson.host_permissions ?? [];

      if (!csp.includes(expectedOrigin)) {
        fail(`manifest.json CSP connect-src must include ${expectedOrigin}`);
      }

      if (!hostPermissions.includes(`${expectedOrigin}/*`)) {
        fail(`manifest.json host_permissions must include ${expectedOrigin}/*`);
      }
    }
  }
}

console.log(`Validated extension metadata for version ${packageJson.version}`);
