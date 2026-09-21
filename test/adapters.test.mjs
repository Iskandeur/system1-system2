import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSystem, DEFAULTS } from '../src/config.mjs';
import { normalizeTask } from '../src/task.mjs';
import { createAdapter } from '../src/adapters/index.mjs';
import { createCache } from '../src/cache.mjs';
import * as chat from '../src/adapters/chat-openai.mjs';
import * as anthropic from '../src/adapters/chat-anthropic.mjs';
import * as decision from '../src/adapters/decision.mjs';

const task = normalizeTask({
  name: 'issue-label',
  instructions: 'Classify this GitHub issue into one label.',
  labels: ['bug', 'feature', 'docs'],
  criteria: { bug: 'Broken.', feature: 'New.', docs: 'Docs.' },
});

const sys = (layers, role = 'system1', env = {}) => resolveSystem(role, { layers: [].concat(layers), env });

function mockFetch(payload, { status = 200, capture = {}, calls = { n: 0 } } = {}) {
  return async (url, init) => {
    calls.n++;
    capture.url = url;
    capture.init = init;
    capture.body = JSON.parse(init.body);
    return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
  };
}

const chatPayload = ({ content, logprobs, usage }) => ({ choices: [{ message: { role: 'assistant', content }, logprobs }], usage });

// ---------- chat (OpenAI-compatible) ----------

test('chat System 2 request: prompt from the task, strict json_schema, no logprobs, OpenRouter usage flag', () => {
  const s = sys({ provider: 'openrouter', model: 'openai/gpt-5.2' }, 'system2');
  const { url, body } = chat.buildRequest({ system: s, task, text: 'Title: x', wantConfidence: false });
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'openai/gpt-5.2');
  assert.match(body.messages[0].content, /^Classify this GitHub issue into one label\.\nReturn ONLY strict JSON with \{"label": "bug"\|"feature"\|"docs"\}\./);
  assert.ok(body.messages[0].content.endsWith('\n\nTitle: x'));
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['label']);
  assert.equal(body.logprobs, undefined);
  assert.deepEqual(body.usage, { include: true });
});

test('chat System 1 (auto) asks for logprobs and a self-reported confidence; json_mode/params honoured', () => {
  const s = sys({ provider: 'openrouter', model: 'm' });
  const { body } = chat.buildRequest({ system: s, task, text: 't', wantConfidence: true });
  assert.equal(body.logprobs, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['label', 'confidence']);

  const o = sys({ provider: 'ollama', model: 'llama3.2', jsonMode: 'json_object', params: { temperature: 0 } });
  const r = chat.buildRequest({ system: o, task, text: 't', wantConfidence: true });
  assert.equal(r.url, 'http://localhost:11434/v1/chat/completions');
  assert.deepEqual(r.body.response_format, { type: 'json_object' });
  assert.equal(r.body.temperature, 0);
  assert.equal(r.body.usage, undefined);
});

test('chat parsing: logprob confidence when the span is found, else self-reported; strict/none modes', () => {
  const s = sys({ provider: 'openrouter', model: 'm' });
  const tokens = [
    { token: '{"', logprob: -0.01 }, { token: 'label', logprob: -0.02 }, { token: '":"', logprob: -0.03 },
    { token: 'fe', logprob: Math.log(0.8) }, { token: 'ature', logprob: Math.log(0.9) },
    { token: '","', logprob: -0.01 }, { token: 'confidence', logprob: -0.01 }, { token: '":0.99}', logprob: -0.01 },
  ];
  const r = chat.parseResponse({
    system: s, task, wantConfidence: true,
    json: chatPayload({ content: '{"label":"feature","confidence":0.99}', logprobs: { content: tokens }, usage: { prompt_tokens: 10, completion_tokens: 8, cost: 0.000012 } }),
  });
  assert.equal(r.label, 'feature');
  assert.equal(r.confidence_source, 'logprobs');
  assert.ok(Math.abs(r.confidence - 0.72) < 1e-9);
  assert.equal(r.self_reported_confidence, 0.99);
  assert.equal(r.cost, 0.000012);
  assert.equal(r.cost_source, 'provider');
  assert.equal(r.input_tokens, 10);

  const fb = chat.parseResponse({ system: s, task, wantConfidence: true, json: chatPayload({ content: '{"label":"bug","confidence":0.65}', usage: {} }) });
  assert.equal(fb.confidence, 0.65);
  assert.equal(fb.confidence_source, 'self_reported');
  assert.equal(fb.cost, null);

  const strict = sys({ provider: 'openrouter', model: 'm', confidence: 'logprobs' });
  assert.throws(() => chat.parseResponse({ system: strict, task, wantConfidence: true, json: chatPayload({ content: '{"label":"bug"}' }) }), /no token logprobs/);
  const none = sys({ provider: 'openrouter', model: 'm', confidence: 'none' });
  assert.equal(chat.parseResponse({ system: none, task, wantConfidence: true, json: chatPayload({ content: '{"label":"bug"}' }) }).confidence, null);

  assert.equal(chat.parseResponse({ system: s, task, wantConfidence: false, json: chatPayload({ content: 'Sure!\n```json\n{"label": "docs"}\n```' }) }).label, 'docs');
  assert.throws(() => chat.parseResponse({ system: s, task, wantConfidence: false, json: chatPayload({ content: '{"label": "question"}' }) }), /no usable label/);
});

test('cost from list prices is labelled list_price; configured pricing is labelled configured_pricing', () => {
  const listed = sys({ provider: 'openai', model: 'gpt-4o-mini' });
  listed.pricing = { inputPerM: 0.15, outputPerM: 0.6, source: 'list' };
  const r = chat.parseResponse({ system: listed, task, wantConfidence: false, json: chatPayload({ content: '{"label":"docs"}', usage: { prompt_tokens: 1000, completion_tokens: 100 } }) });
  assert.ok(Math.abs(r.cost - (0.15 * 1000 + 0.6 * 100) / 1e6) < 1e-12);
  assert.equal(r.cost_source, 'list_price');
  const conf = sys({ provider: 'openai', model: 'gpt-4o-mini', pricing: { inputPerM: 1, outputPerM: 2 } });
  assert.equal(chat.parseResponse({ system: conf, task, wantConfidence: false, json: chatPayload({ content: '{"label":"docs"}', usage: { prompt_tokens: 1, completion_tokens: 1 } }) }).cost_source, 'configured_pricing');
});

// ---------- anthropic ----------

test('anthropic request forces a tool call carrying the task schema', () => {
  const s = sys({ provider: 'anthropic', model: 'claude-x' }, 'system2');
  const { url, body } = anthropic.buildRequest({ system: s, task, text: 'Title: x', wantConfidence: false });
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'classify' });
  assert.deepEqual(body.tools[0].input_schema.properties.label.enum, ['bug', 'feature', 'docs']);
  assert.deepEqual(anthropic.buildRequest({ system: sys({ provider: 'anthropic', model: 'm' }), task, text: 't', wantConfidence: true }).body.tools[0].input_schema.required, ['label', 'confidence']);
});

test('anthropic parsing reads tool_use input and prices input/output tokens', () => {
  const s = sys({ provider: 'anthropic', model: 'm', pricing: { inputPerM: 10, outputPerM: 50 } });
  const json = { content: [{ type: 'text', text: 'Classifying.' }, { type: 'tool_use', name: 'classify', input: { label: 'feature', confidence: 0.8 } }], usage: { input_tokens: 2000, output_tokens: 20 } };
  const r = anthropic.parseResponse({ system: s, task, json, wantConfidence: true });
  assert.equal(r.label, 'feature');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.confidence_source, 'self_reported');
  assert.ok(Math.abs(r.cost - (10 * 2000 + 50 * 20) / 1e6) < 1e-12);
  assert.throws(() => anthropic.parseResponse({ system: sys({ provider: 'anthropic', model: 'm', confidence: 'logprobs' }), task, json, wantConfidence: true }), /no logprobs/);
  // a bare label is accepted (seen under injection: the model answered `takeaway` and nothing else), prose is not
  const bare = anthropic.parseResponse({ system: s, task, json: { content: [{ type: 'text', text: ' "feature". ' }], usage: {} }, wantConfidence: false });
  assert.equal(bare.label, 'feature');
  assert.throws(() => anthropic.parseResponse({ system: s, task, json: { content: [{ type: 'text', text: 'feature request' }] }, wantConfidence: false }), /no usable label/);
  assert.equal(chat.parseResponse({ system: sys({ provider: 'openrouter', model: 'm' }, 'system2'), task, wantConfidence: false, json: chatPayload({ content: 'bug' }) }).label, 'bug');
  assert.throws(() => anthropic.parseResponse({ system: s, task, json: { content: [{ type: 'text', text: 'nope' }] }, wantConfidence: false }), /no usable label/);
  // a JSON text block in place of the tool call is accepted (seen from an Anthropic-compatible endpoint)
  const textOnly = anthropic.parseResponse({ system: s, task, json: { content: [{ type: 'text', text: '{"label":"docs"}' }], usage: {} }, wantConfidence: false });
  assert.equal(textOnly.label, 'docs');
});

test('anthropic auth: ANTHROPIC_API_KEY as x-api-key, else ANTHROPIC_AUTH_TOKEN as bearer; base URL from ANTHROPIC_BASE_URL', async () => {
  const payload = { content: [{ type: 'tool_use', name: 'classify', input: { label: 'docs' } }], usage: {} };
  const capture = {};
  const s = sys({ provider: 'anthropic', model: 'm' }, 'system2');
  await createAdapter(s, { env: { ANTHROPIC_API_KEY: 'test-anthropic-key' }, fetchImpl: mockFetch(payload, { capture }), task }).classify({ text: 'x' });
  assert.equal(capture.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(capture.init.headers['x-api-key'], 'test-anthropic-key');
  assert.equal(capture.init.headers['anthropic-version'], anthropic.ANTHROPIC_VERSION);
  assert.equal(capture.init.headers.Authorization, undefined);

  const env = { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321/' };
  const g = sys({ provider: 'anthropic', model: 'm' }, 'system2', env);
  assert.equal(g.baseUrl, 'http://127.0.0.1:4321');
  await createAdapter(g, { env, fetchImpl: mockFetch(payload, { capture }), task }).classify({ text: 'x' });
  assert.equal(capture.url, 'http://127.0.0.1:4321/v1/messages');
  assert.equal(capture.init.headers.Authorization, 'Bearer tok');
  assert.equal(capture.init.headers['x-api-key'], undefined);

  await assert.rejects(createAdapter(s, { env: {}, fetchImpl: mockFetch(payload), task }).classify({ text: 'x' }), /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
});

// ---------- decision ----------

test('decision request: model/state/questions with the task criteria; response with probabilities', () => {
  const jev = sys(DEFAULTS.system1);
  const { url, body } = decision.buildRequest({ system: jev, task, text: 'Title: crash' });
  assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(Object.keys(body), ['model', 'state', 'questions']);
  assert.equal(body.model, 'typesafe/jev-1.13');
  assert.equal(body.state, 'Title: crash');
  assert.deepEqual(Object.keys(body.questions.label.criteria), ['bug', 'feature', 'docs']);

  const r = decision.parseResponse({ system: jev, task, json: { answers: { label: { choice: 'bug', confidence: 0.83, probabilities: { bug: 0.9, feature: 0.08, docs: 0.02 } } }, usage: { cost: 0.00005 } } });
  assert.deepEqual({ label: r.label, confidence: r.confidence, source: r.confidence_source, cost: r.cost }, { label: 'bug', confidence: 0.83, source: 'model', cost: 0.00005 });
  assert.deepEqual(r.probabilities, { bug: 0.9, feature: 0.08, docs: 0.02 });
  assert.throws(() => decision.parseResponse({ system: jev, task, json: { answers: {} } }), /no usable choice/);
});

test('typesafe preset posts the same shape to the native endpoint with its own key', async () => {
  const capture = {};
  const s = sys({ provider: 'typesafe' });
  assert.equal(s.model, 'jev-latest');
  const r = await createAdapter(s, { env: { TYPESAFE_API_KEY: 'ts_test' }, fetchImpl: mockFetch({ answers: { label: { choice: 'docs', confidence: 0.4 } } }, { capture }), task }).classify({ text: 't', wantConfidence: true });
  assert.equal(capture.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(capture.init.headers.Authorization, 'Bearer ts_test');
  assert.equal(capture.body.model, 'jev-latest');
  assert.equal(r.label, 'docs');
  assert.equal(r.cost, null);
});

// ---------- factory, cache, errors ----------

test('createAdapter dispatches on kind, sends bearer auth + extra headers, reports latency', async () => {
  assert.equal(createAdapter(sys(DEFAULTS.system1)).system.kind, 'decision');
  assert.equal(createAdapter(sys(DEFAULTS.system2, 'system2')).system.kind, 'chat');
  assert.throws(() => createAdapter({ kind: 'telepathy' }), /Unknown adapter kind/);

  const capture = {};
  const s = sys({ provider: 'groq', model: 'llama-3.1-8b-instant', headers: { 'X-Title': 'demo' } });
  const r = await createAdapter(s, { env: { GROQ_API_KEY: 'gsk_test' }, fetchImpl: mockFetch(chatPayload({ content: '{"label":"bug","confidence":0.9}' }), { capture }), task }).classify({ text: 'Title: crash', wantConfidence: true });
  assert.equal(capture.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(capture.init.headers.Authorization, 'Bearer gsk_test');
  assert.equal(capture.init.headers['X-Title'], 'demo');
  assert.equal(r.label, 'bug');
  assert.equal(typeof r.latency_ms, 'number');
  assert.equal(r.cached, false);
});

test('the response cache short-circuits identical requests and is keyed on the body, not the URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1s2-cache-'));
  const cache = createCache({ dir });
  const calls = { n: 0 };
  const payload = chatPayload({ content: '{"label":"bug","confidence":0.9}', usage: { cost: 0.001 } });
  const mk = (baseUrl) => createAdapter(sys({ provider: 'openai-compatible', baseUrl, model: 'm' }), { env: {}, fetchImpl: mockFetch(payload, { calls }), cache, task });

  const a = await mk('http://127.0.0.1:1111/v1').classify({ text: 'same', wantConfidence: true });
  const b = await mk('http://127.0.0.1:2222/v1').classify({ text: 'same', wantConfidence: true });
  const c = await mk('http://127.0.0.1:2222/v1').classify({ text: 'other', wantConfidence: true });
  assert.equal(calls.n, 2);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.label, 'bug');
  assert.equal(b.cost, 0.001);
  assert.equal(c.cached, false);
  assert.deepEqual(cache.stats(), { hits: 1, misses: 2 });
});

test('HTTP errors carry status and host, never the key', async () => {
  const s = sys({ provider: 'openrouter', model: 'm' });
  const adapter = createAdapter(s, { env: { OPENROUTER_API_KEY: 'test-key-do-not-leak' }, fetchImpl: mockFetch({ error: { message: 'model not found' } }, { status: 404 }), task });
  await assert.rejects(adapter.classify({ text: 't', wantConfidence: true }), (e) => {
    assert.match(e.message, /HTTP 404 from openrouter\.ai: model not found/);
    assert.ok(!e.message.includes('test-key-do-not-leak'));
    return true;
  });
});
