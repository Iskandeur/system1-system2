import fs from 'node:fs';

import { parseArgs } from '../src/config.mjs';
import { loadDataset, saveDataset } from '../src/dataset.mjs';
import { mulberry32, seededShuffle } from '../src/metrics.mjs';
import { stratifiedSubset } from '../src/task.mjs';

// Build smaller, deterministic datasets for local (open-weight) CPU baselines.
//
// Why this exists: open-weight decision models are slower on CPU than Jev via OpenRouter.
// When a full 600-item run is too slow, we publish a stratified subset that keeps the label mix
// and uses the same ids in en and fr.
//
//   node scripts/build-openweights-subset.mjs --n 120 --seed 7
//
// Output:
//   data/massive-en-openweights.json
//   data/massive-fr-openweights.json

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const n = flags.n !== undefined && flags.n !== true ? Number(flags.n) : 30;
  const seed = flags.seed !== undefined && flags.seed !== true ? Number(flags.seed) : 7;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--n must be a positive integer`);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`--seed must be a non-negative integer`);

  const en = loadDataset('massive-en');
  const fr = loadDataset('massive-fr');

  const rng = mulberry32(seed);
  const shuffled = seededShuffle(en.items, rng);
  const subset = stratifiedSubset(shuffled, n);
  const idSet = new Set(subset.map((it) => String(it.id)));

  const keep = (ds) => ds.items.filter((it) => idSet.has(String(it.id)));
  const generated_at = new Date().toISOString();

  const write = (ds, name) => {
    const items = keep(ds);
    if (items.length !== subset.length) throw new Error(`${name}: expected ${subset.length} items, got ${items.length}`);

    const doc = {
      ...ds,
      name,
      generated_at,
      source: {
        ...ds.source,
        derived_from: ds.name,
        openweights_subset: {
          n: items.length,
          seed,
          method: `seeded shuffle (seed ${seed}) then label-stratified round-robin (src/task.mjs stratifiedSubset)`,
        },
      },
      items,
      count: items.length,
    };

    // Dataset files are written with 2-space indent (src/dataset.mjs).
    saveDataset(doc);
    const p = `data/${name}.json`;
    const size = fs.statSync(ds.path).size;
    console.log(`Wrote ${p} (${items.length} items; source file size ${size} bytes)`);
  };

  write(en, 'massive-en-openweights');
  write(fr, 'massive-fr-openweights');
}

main();
