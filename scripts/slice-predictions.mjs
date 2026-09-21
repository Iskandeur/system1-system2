import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/config.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { inProject } from './paths.mjs';

// Slice an existing predictions file down to the ids of another dataset.
//
// Use case: build a smaller dataset (e.g. massive-en-openweights) and reuse already-recorded
// predictions from the full dataset (massive-en) without re-calling any model.
//
// Example:
//   node scripts/slice-predictions.mjs --from massive-en --to massive-en-openweights --tag gpt-5.2 --out gpt-5.2-openweights
//
// Writes:
//   data/predictions/<to>/<out>.json

function predictionsPath(datasetName, tag) {
  return inProject('data/predictions', datasetName, `${tag}.json`);
}

function summarizeRows(rows) {
  const n = rows.length;
  const correct = rows.filter((r) => r.pred === r.truth).length;
  const known = rows.filter((r) => typeof r.cost === 'number');
  const costTotal = known.reduce((a, r) => a + r.cost, 0);
  const meanLatency = n ? rows.reduce((a, r) => a + (r.latency_ms || 0), 0) / n : 0;
  return {
    n,
    correct,
    accuracy: n ? correct / n : 0,
    cost_total_usd: costTotal,
    cost_per_1k_usd: known.length ? (costTotal / known.length) * 1000 : null,
    cost_coverage: n ? known.length / n : 0,
    mean_latency_ms: meanLatency,
  };
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const from = flags.from && flags.from !== true ? String(flags.from) : null;
  const to = flags.to && flags.to !== true ? String(flags.to) : null;
  const tag = flags.tag && flags.tag !== true ? String(flags.tag) : null;
  const outTag = flags.out && flags.out !== true ? String(flags.out) : null;
  if (!from || !to || !tag || !outTag) {
    throw new Error('Usage: --from <dataset> --to <dataset> --tag <tag> --out <new_tag>');
  }

  const toDs = loadDataset(to);
  const wanted = new Set(toDs.items.map((it) => String(it.id)));

  const srcPath = predictionsPath(from, tag);
  if (!fs.existsSync(srcPath)) throw new Error(`Missing source predictions: ${srcPath}`);
  const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));

  const items = Array.isArray(src.items) ? src.items.filter((r) => wanted.has(String(r.id))) : [];
  if (items.length !== toDs.items.length) {
    throw new Error(`Sliced items mismatch: got ${items.length}, expected ${toDs.items.length}`);
  }

  const doc = {
    ...src,
    dataset: toDs.name,
    tag: outTag,
    generated_at: new Date().toISOString(),
    complete: true,
    count: items.length,
    errors: items.filter((r) => r && r.error).length,
    cache: null,
    summary: summarizeRows(items),
    items,
  };

  const outPath = predictionsPath(toDs.name, outTag);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 1) + '\n');
  console.log('Wrote', outPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
