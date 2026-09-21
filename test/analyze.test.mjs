import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hybridReport, systemReport, joinPairs } from '../scripts/analyze.mjs';
import { mulberry32 } from '../src/metrics.mjs';
import { allocate, sampleIds, tarEntries } from '../scripts/build-massive.mjs';

function fakePredictions({ tag, role, n = 200, seed = 1, s1 = false }) {
  const rng = mulberry32(seed);
  const items = [];
  for (let i = 0; i < n; i++) {
    const truth = rng() < 0.5 ? 'a' : 'b';
    const conf = s1 ? rng() : null;
    const right = s1 ? rng() < conf : rng() < 0.9;
    items.push({ id: String(i), truth, pred: right ? truth : truth === 'a' ? 'b' : 'a', confidence: conf, confidence_source: s1 ? 'model' : null, cost: s1 ? 0.00001 : 0.001, latency_ms: s1 ? 50 : 900 });
  }
  return { tag, role, defense: 'none', system: { model: tag, provider: 'x', kind: 'chat' }, items, errors: 0, generated_at: 'now' };
}

test('systemReport carries accuracy with CI and, for System 1, calibration with a bootstrap CI', () => {
  const s1 = systemReport(fakePredictions({ tag: 's1', role: 'system1', s1: true }), { withCalibration: true });
  assert.equal(s1.n, 200);
  assert.ok(s1.accuracy_ci.lo < s1.accuracy && s1.accuracy < s1.accuracy_ci.hi);
  assert.equal(s1.calibration.bins.length, 10);
  assert.ok(s1.calibration.ece_ci.lo <= s1.calibration.ece && s1.calibration.ece <= s1.calibration.ece_ci.hi);
  assert.ok(s1.calibration.auroc > 0.6); // confidence is informative by construction
  const s2 = systemReport(fakePredictions({ tag: 's2', role: 'system2' }), { withCalibration: false });
  assert.equal(s2.calibration, undefined);
  assert.ok(Math.abs(s2.cost_per_1k_usd - 1) < 1e-9);
});

test('hybridReport joins on id, sweeps thresholds, picks the threshold on the tuning half only', () => {
  const s1 = fakePredictions({ tag: 's1', role: 'system1', s1: true });
  const s2 = fakePredictions({ tag: 's2', role: 'system2', seed: 2 });
  s2.items = s2.items.slice(0, 150); // only 150 items in common
  assert.equal(joinPairs(s1, s2).length, 150);
  const h = hybridReport(s1, s2, { step: 0.1, seed: 42 });
  assert.equal(h.n, 150);
  assert.equal(h.sweep.length, 11);
  assert.equal(h.heldout.n + h.heldout.tune_n, 150);
  assert.ok(h.heldout.threshold >= 0 && h.heldout.threshold <= 1);
  assert.equal(h.heldout.hybrid.n, h.heldout.n);
  assert.ok(h.pareto.length >= 1);
  assert.ok(h.agreement.disagreements <= 150);
  // the sweep at t=0 never escalates and equals S1 only; at t=1 it always escalates and equals S2 only
  assert.equal(h.sweep[0].escalation_rate, 0);
  assert.equal(h.sweep[0].accuracy, h.system1_only.accuracy);
  assert.equal(h.sweep[10].escalation_rate, 1);
  assert.equal(h.sweep[10].accuracy, h.system2_only.accuracy);
});

test('MASSIVE sampling: proportional allocation with largest remainders, deterministic ids, tar reader', () => {
  assert.deepEqual(allocate({ a: 50, b: 30, c: 20 }, 10), { a: 5, b: 3, c: 2 });
  const alloc = allocate({ a: 1, b: 1, c: 1 }, 10);
  assert.equal(alloc.a + alloc.b + alloc.c, 10);
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ id: String(i), partition: i % 3 ? 'test' : 'train', scenario: i % 2 ? 'alarm' : 'weather' });
  const a = sampleIds(rows, 20, 42);
  const b = sampleIds(rows, 20, 42);
  assert.deepEqual(a.ids, b.ids);
  assert.equal(a.ids.length, 20);
  assert.equal(a.test_size, 200);
  assert.ok(a.ids.every((id) => Number(id) % 3 !== 0));

  // a two-file ustar archive built by hand
  const header = (name, size) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0', 257);
    return h;
  };
  const f1 = Buffer.from('hello');
  const f2 = Buffer.from('{"id":"1"}\n');
  const pad = (b) => Buffer.concat([b, Buffer.alloc(512 - (b.length % 512 || 512))]);
  const tar = Buffer.concat([header('dir/a.txt', f1.length), pad(f1), header('dir/en-US.jsonl', f2.length), pad(f2), Buffer.alloc(1024)]);
  const entries = [...tarEntries(tar)];
  assert.deepEqual(entries.map((e) => [e.name, e.data.toString()]), [['dir/a.txt', 'hello'], ['dir/en-US.jsonl', '{"id":"1"}\n']]);
});
