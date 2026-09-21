import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/config.mjs';
import { loadDataset } from '../src/dataset.mjs';
import {
  summarize,
  reliability,
  brier,
  auroc,
  bootstrapCI,
  ece,
  hybridRows,
  sweep,
  paretoFront,
  splitHalves,
  chooseThreshold,
  roundDeep,
  thresholdGrid,
} from '../src/metrics.mjs';
import { inProject } from './paths.mjs';
import { predictionsPath } from './predict.mjs';

// Joins System 1 and System 2 predictions on one dataset and computes everything the README and
// the results page show: accuracies with Wilson CIs, calibration (reliability bins, ECE with a
// bootstrap CI, Brier, AUROC), the threshold sweep, the Pareto front, and a held-out operating
// point (threshold chosen on one half of the items, reported on the other half).
//
//   node scripts/analyze.mjs --dataset massive-en [--s1 jev] [--s2 gpt-5.2 --s2 gpt-5-mini]
//   -> docs/assets/results/massive-en.json

export function loadPredictions(datasetName, tag) {
  const p = predictionsPath(datasetName, tag);
  if (!fs.existsSync(p)) throw new Error(`Missing predictions ${p}. Run scripts/predict.mjs first.`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Tags of the COMPLETE prediction files of a dataset. A file still being written (complete: false)
// is skipped with a warning, so a partial run can never leak into published results.
export function listPredictionTags(datasetName) {
  const dir = inProject('data/predictions', datasetName);
  if (!fs.existsSync(dir)) return [];
  const tags = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  return tags.filter((t) => {
    const p = JSON.parse(fs.readFileSync(path.join(dir, `${t}.json`), 'utf8'));
    if (p.complete === false) console.error(`skip ${datasetName}/${t}: run not complete (${p.count} items)`);
    return p.complete !== false;
  });
}

function correctnessRows(pred) {
  return pred.items.map((r) => ({ confidence: r.confidence, correct: r.pred === r.truth }));
}

export function systemReport(pred, { withCalibration }) {
  const rows = pred.items.map((r) => ({ truth: r.truth, pred: r.pred, cost: r.cost, latency_ms: r.latency_ms }));
  const out = {
    tag: pred.tag,
    role: pred.role,
    defense: pred.defense ?? 'none',
    model: pred.system.model,
    provider: pred.system.provider,
    kind: pred.system.kind,
    pricing: pred.system.pricing ?? null,
    cost_sources: [...new Set(pred.items.map((r) => r.cost_source).filter(Boolean))],
    errors: pred.errors ?? 0,
    generated_at: pred.generated_at,
    ...summarize(rows),
  };
  if (withCalibration) {
    const c = correctnessRows(pred);
    const rel = reliability(c);
    out.confidence_sources = [...new Set(pred.items.map((r) => r.confidence_source).filter(Boolean))];
    out.calibration = {
      n: rel.n,
      bins: rel.bins,
      ece: rel.ece,
      ece_ci: bootstrapCI(c, (s) => ece(s)),
      mce: rel.mce,
      brier: brier(c),
      auroc: auroc(c),
      mean_confidence: rel.mean_confidence,
      histogram: rel.bins.map((b) => b.count),
    };
  }
  return out;
}

export function joinPairs(s1, s2) {
  const byId = new Map(s2.items.map((r) => [String(r.id), r]));
  const pairs = [];
  for (const a of s1.items) {
    const b = byId.get(String(a.id));
    if (!b) continue;
    pairs.push({
      id: a.id,
      truth: a.truth,
      s1: { pred: a.pred, confidence: a.confidence, cost: a.cost, latency_ms: a.latency_ms },
      s2: { pred: b.pred, cost: b.cost, latency_ms: b.latency_ms },
    });
  }
  return pairs;
}

export function hybridReport(s1, s2, { step = 0.02, seed = 42 } = {}) {
  const pairs = joinPairs(s1, s2);
  if (!pairs.length) throw new Error(`No common items between ${s1.tag} and ${s2.tag}`);
  const grid = thresholdGrid(step);
  const sw = sweep(pairs, { thresholds: grid });
  const s1Only = summarize(pairs.map((p) => ({ truth: p.truth, pred: p.s1.pred, cost: p.s1.cost, latency_ms: p.s1.latency_ms })));
  const s2Only = summarize(pairs.map((p) => ({ truth: p.truth, pred: p.s2.pred, cost: p.s2.cost, latency_ms: p.s2.latency_ms })));
  const front = paretoFront([
    ...sw.map((s) => ({ ...s, kind: 'hybrid' })),
    { ...s1Only, threshold: null, kind: 'system1_only' },
    { ...s2Only, threshold: null, kind: 'system2_only' },
  ]).map((p) => ({ kind: p.kind, threshold: p.threshold, accuracy: p.accuracy, cost_per_1k_usd: p.cost_per_1k_usd }));

  const halves = splitHalves(pairs, seed);
  const evalPairs = halves.eval;
  const heldoutFor = (rule) => {
    const chosen = chooseThreshold(halves.tune, { thresholds: grid, rule });
    return {
      n: evalPairs.length,
      tune_n: halves.tune.length,
      threshold: chosen.threshold,
      rule: chosen.rule,
      system1_only: summarize(evalPairs.map((p) => ({ truth: p.truth, pred: p.s1.pred, cost: p.s1.cost, latency_ms: p.s1.latency_ms }))),
      system2_only: summarize(evalPairs.map((p) => ({ truth: p.truth, pred: p.s2.pred, cost: p.s2.cost, latency_ms: p.s2.latency_ms }))),
      hybrid: summarize(hybridRows(evalPairs, chosen.threshold)),
      tune: { system2_accuracy: chosen.tune_s2_accuracy, hybrid_accuracy: chosen.tune_hybrid_accuracy, escalation_rate: chosen.tune_escalation_rate },
    };
  };
  const heldout = heldoutFor('match');
  const heldoutBest = heldoutFor('best');

  // Agreement between the two systems, and who is right when they disagree.
  const disagree = pairs.filter((p) => p.s1.pred !== p.s2.pred);
  const agreement = {
    rate: pairs.length ? 1 - disagree.length / pairs.length : 0,
    disagreements: disagree.length,
    s1_right_when_disagree: disagree.filter((p) => p.s1.pred === p.truth).length,
    s2_right_when_disagree: disagree.filter((p) => p.s2.pred === p.truth).length,
    both_wrong_when_disagree: disagree.filter((p) => p.s1.pred !== p.truth && p.s2.pred !== p.truth).length,
  };

  return {
    s1: s1.tag,
    s2: s2.tag,
    n: pairs.length,
    system1_only: s1Only,
    system2_only: s2Only,
    heldout,
    heldout_best: heldoutBest,
    agreement,
    sweep: sw,
    pareto: front,
  };
}

// Items on which every system gives the same answer and that answer is not the label: an estimate
// of how much of the residual error belongs to the label rather than to the models.
export function consensusAgainstLabel(preds) {
  const maps = preds.map((p) => new Map(p.items.filter((r) => r.pred).map((r) => [String(r.id), r])));
  const ids = [...maps[0].keys()].filter((id) => maps.every((m) => m.has(id)));
  let against = 0;
  let allRight = 0;
  const pairs = {};
  for (const id of ids) {
    const rs = maps.map((m) => m.get(id));
    const truth = rs[0].truth;
    if (rs.every((r) => r.pred === truth)) allRight++;
    else if (rs.every((r) => r.pred === rs[0].pred)) {
      against++;
      const k = `${truth} -> ${rs[0].pred}`;
      pairs[k] = (pairs[k] || 0) + 1;
    }
  }
  return {
    systems: preds.map((p) => p.tag),
    n: ids.length,
    all_right: allRight,
    all_agree_against_label: against,
    rate_against_label: ids.length ? against / ids.length : null,
    top_confusions: Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ pair: k, count: v })),
  };
}

export function analyze({ datasetName, s1Tags, s2Tags, step = 0.02, seed = 42 }) {
  const dataset = loadDataset(datasetName);
  const all = listPredictionTags(dataset.name).map((t) => loadPredictions(dataset.name, t));
  const s1s = (s1Tags?.length ? s1Tags.map((t) => loadPredictions(dataset.name, t)) : all.filter((p) => p.role === 'system1')).filter((p) => (p.defense ?? 'none') === 'none');
  const s2s = (s2Tags?.length ? s2Tags.map((t) => loadPredictions(dataset.name, t)) : all.filter((p) => p.role === 'system2')).filter((p) => (p.defense ?? 'none') === 'none');
  if (!s1s.length) throw new Error(`No System 1 predictions for ${dataset.name}`);
  if (!s2s.length) throw new Error(`No System 2 predictions for ${dataset.name}`);

  const systems = {};
  for (const p of s1s) systems[p.tag] = systemReport(p, { withCalibration: true });
  for (const p of s2s) systems[p.tag] = systemReport(p, { withCalibration: false });

  const hybrids = [];
  for (const a of s1s) for (const b of s2s) hybrids.push(hybridReport(a, b, { step, seed }));

  return roundDeep({
    generated_at: new Date().toISOString(),
    dataset: {
      name: dataset.name,
      count: dataset.items.length,
      task: dataset.task.name,
      labels: dataset.task.labels,
      source: dataset.source ?? null,
    },
    method: {
      accuracy_ci: 'Wilson score interval, 95%',
      ece: '10 equal-width bins; CI = percentile bootstrap, 1000 resamples, seed 42',
      heldout: `items split in two halves by a hash of their id (seed ${seed}); the threshold is chosen on the tuning half and every held-out number is computed on the other half`,
      sweep_step: step,
    },
    s1: s1s.map((p) => p.tag),
    s2: s2s.map((p) => p.tag),
    systems,
    hybrids,
    consensus: consensusAgainstLabel([...s1s, ...s2s]),
  });
}

export function resultsPath(datasetName) {
  return inProject('docs/assets/results', `${datasetName}.json`);
}

function asList(v) {
  if (v === undefined || v === true) return [];
  return [].concat(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const datasetName = flags.dataset && flags.dataset !== true ? String(flags.dataset) : 'massive-en';
  const doc = analyze({ datasetName, s1Tags: asList(flags.s1), s2Tags: asList(flags.s2) });
  const out = flags.out && flags.out !== true ? path.resolve(String(flags.out)) : resultsPath(doc.dataset.name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
  console.log('Wrote', out);
  for (const [tag, s] of Object.entries(doc.systems)) {
    const cal = s.calibration ? `  ECE ${s.calibration.ece.toFixed(3)} [${s.calibration.ece_ci.lo.toFixed(3)}, ${s.calibration.ece_ci.hi.toFixed(3)}]  AUROC ${s.calibration.auroc?.toFixed(3)}` : '';
    console.log(`${s.role === 'system1' ? 'S1' : 'S2'} ${tag.padEnd(24)} acc ${(s.accuracy * 100).toFixed(1)}% [${(s.accuracy_ci.lo * 100).toFixed(1)}, ${(s.accuracy_ci.hi * 100).toFixed(1)}]  $${(s.cost_per_1k_usd ?? 0).toFixed(3)}/1k${cal}`);
  }
  for (const h of doc.hybrids) {
    for (const [name, e] of [['match', h.heldout], ['best', h.heldout_best]]) {
      console.log(
        `hybrid ${h.s1} + ${h.s2} [${name}] @ t=${e.threshold} (held-out n=${e.n}): acc ${(e.hybrid.accuracy * 100).toFixed(1)}% vs S2 ${(e.system2_only.accuracy * 100).toFixed(1)}% vs S1 ${(e.system1_only.accuracy * 100).toFixed(1)}%  escalation ${(e.hybrid.escalation_rate * 100).toFixed(1)}%  cost/1k $${e.hybrid.cost_per_1k_usd?.toFixed(3)} vs $${e.system2_only.cost_per_1k_usd?.toFixed(3)}`,
      );
    }
  }
  const c = doc.consensus;
  console.log(`all ${c.systems.length} systems agree against the label on ${c.all_agree_against_label}/${c.n} items (${(c.rate_against_label * 100).toFixed(1)}%)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
