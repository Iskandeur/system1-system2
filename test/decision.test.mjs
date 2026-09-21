import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSystem, DEFAULTS } from '../src/config.mjs';
import { buildDecisionRequest, parseDecisionResponse, createDecisionAdapter } from '../src/adapters/decision.mjs';
import { createAdapter } from '../src/adapters/index.mjs';

const jev = () => resolveSystem('system1', { layers: [DEFAULTS.system1] });

test('default Jev request is byte-compatible with the original demo (model/state/questions)', () => {
  const { url, body } = buildDecisionRequest({ system: jev(), text: 'Title: crash' });
  assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(Object.keys(body), ['model', 'state', 'questions']);
  assert.equal(body.model, 'typesafe/jev-1.13');
  assert.equal(body.state, 'Title: crash');
  assert.equal(body.questions.label.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.label.criteria), ['bug', 'feature', 'docs']);
});

test('response parsing reads answers.label.choice/confidence and usage.cost', () => {
  const json = { answers: { label: { choice: 'bug', confidence: 0.83 } }, usage: { cost: 0.00005 } };
  const r = parseDecisionResponse({ system: jev(), json });
  assert.deepEqual(
    { label: r.label, confidence: r.confidence, source: r.confidence_source, cost: r.cost },
    { label: 'bug', confidence: 0.83, source: 'model', cost: 0.00005 },
  );
  assert.throws(() => parseDecisionResponse({ system: jev(), json: { answers: {} } }), /no usable choice/);
});

test('typesafe preset posts the same shape to the native endpoint with its own key', async () => {
  const capture = {};
  const s = resolveSystem('system1', { layers: [{ provider: 'typesafe' }] });
  assert.equal(s.model, 'jev-latest');
  const adapter = createDecisionAdapter(s, {
    env: { TYPESAFE_API_KEY: 'ts_test' },
    fetchImpl: async (url, init) => {
      capture.url = url;
      capture.init = init;
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { label: { choice: 'docs', confidence: 0.4 } } }) };
    },
  });
  const r = await adapter.classify({ text: 't' });
  assert.equal(capture.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(capture.init.headers.Authorization, 'Bearer ts_test');
  assert.equal(JSON.parse(capture.init.body).model, 'jev-latest');
  assert.equal(r.label, 'docs');
  assert.equal(r.cost, null);
});

test('createAdapter dispatches on kind', () => {
  assert.equal(createAdapter(jev()).system.kind, 'decision');
  assert.equal(createAdapter(resolveSystem('system2', { layers: [DEFAULTS.system2] })).system.kind, 'chat');
  assert.equal(createAdapter(resolveSystem('system2', { layers: [{ provider: 'anthropic', model: 'm' }] })).system.kind, 'anthropic');
  assert.throws(() => createAdapter({ kind: 'telepathy' }), /Unknown adapter kind/);
});
