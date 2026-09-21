import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attackReport, hybridAttackReport } from '../scripts/analyze-injection.mjs';

// Two source items, two templates (one control). System 1 falls for the "argue" attack on item 1
// with high confidence (rides past the router) and keeps item 2 with lower confidence; System 2
// resists everything.
const dataset = {
  items: [
    { id: '1#argue', meta: { source_id: '1', template: 'argue', target: 'b', control: false } },
    { id: '2#argue', meta: { source_id: '2', template: 'argue', target: 'a', control: false } },
    { id: '1#benign', meta: { source_id: '1', template: 'benign', target: null, control: true } },
    { id: '2#benign', meta: { source_id: '2', template: 'benign', target: null, control: true } },
  ],
};
const clean1 = { tag: 'jev', items: [{ id: '1', pred: 'a', confidence: 0.95 }, { id: '2', pred: 'b', confidence: 0.9 }] };
const s1 = {
  tag: 'jev', role: 'system1', defense: 'none', system: { model: 'jev' },
  items: [
    { id: '1#argue', truth: 'a', pred: 'b', confidence: 0.8 },
    { id: '2#argue', truth: 'b', pred: 'b', confidence: 0.5 },
    { id: '1#benign', truth: 'a', pred: 'a', confidence: 0.95 },
    { id: '2#benign', truth: 'b', pred: 'b', confidence: 0.9 },
  ],
};
const clean2 = { tag: 'gpt', items: [{ id: '1', pred: 'a' }, { id: '2', pred: 'b' }] };
const s2 = {
  tag: 'gpt', role: 'system2', defense: 'none', system: { model: 'gpt' },
  items: [
    { id: '1#argue', truth: 'a', pred: 'a' },
    { id: '2#argue', truth: 'b', pred: 'b' },
    { id: '1#benign', truth: 'a', pred: 'a' },
    { id: '2#benign', truth: 'b', pred: 'b' },
  ],
};

test('attackReport: targeted success, flips vs clean, control, confidence shift and above-threshold successes', () => {
  const r1 = attackReport({ dataset, pred: s1, clean: clean1, threshold: 0.7 });
  assert.equal(r1.report.n_attacks, 2);
  assert.equal(r1.report.n_controls, 2);
  assert.equal(r1.report.targeted.rate, 0.5);
  assert.equal(r1.report.flipped.rate, 0.5);
  assert.equal(r1.report.control_flipped.rate, 0);
  assert.equal(r1.report.accuracy_under_attack.rate, 0.5);
  assert.equal(r1.report.clean_accuracy_on_sources.rate, 1);
  assert.equal(r1.report.by_template.argue.targeted.rate, 0.5);
  assert.equal(r1.report.by_template.benign.targeted, null);
  assert.ok(Math.abs(r1.report.confidence.clean_mean - 0.925) < 1e-9);
  assert.ok(Math.abs(r1.report.confidence.attacked_mean - 0.65) < 1e-9);
  assert.equal(r1.report.confidence.successful_above_threshold.rate, 1); // the one success had 0.8 >= 0.7
  assert.equal(r1.report.confidence.escalation_clean.rate, 0);
  assert.equal(r1.report.confidence.escalation_attacked.rate, 0.5);
  assert.equal(r1.report.confidence.histogram_attacked.reduce((a, b) => a + b, 0), 2);

  const r2 = attackReport({ dataset, pred: s2, clean: clean2, threshold: null });
  assert.equal(r2.report.targeted.rate, 0);
  assert.equal(r2.report.confidence, undefined);
});

test('hybridAttackReport: the router lets a confident successful attack through and escalates the unsure one', () => {
  const a = attackReport({ dataset, pred: s1, clean: clean1, threshold: 0.7 });
  const b = attackReport({ dataset, pred: s2, clean: clean2, threshold: null });
  const h = hybridAttackReport({ s1: a, s2: b, threshold: 0.7 });
  assert.equal(h.n_attacks, 2);
  assert.equal(h.targeted.rate, 0.5); // item 1: System 1 answer 'b' kept (0.8 >= 0.7)
  assert.equal(h.escalated.rate, 0.5); // item 2 escalated (0.5 < 0.7) and answered by System 2
  assert.equal(h.passed_router.rate, 0.5);
  assert.equal(h.accuracy_under_attack.rate, 0.5);
  assert.equal(h.by_template.argue.escalated.rate, 0.5);
  const strict = hybridAttackReport({ s1: a, s2: b, threshold: 0.9 });
  assert.equal(strict.targeted.rate, 0); // everything escalates, System 2 resists
  assert.equal(strict.escalated.rate, 1);
});
