import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { projectRoot as ROOT } from './paths.mjs';

// Fails when the tree (or, with --history, the whole git history) contains an API key, a committed
// .env, or one of a few terms that identify a private endpoint used during development. Those
// terms are hex-encoded here so that this file does not itself contain them.
//
//   node scripts/lint-no-secrets.mjs            # working tree
//   node scripts/lint-no-secrets.mjs --history  # also every commit (git log -p --all)

export const BLOCK_PATTERNS = [
  { name: 'OpenAI key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9-_]{20,}\b/ },
  { name: 'OpenRouter key-ish', re: /\b(or_|openrouter_)[A-Za-z0-9]{20,}\b/i },
  { name: 'Bearer token literal', re: /Bearer\s+[A-Za-z0-9._-]{32,}/ },
  { name: 'OPENROUTER_API_KEY assignment', re: /^[ \t]*OPENROUTER_API_KEY[ \t]*=[ \t]*\S+/m },
  { name: 'ANTHROPIC_AUTH_TOKEN assignment', re: /^[ \t]*ANTHROPIC_AUTH_TOKEN[ \t]*=[ \t]*\S+/m },
];

const FORBIDDEN_HEX = ['647261676f6e666c79', '696e7472696e736563', '6169796f75', '617a2d677074'];

export function forbiddenTerms(hexList = FORBIDDEN_HEX) {
  return hexList.map((h) => Buffer.from(h, 'hex').toString('utf8'));
}

export function scanText(text, { patterns = BLOCK_PATTERNS, terms = forbiddenTerms() } = {}) {
  const hits = [];
  for (const pat of patterns) if (pat.re.test(text)) hits.push(pat.name);
  const lower = text.toLowerCase();
  for (const t of terms) if (lower.includes(t)) hits.push(`forbidden term (${t.length} chars, starts with "${t[0]}")`);
  return hits;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache']);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, out);
      continue;
    }
    if (ent.isFile()) out.push(p);
  }
}

export function lintTree(root = ROOT) {
  const files = [];
  walk(root, files);
  const hits = [];
  for (const p of files) {
    const rel = path.relative(root, p);
    if (rel === '.env') {
      hits.push({ file: rel, pattern: '.env file present' });
      continue;
    }
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) continue; // binary
    for (const name of scanText(buf.toString('utf8'))) hits.push({ file: rel, pattern: name });
  }
  return hits;
}

export function lintHistory(root = ROOT) {
  const r = spawnSync('git', ['log', '-p', '--all', '--no-color'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git log failed: ${r.stderr}`);
  return scanText(r.stdout).map((name) => ({ file: 'git history', pattern: name }));
}

function main() {
  const history = process.argv.includes('--history');
  const hits = [...lintTree(), ...(history ? lintHistory() : [])];
  if (hits.length) {
    console.error('Potential secrets or forbidden terms detected:');
    for (const h of hits) console.error('-', h.file, '=>', h.pattern);
    process.exit(1);
  }
  console.log(`OK: no secrets or forbidden terms in the tree${history ? ' or the git history' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
