import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDataset } from '../src/dataset.mjs';
import { summarize, reliability, auroc, bootstrapCI, ece, roundDeep } from '../src/metrics.mjs';
import { inProject } from './paths.mjs';
import { loadPredictions, listPredictionTags } from './analyze.mjs';

// Open-weight System 1 models, run locally on CPU, against the hosted ones on the SAME stratified
// subset of MASSIVE (same ids in English and French; see scripts/build-openweights-subset.mjs).
// The hosted predictions are slices of the full 600-item runs (scripts/slice-predictions.mjs), so
// every system below answered exactly the same items.
//
//   node scripts/analyze-openweights.mjs
//   -> docs/assets/results/openweights.json

const DATASETS = { en: 'massive-en-openweights', fr: 'massive-fr-openweights' };

// Where each tag ran. Latency is only comparable within a group.
const WHERE = {
  jev: 'hosted API',
  'gpt-5.2': 'hosted API',
  laya: 'local CPU',
  'laya-multilingual': 'local CPU',
  // Same weights, re-run on 2026-09-25 with laya 0.3.20: first with the default option budget (the
  // runtime alone changed), then with the budget raised so the 18 criteria are read whole.
  'laya-0320': 'local CPU',
  'laya-hm512': 'local CPU',
  'laya-multilingual-hm512': 'local CPU',
  kev: 'local CPU',
};

// Rows that share a model id with another row say what differs. The English checkpoint ships a 0.10
// temperature for choices with 11+ options: laya 0.3.4 applied it (probabilities sharpened tenfold),
// 0.3.5+ clamps it to 0.5. The multilingual checkpoint ships none, so its runtime does not matter here.
const VARIANT = {
  laya: 'laya 0.3.4, shipped 0.10 temperature',
  'laya-0320': 'laya 0.3.20, temperature clamped to 0.5',
  'laya-hm512': 'laya 0.3.20, option descriptions read whole',
  'laya-multilingual-hm512': 'option descriptions read whole',
};

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

export function systemBlock(pred) {
  const rows = pred.items;
  const s = summarize(rows.map((r) => ({ truth: r.truth, pred: r.pred, cost: r.cost, latency_ms: r.latency_ms })));
  const lat = rows.map((r) => r.latency_ms || 0).sort((a, b) => a - b);
  const conf = rows.map((r) => ({ confidence: r.confidence, correct: r.pred === r.truth }));
  const hasConf = conf.some((r) => typeof r.confidence === 'number');
  const out = {
    tag: pred.tag,
    model: pred.system?.model ?? pred.tag,
    role: pred.role,
    where: WHERE[pred.tag] ?? 'unknown',
    n: s.n,
    correct: s.correct,
    accuracy: s.accuracy,
    accuracy_ci: s.accuracy_ci,
    errors: rows.filter((r) => r.error).length,
    cost_per_1k_usd: s.cost_per_1k_usd,
    latency_ms: { mean: s.mean_latency_ms, median: quantile(lat, 0.5), p90: quantile(lat, 0.9), max: lat[lat.length - 1] ?? null },
  };
  if (hasConf && pred.role === 'system1') {
    const rel = reliability(conf);
    out.calibration = {
      n: rel.n,
      ece: rel.ece,
      ece_ci: bootstrapCI(conf, (x) => ece(x)),
      auroc: auroc(conf),
      mean_confidence: rel.mean_confidence,
    };
  }
  return out;
}

function main() {
  const out = { generated_at: new Date().toISOString(), kind: 'openweights', languages: {}, systems: {} };
  for (const [lang, name] of Object.entries(DATASETS)) {
    const ds = loadDataset(name);
    out.languages[lang] = { dataset: name, count: ds.items.length, source: ds.source ?? null };
    for (const tag of listPredictionTags(name)) {
      const pred = loadPredictions(name, tag);
      out.systems[tag] ??= { tag, where: WHERE[tag] ?? 'unknown', ...(VARIANT[tag] ? { variant: VARIANT[tag] } : {}) };
      out.systems[tag][lang] = systemBlock(pred);
      out.systems[tag].model ??= out.systems[tag][lang].model;
    }
  }
  // EN/FR gap on identical ids, for systems that ran both.
  for (const s of Object.values(out.systems)) {
    if (s.en && s.fr) s.gap_fr_minus_en = s.fr.accuracy - s.en.accuracy;
  }
  // Paired comparison with Jev (same items): how many items one gets right and the other wrong.
  for (const lang of Object.keys(DATASETS)) {
    const name = DATASETS[lang];
    if (!out.systems.jev?.[lang]) continue;
    const jev = new Map(loadPredictions(name, 'jev').items.map((r) => [String(r.id), r.pred === r.truth]));
    for (const [tag, s] of Object.entries(out.systems)) {
      if (tag === 'jev' || !s[lang]) continue;
      let onlyThis = 0, onlyJev = 0;
      for (const r of loadPredictions(name, tag).items) {
        const a = r.pred === r.truth, b = jev.get(String(r.id));
        if (a && !b) onlyThis++;
        if (b && !a) onlyJev++;
      }
      s[lang].vs_jev = { only_this_correct: onlyThis, only_jev_correct: onlyJev };
    }
  }
  const file = inProject('docs/assets/results/openweights.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roundDeep(out), null, 1) + '\n');
  for (const s of Object.values(out.systems)) {
    const f = (b) => (b ? `${(b.accuracy * 100).toFixed(1)}% (n=${b.n}, median ${Math.round(b.latency_ms.median)} ms${b.calibration ? `, ECE ${(b.calibration.ece * 100).toFixed(1)}%` : ''})` : '–');
    console.log(`${s.tag.padEnd(18)} ${s.where.padEnd(10)} EN ${f(s.en)}  FR ${f(s.fr)}`);
  }
  console.log('Wrote', file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
