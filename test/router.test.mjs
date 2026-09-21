import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickHybrid } from '../src/router.mjs';
import { stratifiedSubset, classificationPrompt } from '../src/task.mjs';
import { labelSpanConfidence, extractJsonObject, normalizeSelfReported } from '../src/confidence.mjs';
import { upsertManifest, publicResults } from '../scripts/build-docs-assets.mjs';

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
  // Observed from meta-llama/llama-3.1-8b-instruct on OpenRouter (json_object mode): the tokens
  // for `label`, the opening quote and `confidence` are missing from logprobs.content.
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
  // The label must be a standalone value: "debug" must not match "bug".
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

test('stratifiedSubset spreads --limit across labels and keeps order within a label', () => {
  const items = [
    { id: 1, truth: 'bug' }, { id: 2, truth: 'bug' }, { id: 3, truth: 'bug' },
    { id: 4, truth: 'feature' }, { id: 5, truth: 'feature' },
    { id: 6, truth: 'docs' },
  ];
  assert.deepEqual(stratifiedSubset(items, 4).map((i) => i.id), [1, 4, 6, 2]);
  assert.deepEqual(stratifiedSubset(items, 6).map((i) => i.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stratifiedSubset(items, 100).map((i) => i.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stratifiedSubset(items, null).length, 6);
});

test('the System 2 prompt is unchanged from the original demo', () => {
  assert.equal(
    classificationPrompt({ text: 'T' }),
    'Classify this GitHub issue into one label.\nReturn ONLY strict JSON with {"label": "bug"|"feature"|"docs"}.\n\nT',
  );
});

test('docs manifest upsert replaces same-tag entries and publicResults drops raw/items', () => {
  const m1 = upsertManifest({ runs: [] }, { tag: 'a', generated_at: '2026-01-02' });
  const m2 = upsertManifest(m1, { tag: 'b', generated_at: '2026-01-01' });
  const m3 = upsertManifest(m2, { tag: 'a', generated_at: '2026-01-03' });
  assert.deepEqual(m3.runs.map((r) => r.tag), ['b', 'a']);

  const pub = publicResults({ generated_at: 'x', dataset: {}, models: {}, threshold: 0.4, summary: {}, items: { big: 1 }, raw: [1] });
  assert.equal(pub.items, undefined);
  assert.equal(pub.raw, undefined);
  assert.equal(pub.tag, null);
});
