// Production build audit (PLAYBOOK Task 12.1). Run after
// `pnpm --filter @filler/extension build`:
//   node scripts/audit-build.mjs [path to chrome-mv3 output]
// Checks: minimal permissions, no host permissions at install, no CSP
// loosening (Chrome's strict MV3 default applies), no remote code, no eval.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'apps/extension/.output/chrome-mv3';
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const problems = [];
const expectEqual = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want))
    problems.push(`${what}: ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
};

expectEqual('manifest_version', manifest.manifest_version, 3);
expectEqual('permissions', [...(manifest.permissions ?? [])].sort(), [
  'activeTab',
  'scripting',
  'sidePanel',
  'storage',
]);
expectEqual('host_permissions', manifest.host_permissions ?? [], []);
expectEqual('optional_host_permissions', manifest.optional_host_permissions ?? [], [
  'http://*/*',
  'https://*/*',
]);
if (manifest.content_security_policy)
  problems.push('content_security_policy is overridden (keep the MV3 default)');
if (manifest.content_scripts?.length)
  problems.push('content_scripts are declared (Filler injects on demand only)');
if (manifest.externally_connectable)
  problems.push('externally_connectable is set (web pages must not talk to Filler)');
if (manifest.web_accessible_resources?.length)
  problems.push('web_accessible_resources are exposed to web pages');

const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const full = join(d, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(dir);
for (const f of files.filter((f) => /\.(m?js|html)$/.test(f))) {
  const text = readFileSync(f, 'utf8');
  if (/\beval\(|new Function\(/.test(text)) problems.push(`${f}: eval or new Function`);
  if (/importScripts\(\s*['"]https?:|<script[^>]+src=['"]https?:/i.test(text))
    problems.push(`${f}: loads remote code`);
}

if (problems.length) {
  console.error(`Build audit failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `Build audit clean: ${files.length} files, permissions ${manifest.permissions.join(', ')}.`,
);
