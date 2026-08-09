#!/usr/bin/env node
/**
 * Sprint 4 工具：审计依赖漏洞现状（不修复，只报告）。
 *
 * 注意：国内默认 pnpm 镜像源没有 audit endpoint，需切到 npmjs.org。
 * 这里写死使用官方源，确保在 CI / 本地都一致。
 *
 * 用法：
 *   pnpm audit:fix         # 显示当前漏洞统计
 *   pnpm audit:fix --strict  # 有 high 漏洞时 exit 1（给 CI 用）
 */

import { execSync } from 'node:child_process';

const STRICT = process.argv.includes('--strict');

console.log('Running pnpm audit (registry=npmjs.org)...');
let stdout;
try {
  stdout = execSync('pnpm audit --json --registry=https://registry.npmjs.org', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) {
  // pnpm audit exits non-zero when vulns found, but we still get JSON
  stdout = e.stdout?.toString() || '{}';
}

let data;
try {
  data = JSON.parse(stdout);
} catch {
  console.error('Failed to parse audit output. Try running `pnpm audit --registry=https://registry.npmjs.org` manually.');
  process.exit(2);
}

const meta = data.metadata?.vulnerabilities ?? {};
const total = (meta.high ?? 0) + (meta.moderate ?? 0) + (meta.low ?? 0) + (meta.critical ?? 0);

console.log('\n=== Vulnerability Summary ===');
console.log(`Critical: ${meta.critical ?? 0}`);
console.log(`High:     ${meta.high ?? 0}`);
console.log(`Moderate: ${meta.moderate ?? 0}`);
console.log(`Low:      ${meta.low ?? 0}`);
console.log(`Total:    ${total}`);

if (STRICT && (meta.high ?? 0) > 0) {
  console.error(`\n❌ Strict mode: ${meta.high} HIGH vulnerabilities detected. Failing.`);
  process.exit(1);
}

console.log(`\n✅ Audit complete${total === 0 ? ' — no vulnerabilities' : ''}`);
