import fs from 'node:fs';

import { inProject } from './paths.mjs';

const SRC_RESULTS = inProject('data/results.json');
const SRC_SWEEP = inProject('data/threshold_sweep.json');

const OUT_DIR = inProject('docs/assets');
const OUT_RESULTS = inProject('docs/assets/results.json');
const OUT_SWEEP = inProject('docs/assets/threshold_sweep.json');

function mustReadJson(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${p}. Run: node scripts/run-eval.mjs first.`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const results = mustReadJson(SRC_RESULTS);
  const sweep = mustReadJson(SRC_SWEEP);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Publish a compact payload for GitHub Pages.
  const publicResults = {
    generated_at: results.generated_at,
    dataset: results.dataset,
    models: results.models,
    threshold: results.threshold,
    summary: results.summary,
  };

  fs.writeFileSync(OUT_RESULTS, JSON.stringify(publicResults, null, 2) + '\n');
  fs.writeFileSync(OUT_SWEEP, JSON.stringify(sweep, null, 2) + '\n');

  console.log('Wrote', OUT_RESULTS);
  console.log('Wrote', OUT_SWEEP);
}

main();
