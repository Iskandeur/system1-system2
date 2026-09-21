import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inProject } from './paths.mjs';

// Writes docs/assets/manifest.json: the list of result files the results page loads, in order.
// The analyses themselves write directly to docs/assets/results/*.json; the page is static and
// only replays those files (no key ever reaches the browser).

const RESULTS_DIR = inProject('docs/assets/results');
const MANIFEST = inProject('docs/assets/manifest.json');

export function buildManifest(files) {
  const entries = files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const doc = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
      const injected = !!doc.dataset?.templates;
      return {
        id: f.slice(0, -5),
        file: `results/${f}`,
        kind: injected ? 'injection' : 'hybrid',
        dataset: doc.dataset?.name ?? f.slice(0, -5),
        n: doc.dataset?.count ?? null,
        generated_at: doc.generated_at ?? null,
        s1: doc.s1 ?? undefined,
        s2: doc.s2 ?? undefined,
      };
    });
  return { generated_at: new Date().toISOString(), results: entries };
}

function main() {
  if (!fs.existsSync(RESULTS_DIR)) throw new Error(`Missing ${RESULTS_DIR}. Run scripts/analyze.mjs first.`);
  const manifest = buildManifest(fs.readdirSync(RESULTS_DIR));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log('Wrote', MANIFEST, `(${manifest.results.length} result files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
