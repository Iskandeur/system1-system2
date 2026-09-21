import fs from 'node:fs';
import path from 'node:path';

import { projectRoot as ROOT } from './paths.mjs';

const BLOCK_PATTERNS = [
  // Common API key prefixes
  { name: 'OpenAI key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9-_]{20,}\b/ },
  { name: 'OpenRouter key-ish', re: /\b(or_|openrouter_)[A-Za-z0-9]{20,}\b/i },
  // Accidental committed env keys
  // Only flag when a non-whitespace value is present on the same line.
  { name: 'OPENROUTER_API_KEY assignment', re: /^[ \t]*OPENROUTER_API_KEY[ \t]*=[ \t]*\S+/m },
];

const SKIP_DIRS = new Set(['node_modules', '.git']);

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

function main() {
  const files = [];
  walk(ROOT, files);

  const hits = [];

  for (const p of files) {
    const rel = path.relative(ROOT, p);

    if (rel === '.env') {
      hits.push({ file: rel, pattern: '.env file present' });
      continue;
    }

    const buf = fs.readFileSync(p);
    // Skip binary-ish
    if (buf.includes(0)) continue;

    const text = buf.toString('utf8');
    for (const pat of BLOCK_PATTERNS) {
      if (pat.re.test(text)) {
        hits.push({ file: rel, pattern: pat.name });
      }
    }
  }

  if (hits.length) {
    console.error('Potential secrets detected:');
    for (const h of hits) console.error('-', h.file, '=>', h.pattern);
    process.exit(1);
  }

  console.log('OK: no obvious secrets found');
}

main();
