import fs from 'node:fs';
import path from 'node:path';

import { inProject } from './paths.mjs';
import { normalizeTask } from './task.mjs';

// Dataset files: { name, generated_at, source, task, count, items: [{ id, text, truth, meta }] }.
// `name` is what predictions and results are filed under.

export function datasetPath(nameOrPath) {
  if (!nameOrPath) throw new Error('dataset name or path required');
  return nameOrPath.endsWith('.json') ? path.resolve(nameOrPath) : inProject('data', `${nameOrPath}.json`);
}

export function loadDataset(nameOrPath) {
  const p = datasetPath(nameOrPath);
  if (!fs.existsSync(p)) throw new Error(`Dataset not found: ${p}`);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  const name = json.name ?? path.basename(p, '.json');
  const task = normalizeTask(json.task);
  const items = Array.isArray(json.items) ? json.items : [];
  if (!items.length) throw new Error(`Dataset ${name} has no items`);
  for (const it of items) {
    if (it.id === undefined || typeof it.text !== 'string' || typeof it.truth !== 'string') {
      throw new Error(`Dataset ${name}: every item needs id, text and truth (offending item: ${JSON.stringify(it).slice(0, 120)})`);
    }
    if (!task.labels.includes(it.truth)) throw new Error(`Dataset ${name}: item ${it.id} has unknown truth "${it.truth}"`);
  }
  return { ...json, name, task, items, path: p };
}

export function saveDataset(doc, p = datasetPath(doc.name)) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...doc, count: doc.items.length }, null, 2) + '\n');
  return p;
}
