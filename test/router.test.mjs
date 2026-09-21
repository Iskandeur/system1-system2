import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickHybrid } from '../src/router.mjs';
import { labelSpanConfidence, extractJsonObject, normalizeSelfReported } from '../src/confidence.mjs';

test('pickHybrid keeps System 1 at or above threshold, escalates below or when confidence is unknown', () => {
  const base = { s1Label: 'bug', s2Label: 'feature' };
  assert.deepEqual(pickHybrid({ ...base, s1Confidence: 0.4, threshold: 0.4 }), { label: 'bug', used: 'system1' });
  assert.deepEqual(pickHybrid({ ...base, s1Confidence: 0.39, threshold: 0.4 }), { label: 'feature', used: 'system2' });
  assert.deepEqual(pickHybrid({ ...base, s1Confidence: null, threshold: 0 }), { label: 'feature', used: 'system2' });
  assert.deepEqual(pickHybrid({ ...base, s1Confidence: 1, threshold: 1.7 }), { label: 'bug', used: 'system1' }); // clamped
});

test('labelSpanConfidence multiplies the probabilities of the tokens spelling the label', () => {
  const tokens = [
    { token: '{"label": "', logprob: -0.1 },
    { token: 'do', logprob: Math.log(0.5) },
    { token: 'cs', logprob: Math.log(0.5) },
    { token: '"}', logprob: -0.1 },
  ];
  assert.ok(Math.abs(labelSpanConfidence({ tokens, label: 'docs' }) - 0.25) < 1e-12);
  assert.equal(labelSpanConfidence({ tokens, label: 'bug' }), null); // span mismatch
  assert.equal(labelSpanConfidence({ tokens: [], label: 'docs' }), null);
  assert.equal(labelSpanConfidence({ tokens: null, label: 'docs' }), null);
});

test('labelSpanConfidence tolerates partial token lists (label key tokens omitted by the provider)', () => {
  const tokens = [
    { token: '{"', logprob: -0.0096 },
    { token: '":', logprob: -0.0003 },
    { token: 'bug', logprob: Math.log(0.7) },
    { token: '",', logprob: -0.0001 },
    { token: ' "', logprob: 0 },
    { token: '":', logprob: 0 },
    { token: ' ', logprob: 0 },
    { token: '0', logprob: -0.2148 },
    { token: '95', logprob: -0.8078 },
    { token: '}', logprob: 0 },
  ];
  assert.ok(Math.abs(labelSpanConfidence({ tokens, label: 'bug' }) - 0.7) < 1e-12);
  assert.equal(labelSpanConfidence({ tokens: [{ token: '{"x":"de', logprob: 0 }, { token: 'bug"}', logprob: 0 }], label: 'bug' }), null);
});

test('extractJsonObject and normalizeSelfReported are lenient but bounded', () => {
  assert.deepEqual(extractJsonObject(' {"label":"bug"} '), { label: 'bug' });
  assert.deepEqual(extractJsonObject('```json\n{"label":"bug"}\n```'), { label: 'bug' });
  assert.deepEqual(extractJsonObject('Answer: {"label":"bug"} thanks'), { label: 'bug' });
  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(normalizeSelfReported(0.7), 0.7);
  assert.equal(normalizeSelfReported(85), 0.85); // percent tolerated
  assert.equal(normalizeSelfReported(1.4), 1);
  assert.equal(normalizeSelfReported('abc'), null);
});
