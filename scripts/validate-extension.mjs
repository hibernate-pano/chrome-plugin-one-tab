import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const readJson = (relativePath) => {
  const filePath = resolve(root, relativePath);
  return JSON.parse(readFileSync(filePath, 'utf8'));
};

const fail = (message) => {
  console.error(`Validation failed: ${message}`);
  process.exit(1);
};

const packageJson = readJson('package.json');
const manifestJson = readJson('manifest.json');

if (packageJson.version !== manifestJson.version) {
  fail(`package.json version ${packageJson.version} does not match manifest.json version ${manifestJson.version}`);
}

if (manifestJson.background?.service_worker !== 'service-worker.js') {
  fail('manifest.json background.service_worker must be service-worker.js');
}

if (existsSync(resolve(root, 'src/service-worker.js'))) {
  fail('Legacy src/service-worker.js should not exist');
}

console.log(`Validated extension metadata for version ${packageJson.version}`);
