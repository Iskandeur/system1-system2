import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/config.mjs';
import { loadDataset, saveDataset } from '../src/dataset.mjs';
import { buildInjectionSet, INJECTION_TEMPLATES } from '../src/injection.mjs';
import { mulberry32, seededShuffle } from '../src/metrics.mjs';
import { stratifiedSubset } from '../src/task.mjs';

// Builds data/<dataset>-injected.json: a seeded, label-stratified sample of source items, each
// repeated once per injection template with the attacker payload appended.
//
//   node scripts/build-injection-set.mjs --dataset massive-en --base 80 --seed 7

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const datasetName = flags.dataset && flags.dataset !== true ? String(flags.dataset) : 'massive-en';
  const base = Number(flags.base || 80);
  const seed = Number(flags.seed || 7);
  const dataset = loadDataset(datasetName);

  // Shuffle with the seed, then take a label-stratified subset so every label is attacked.
  const shuffled = seededShuffle(dataset.items, mulberry32(seed));
  const ids = stratifiedSubset(shuffled, base).map((it) => it.id);

  const doc = buildInjectionSet(dataset, { ids, seed });
  doc.source.base_items = ids.length;
  doc.source.sampling = `${ids.length} source items: seeded shuffle (seed ${seed}) then label-stratified round-robin; one target label per source item, never its true label`;
  const p = saveDataset(doc);
  console.log(`Wrote ${p} (${doc.items.length} items = ${ids.length} sources x ${Object.keys(INJECTION_TEMPLATES).length} templates)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
