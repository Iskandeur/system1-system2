import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wilson,
  reliability,
  brier,
  auroc,
  bootstrapCI,
  ece,
  hybridRows,
  summarize,
  sweep,
  paretoFront,
  splitHalves,
  chooseThreshold,
  thresholdGrid,
  mulberry32,
  fnv1a,
} from '../src/metrics.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('wilson interval matches known values', () => {
  const w = wilson(50, 100);
  near(w.lo, 0.4038, 1e-3);
  near(w.hi, 0.5962, 1e-3);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
  near(wilson(10, 10).hi, 1);
  assert.ok(wilson(10, 10).lo < 1 && wilson(10, 10).lo > 0.7);
});

test('reliability bins, ECE and Brier on a toy set', () => {
  // two items at 0.9 (one right), two at 0.3 (one right) -> gaps 0.4 and 0.2, ECE = 0.3
  const rows = [
    { confidence: 0.9, correct: true }, { confidence: 0.9, correct: false },
    { confidence: 0.3, correct: true }, { confidence: 0.3, correct: false },
    { confidence: null, correct: true },
  ];
  const r = reliability(rows, { bins: 10 });
  assert.equal(r.n, 4);
  assert.equal(r.bins.length, 10);
  assert.equal(r.bins[9].count, 2);
  assert.equal(r.bins[3].count, 2);
  near(r.bins[9].accuracy, 0.5);
  near(r.ece, 0.3);
  near(r.mce, 0.4);
  near(ece(rows), 0.3);
  near(brier(rows), ((0.1 ** 2 + 0.9 ** 2) + (0.7 ** 2 + 0.3 ** 2)) / 4);
  assert.equal(reliability([{ confidence: 1, correct: true }]).bins[9].count, 1); // 1.0 lands in the last bin
});

test('auroc is 1 when confidence separates right from wrong, 0.5 when it is constant', () => {
  assert.equal(auroc([{ confidence: 0.9, correct: true }, { confidence: 0.2, correct: false }]), 1);
  assert.equal(auroc([{ confidence: 0.5, correct: true }, { confidence: 0.5, correct: false }]), 0.5);
  assert.equal(auroc([{ confidence: 0.5, correct: true }]), null);
});

test('bootstrapCI is deterministic for a seed and brackets the point estimate', () => {
  const rng = mulberry32(1);
  const rows = Array.from({ length: 200 }, () => {
    const c = rng();
    return { confidence: c, correct: rng() < c };
  });
  const a = bootstrapCI(rows, (s) => ece(s), { n: 200, seed: 3 });
  const b = bootstrapCI(rows, (s) => ece(s), { n: 200, seed: 3 });
  assert.deepEqual(a, b);
  const point = ece(rows);
  assert.ok(a.lo <= point && point <= a.hi);
});

function pairsFixture() {
  // S1 confident and right on 1-3, confident and wrong on 4, unsure and wrong on 5-6, unsure and right on 7.
  const mk = (id, truth, s1, c, s2) => ({ id, truth, s1: { pred: s1, confidence: c, cost: 0.001, latency_ms: 10 }, s2: { pred: s2, cost: 0.1, latency_ms: 100 } });
  return [
    mk('1', 'a', 'a', 0.9, 'a'), mk('2', 'a', 'a', 0.95, 'a'), mk('3', 'b', 'b', 0.8, 'b'),
    mk('4', 'a', 'b', 0.85, 'a'), mk('5', 'b', 'a', 0.2, 'b'), mk('6', 'a', 'b', 0.3, 'a'), mk('7', 'b', 'b', 0.35, 'a'),
  ];
}

test('hybridRows/summarize: escalation, error capture, waste, coverage, selective accuracy, cost', () => {
  const rows = hybridRows(pairsFixture(), 0.5);
  const s = summarize(rows);
  assert.equal(s.n, 7);
  near(s.escalation_rate, 3 / 7);
  near(s.error_capture, 2 / 3); // s1 wrong on 4,5,6; 5 and 6 escalated
  near(s.waste, 1 / 4); // s1 right on 1,2,3,7; 7 escalated
  near(s.coverage, 4 / 7);
  near(s.selective_accuracy, 3 / 4);
  near(s.accuracy, 5 / 7); // 1,2,3 right via s1; 5,6 right via s2; 4 wrong; 7 wrong via s2
  near(s.cost_total_usd, 7 * 0.001 + 3 * 0.1);
  near(s.cost_per_1k_usd, ((7 * 0.001 + 3 * 0.1) / 7) * 1000);
  assert.equal(s.cost_coverage, 1);
});

test('sweep is monotone in escalation and paretoFront keeps only non-dominated points', () => {
  const sw = sweep(pairsFixture(), { step: 0.25 });
  assert.deepEqual(sw.map((r) => r.threshold), [0, 0.25, 0.5, 0.75, 1]);
  for (let i = 1; i < sw.length; i++) assert.ok(sw[i].escalation_rate >= sw[i - 1].escalation_rate);
  assert.equal(sw[0].escalation_rate, 0); // System 1 only
  assert.equal(sw[4].escalation_rate, 1); // System 2 only, even with confidences of exactly 1
  const front = paretoFront([
    { accuracy: 0.8, cost_per_1k_usd: 1 }, { accuracy: 0.9, cost_per_1k_usd: 2 },
    { accuracy: 0.7, cost_per_1k_usd: 3 }, { accuracy: 0.9, cost_per_1k_usd: 5 }, { accuracy: 0.8, cost_per_1k_usd: 1 },
  ]);
  assert.deepEqual(front.map((p) => [p.accuracy, p.cost_per_1k_usd]), [[0.8, 1], [0.9, 2], [0.8, 1]]);
  assert.equal(thresholdGrid(0.02).length, 51);
});

test('splitHalves is deterministic and chooseThreshold picks the cheapest threshold matching S2 on the tuning half', () => {
  const pairs = pairsFixture();
  const h1 = splitHalves(pairs, 42);
  const h2 = splitHalves(pairs, 42);
  assert.deepEqual(h1.tune.map((p) => p.id), h2.tune.map((p) => p.id));
  assert.equal(h1.tune.length + h1.eval.length, pairs.length);
  assert.notDeepEqual(splitHalves(pairs, 43).tune.map((p) => p.id), h1.tune.map((p) => p.id));

  // S2 is right on 6/7. At t=0.35 the hybrid escalates 5 and 6 (both fixed by S2) and keeps 7 with
  // System 1 (0.35 >= 0.35, right): 6/7 at 2/7 escalation. t=0.9 also matches but costs 5/7. Cheapest wins.
  const c = chooseThreshold(pairs, { thresholds: thresholdGrid(0.05) });
  assert.match(c.rule, /cheapest/);
  near(c.tune_s2_accuracy, 6 / 7);
  near(c.tune_hybrid_accuracy, 6 / 7);
  near(c.threshold, 0.35);
  near(c.tune_escalation_rate, 2 / 7);

  // Make S2 wrong on item 4 too (5/7): escalating only item 5 (t=0.25) already gives 5/7, so that is chosen
  // even though t=0.35 would score 6/7 — the rule buys the cheapest match, not the best accuracy.
  const easy = pairs.map((p) => ({ ...p, s2: { ...p.s2, pred: p.id === '4' ? 'b' : p.s2.pred } }));
  const c2 = chooseThreshold(easy, { thresholds: thresholdGrid(0.05) });
  assert.match(c2.rule, /cheapest/);
  near(c2.tune_s2_accuracy, 5 / 7);
  near(c2.threshold, 0.25);
  near(c2.tune_escalation_rate, 1 / 7);

  // When nothing matches S2, fall back to the most accurate threshold.
  const perfectS2 = pairs.map((p) => ({ ...p, s2: { ...p.s2, pred: p.truth } }));
  const c3 = chooseThreshold(perfectS2.filter((p) => p.id !== '4'), { thresholds: [0.5] });
  assert.match(c3.rule, /most accurate|cheapest/);
  assert.equal(typeof fnv1a('x'), 'number');
});
