// Secret scan (PLAYBOOK Task 12.1): every tracked file and every commit in
// git history, for API keys, tokens, private keys and committed .env files.
//   node scripts/secret-scan.mjs            scan files + history
//   node scripts/secret-scan.mjs --files    tracked files only (fast, CI)
// Exits 1 on any finding. Test fixtures use obviously fake values that do not
// match these patterns.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['OpenRouter key', /\bsk-or-v1-[0-9a-f]{40,}/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{40,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{40,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  // A real Supabase JWT (anon or service role) is three base64url parts, the middle one long.
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}/],
  [
    'Supabase service-role key assignment',
    /SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"]?[A-Za-z0-9._-]{20,}/,
  ],
];
const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|.*\.pem|id_rsa)$/;

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const findings = [];

function scan(where, text) {
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) findings.push(`${where}: ${name} (${m[0].slice(0, 8)}…)`);
  }
}

const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const f of files) {
  if (SECRET_FILES.test(f)) findings.push(`${f}: a secrets file is tracked`);
  if (/\.(png|jpe?g|gif|pdf|docx|zip|woff2?)$/i.test(f)) continue;
  try {
    scan(f, readFileSync(f, 'utf8'));
  } catch {
    // unreadable (binary): skip
  }
}

if (!process.argv.includes('--files')) {
  // Every version of every file ever committed, on every branch.
  const history = git(['log', '--all', '-p', '--no-color', '--format=commit %H']);
  let commit = '';
  for (const chunk of history.split('\n')) {
    if (chunk.startsWith('commit ')) commit = chunk.slice(7, 15);
    else if (chunk.startsWith('+') && !chunk.startsWith('+++')) scan(`history ${commit}`, chunk);
  }
  const everAdded = git(['log', '--all', '--name-only', '--format=']).split('\n').filter(Boolean);
  for (const f of new Set(everAdded))
    if (SECRET_FILES.test(f)) findings.push(`history: ${f} was committed at some point`);
}

if (findings.length) {
  console.error(
    `Secret scan found ${findings.length} problem(s):\n${findings.map((f) => `  - ${f}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `Secret scan clean: ${files.length} tracked files${process.argv.includes('--files') ? '' : ' and the full git history'}.`,
);
