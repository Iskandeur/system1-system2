import fs from 'node:fs';

import { inProject } from './paths.mjs';

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('OPENROUTER_API_KEY missing');
  process.exit(1);
}

const outArg = process.argv[2];
if (!outArg) {
  console.error('Usage: node scripts/get-openrouter-credits.mjs <out-json-path-relative-to-project>');
  process.exit(1);
}

const outPath = inProject(outArg);

const res = await fetch('https://openrouter.ai/api/v1/credits', {
  headers: { Authorization: 'Bearer ' + key },
});

const text = await res.text();
let json;
try {
  json = text ? JSON.parse(text) : null;
} catch {
  json = { _parse_error: true, raw: text };
}

fs.mkdirSync(inProject('scratch'), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ http_status: res.status, body: json }, null, 2) + '\n');

// Best-effort parse remaining credits.
const d = json?.data ?? json;
const candidates = [
  d?.total_credits,
  d?.credits,
  d?.remaining,
  d?.remaining_credits,
];

let remaining = null;
for (const c of candidates) {
  const n = Number(c);
  if (Number.isFinite(n)) {
    remaining = n;
    break;
  }
}

console.log(
  JSON.stringify(
    {
      http_status: res.status,
      remaining_usd: remaining,
      wrote: outArg,
    },
    null,
    2,
  ),
);
