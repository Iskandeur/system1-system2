import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keepsSystem1, scoreItem, strategies, pickWinner, totalCost1k, sweep, verdict, estimateLiveCost } from '../docs/assets/strategies.mjs';

const item = (truth, s1pred, conf, s2pred) => ({
  truth,
  s1: { pred: s1pred, conf, cost: 0.00003, ms: 300 },
  s2: { pred: s2pred, cost: 0.0015, ms: 2500 },
});

test('keepsSystem1 mirrors the router: t=0 keeps every known confidence, t=1 escalates all, null escalates', () => {
  assert.equal(keepsSystem1(0.5, 0.5), true);
  assert.equal(keepsSystem1(0.49, 0.5), false);
  assert.equal(keepsSystem1(0, 0), true);
  assert.equal(keepsSystem1(1, 1), false);
  assert.equal(keepsSystem1(null, 0), false);
  assert.equal(keepsSystem1(0.9, 1.7), false);
});

test('scoreItem: hybrid takes System 1 when kept, System 2 when escalated, and adds the costs', () => {
  const a = scoreItem(item('x', 'x', 0.9, 'y'), 0.5);
  assert.deepEqual([a.escalated, a.hybridPred, a.hybridOk, a.hybridCost, a.hybridMs], [false, 'x', true, 0.00003, 300]);
  const b = scoreItem(item('x', 'y', 0.2, 'x'), 0.5);
  assert.deepEqual([b.escalated, b.hybridPred, b.hybridOk], [true, 'x', true]);
  assert.ok(Math.abs(b.hybridCost - 0.00153) < 1e-12);
  assert.equal(b.hybridMs, 2800);
});

const ITEMS = [
  item('a', 'a', 1.0, 'a'), // both right, kept
  item('a', 'b', 0.3, 'a'), // s1 wrong with low confidence: hybrid fixes it
  item('a', 'b', 0.95, 'a'), // s1 wrong but confident: hybrid keeps the error
  item('a', 'a', 0.6, 'b'), // s1 right, s2 wrong
];

test('strategies: the three accuracies, escalation rate and per-1k costs', () => {
  const s = strategies(ITEMS, 0.5);
  assert.equal(s.s1.accuracy, 0.5);
  assert.equal(s.s2.accuracy, 0.75);
  assert.equal(s.hybrid.accuracy, 0.75);
  assert.equal(s.hybrid.escalated, 1);
  assert.equal(s.hybrid.escalationRate, 0.25);
  assert.ok(Math.abs(s.s1.cost1k - 0.03) < 1e-9);
  assert.ok(Math.abs(s.s2.cost1k - 1.5) < 1e-9);
  assert.ok(Math.abs(s.hybrid.cost1k - (0.03 + 1.5 / 4)) < 1e-9);
  assert.equal(s.s1.ms, 300);
  assert.equal(s.hybrid.ms, 300 + 2500 / 4);
  // the ends of the slider are the pure strategies
  assert.equal(strategies(ITEMS, 0).hybrid.accuracy, s.s1.accuracy);
  assert.equal(strategies(ITEMS, 1).hybrid.accuracy, s.s2.accuracy);
  assert.equal(strategies(ITEMS, 1).hybrid.escalationRate, 1);
});

test('strategies: items without a known right answer count for cost and speed, not for accuracy', () => {
  const s = strategies([...ITEMS, { truth: null, s1: { pred: 'a', conf: 0.1, cost: 0.00003, ms: 300 }, s2: { pred: 'b', cost: 0.0015, ms: 2500 } }], 0.5);
  assert.equal(s.s1.n, 5);
  assert.equal(s.s1.labelled, 4);
  assert.equal(s.s1.accuracy, 0.5);
  assert.equal(s.hybrid.escalated, 2);
  assert.ok(Math.abs(s.hybrid.cost1k - ((0.00003 * 5 + 0.0015 * 2) / 5) * 1000) < 1e-9);
});

test('pickWinner: pure API cost favours System 1; pricing mistakes flips it to the hybrid', () => {
  const s = strategies(ITEMS, 0.5);
  assert.equal(pickWinner(s, 0).key, 's1');
  // one wrong answer costs $0.10: s1 has 500 errors/1k => $50; hybrid 250 => $25 + $0.4
  assert.equal(pickWinner(s, 0.1).key, 'hybrid');
  assert.ok(Math.abs(totalCost1k(s.s1, 0.1) - (0.03 + 50)) < 1e-9);
  // hybrid and s2 are equally accurate here, so the hybrid wins on API cost at any mistake price
  assert.equal(pickWinner(s, 100).key, 'hybrid');
});

test('sweep returns steps+1 rows from t=0 to t=1 with monotone escalation', () => {
  const rows = sweep(ITEMS, 10);
  assert.equal(rows.length, 11);
  assert.equal(rows[0].threshold, 0);
  assert.equal(rows[10].threshold, 1);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].escalationRate >= rows[i - 1].escalationRate);
});

test('verdict names the winner in plain words', () => {
  const s = strategies(ITEMS, 0.5);
  assert.match(verdict(s, 0), /^On this task Jev alone wins/);
  assert.match(verdict(s, 0.1), /^On this task the hybrid wins/);
  const s2only = strategies([item('a', 'b', 1.0, 'a'), item('a', 'b', 1.0, 'a')], 0.5);
  assert.match(verdict(s2only, 0.1, { s1: 'Jev', s2: 'GPT' }), /^On this task GPT alone wins/);
});

test('estimateLiveCost scales with items and prices', () => {
  const e = estimateLiveCost({ n: 10, avgChars: 80, labels: 2, llmInputPerM: 1, llmOutputPerM: 10 });
  assert.ok(e.jev > 0 && e.llm > 0 && Math.abs(e.total - e.jev - e.llm) < 1e-12);
  assert.ok(estimateLiveCost({ n: 20, avgChars: 80, llmInputPerM: 1, llmOutputPerM: 10 }).llm > e.llm);
});
