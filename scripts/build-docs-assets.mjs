import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/config.mjs';
import { inProject } from './paths.mjs';

// Publishes a compact payload for GitHub Pages. Never copies `raw` or `items`.
//
//   node scripts/build-docs-assets.mjs            -> docs/assets/results.json (+ threshold_sweep.json)
//   node scripts/build-docs-assets.mjs --tag foo  -> docs/assets/results.foo.json and an entry in
//                                                    docs/assets/runs.json (shown as "other runs")

const OUT_DIR = inProject('docs/assets');
const MANIFEST = inProject('docs/assets/runs.json');

function mustReadJson(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${p}. Run: node scripts/run-eval.mjs first.`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function publicResults(results) {
  return {
    generated_at: results.generated_at,
    dataset: results.dataset,
    models: results.models,
    threshold: results.threshold,
    tag: results.tag ?? null,
    summary: results.summary,
  };
}

export function upsertManifest(manifest, entry) {
  const runs = Array.isArray(manifest?.runs) ? manifest.runs.filter((r) => r.tag !== entry.tag) : [];
  runs.push(entry);
  runs.sort((a, b) => String(a.generated_at).localeCompare(String(b.generated_at)));
  return { runs };
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const tag = flags.tag && flags.tag !== true ? String(flags.tag) : null;
  if (tag && !/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) throw new Error(`--tag must match [a-z0-9._-]+`);
  const suffix = tag ? `.${tag}` : '';

  const results = mustReadJson(inProject(`data/results${suffix}.json`));
  const sweep = mustReadJson(inProject(`data/threshold_sweep${suffix}.json`));

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const outResults = inProject(`docs/assets/results${suffix}.json`);
  const outSweep = inProject(`docs/assets/threshold_sweep${suffix}.json`);

  fs.writeFileSync(outResults, JSON.stringify(publicResults(results), null, 2) + '\n');
  fs.writeFileSync(
    outSweep,
    JSON.stringify({ generated_at: sweep.generated_at, tag: sweep.tag ?? null, sweep: sweep.sweep }, null, 2) + '\n',
  );

  console.log('Wrote', outResults);
  console.log('Wrote', outSweep);

  if (tag) {
    const existing = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { runs: [] };
    const manifest = upsertManifest(existing, {
      tag,
      results: `results${suffix}.json`,
      sweep: `threshold_sweep${suffix}.json`,
      generated_at: results.generated_at,
    });
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log('Updated', MANIFEST);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
