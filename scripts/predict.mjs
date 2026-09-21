import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotEnv } from '../src/env.mjs';
import { resolveRunConfig, publicSystem, resolveAuth, applyListPrices, helpText } from '../src/config.mjs';
import { createAdapter } from '../src/adapters/index.mjs';
import { createCache } from '../src/cache.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { withDefense, stratifiedSubset, DEFENSES } from '../src/task.mjs';
import { summarize, roundDeep } from '../src/metrics.mjs';
import { inProject } from './paths.mjs';

// Runs ONE system over ONE dataset and files the per-item predictions under
// data/predictions/<dataset>/<tag>.json. Every response is cached on disk, so a rerun is free and
// a crash loses at most the call in flight. Analyses (scripts/analyze.mjs) read these files.

loadDotEnv({ file: inProject('.env') });

export function predictionsPath(datasetName, tag) {
  return inProject('data/predictions', datasetName, `${tag}.json`);
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function defaultTag(system, defense = 'none') {
  return slugify(system.model) + (defense !== 'none' ? `-${defense}` : '');
}

export function loadPrices() {
  const p = inProject('data/prices.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function compactRow(item, r) {
  return {
    id: item.id,
    truth: item.truth,
    pred: r.label,
    confidence: r.confidence,
    confidence_source: r.confidence_source,
    self_reported_confidence: r.self_reported_confidence ?? undefined,
    probabilities: r.probabilities ?? undefined,
    cost: r.cost,
    cost_source: r.cost_source,
    latency_ms: r.latency_ms,
    cached: r.cached || undefined,
    input_tokens: r.input_tokens ?? undefined,
    output_tokens: r.output_tokens ?? undefined,
  };
}

export async function predict({ system, role, datasetName, tag, defense = 'none', limit = null, useCache = true, env = process.env, log = () => {} }) {
  if (!DEFENSES.includes(defense)) throw new Error(`--defense must be one of ${DEFENSES.join('|')}`);
  const dataset = loadDataset(datasetName);
  const task = withDefense(dataset.task, defense);
  const items = limit ? stratifiedSubset(dataset.items, limit) : dataset.items;

  applyListPrices(system, loadPrices());
  resolveAuth(system, env); // fail early, by name
  const cache = useCache ? createCache({ dir: inProject('.cache/responses') }) : null;
  const adapter = createAdapter(system, {
    env,
    cache,
    task,
    onRetry: ({ attempt, delay, reason }) => log(`retry ${attempt} in ${Math.round(delay / 1000)}s (${reason})`),
  });

  const outPath = predictionsPath(dataset.name, tag);
  const wantConfidence = role === 'system1';
  const rows = [];
  const errors = [];
  const startedAt = new Date().toISOString();

  const write = (final) => {
    const doc = {
      dataset: dataset.name,
      tag,
      role,
      defense,
      generated_at: new Date().toISOString(),
      started_at: startedAt,
      complete: final,
      system: publicSystem(system),
      count: rows.length,
      errors: errors.length,
      cache: cache ? cache.stats() : null,
      summary: roundDeep(summarize(rows), 6),
      items: rows,
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 1) + '\n');
    return doc;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const r = await adapter.classify({ text: item.text, wantConfidence });
      rows.push(compactRow(item, r));
      if (!r.cached) await new Promise((res) => setTimeout(res, 100));
    } catch (e) {
      errors.push({ id: item.id, error: String(e.message).slice(0, 300) });
      rows.push({ id: item.id, truth: item.truth, pred: null, confidence: null, confidence_source: null, cost: null, cost_source: null, latency_ms: 0, error: String(e.message).slice(0, 300) });
      log(`item ${item.id}: ${e.message}`);
    }
    if ((i + 1) % 25 === 0 || i + 1 === items.length) {
      write(i + 1 === items.length);
      const s = summarize(rows);
      log(`${dataset.name}/${tag}: ${i + 1}/${items.length}  acc ${(s.accuracy * 100).toFixed(1)}%  cost $${s.cost_total_usd.toFixed(4)}  cache ${cache ? cache.stats().hits : 0} hits`);
    }
  }
  return { doc: write(true), path: outPath };
}

export function runFlags(cfg) {
  const f = cfg.flags;
  const role = f.system === 's2' || f.system === 'system2' ? 'system2' : 'system1';
  const system = cfg[role];
  const defense = f.defense && f.defense !== true ? String(f.defense) : 'none';
  return {
    role,
    system,
    datasetName: cfg.dataset,
    defense,
    tag: cfg.tag ?? defaultTag(system, defense),
    limit: cfg.limit,
    useCache: !(f['no-cache'] === true || f['no-cache'] === 'true'),
  };
}

async function main() {
  const cfg = resolveRunConfig({ argv: process.argv.slice(2), env: process.env });
  if (cfg.help) {
    process.stdout.write(helpText().replace('run-eval.mjs [options]', 'predict.mjs --system s1|s2 [options]'));
    return;
  }
  const opts = runFlags(cfg);
  if (cfg.dryRun) {
    console.log(JSON.stringify({ ...opts, system: publicSystem(opts.system) }, null, 2));
    return;
  }
  console.error(`${opts.role}: ${opts.system.provider} / ${opts.system.model} (${opts.system.kind}) → ${opts.datasetName} / ${opts.tag}${opts.defense !== 'none' ? ` [defense: ${opts.defense}]` : ''}`);
  const { doc, path: p } = await predict({ ...opts, log: (m) => console.error(m) });
  console.log(`Wrote ${p}`);
  console.log(JSON.stringify({ n: doc.count, errors: doc.errors, ...doc.summary }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
