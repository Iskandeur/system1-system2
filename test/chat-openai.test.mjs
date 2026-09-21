import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSystem } from '../src/config.mjs';
import { buildChatRequest, parseChatResponse, createOpenAIChatAdapter } from '../src/adapters/chat-openai.mjs';

function system(overrides = {}, role = 'system1') {
  return resolveSystem(role, { layers: [{ provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct', ...overrides }] });
}

function mockFetch(payload, { status = 200, capture = {} } = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = JSON.parse(init.body);
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
  };
}

function chatPayload({ content, logprobs, usage }) {
  return { choices: [{ message: { role: 'assistant', content }, logprobs }], usage };
}

test('System 2 request keeps the original prompt/schema (no confidence field) and adds no logprobs', () => {
  const s = system({ model: 'anthropic/claude-fable-5.1' }, 'system2');
  const { url, body } = buildChatRequest({ system: s, text: 'Title: x', wantConfidence: false });
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'anthropic/claude-fable-5.1');
  assert.equal(
    body.messages[0].content,
    'Classify this GitHub issue into one label.\nReturn ONLY strict JSON with {"label": "bug"|"feature"|"docs"}.\n\nTitle: x',
  );
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['label']);
  assert.equal(body.logprobs, undefined);
  assert.deepEqual(body.usage, { include: true }); // OpenRouter cost accounting
});

test('System 1 request (auto) asks for logprobs and a self-reported confidence', () => {
  const s = system();
  const { body } = buildChatRequest({ system: s, text: 'Title: x', wantConfidence: true });
  assert.equal(body.logprobs, true);
  assert.match(body.messages[0].content, /"confidence": <number between 0 and 1>/);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['label', 'confidence']);
});

test('json_mode and params are honoured; non-OpenRouter hosts get no usage flag', () => {
  const s = system({ provider: 'ollama', model: 'llama3.2', jsonMode: 'json_object', params: { temperature: 0 } });
  const { url, body } = buildChatRequest({ system: s, text: 't', wantConfidence: true });
  assert.equal(url, 'http://localhost:11434/v1/chat/completions');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.temperature, 0);
  assert.equal(body.usage, undefined);

  const none = system({ jsonMode: 'none' });
  assert.equal(buildChatRequest({ system: none, text: 't', wantConfidence: false }).body.response_format, undefined);
});

test('confidence comes from logprobs when the label span is found', () => {
  const s = system();
  const tokens = [
    { token: '{"', logprob: -0.01 },
    { token: 'label', logprob: -0.02 },
    { token: '":"', logprob: -0.03 },
    { token: 'fe', logprob: Math.log(0.8) },
    { token: 'ature', logprob: Math.log(0.9) },
    { token: '","', logprob: -0.01 },
    { token: 'confidence', logprob: -0.01 },
    { token: '":0.99}', logprob: -0.01 },
  ];
  const json = chatPayload({
    content: '{"label":"feature","confidence":0.99}',
    logprobs: { content: tokens },
    usage: { prompt_tokens: 10, completion_tokens: 8, cost: 0.000012 },
  });
  const r = parseChatResponse({ system: s, json, wantConfidence: true });
  assert.equal(r.label, 'feature');
  assert.equal(r.confidence_source, 'logprobs');
  assert.ok(Math.abs(r.confidence - 0.72) < 1e-9);
  assert.equal(r.self_reported_confidence, 0.99);
  assert.equal(r.cost, 0.000012);
  assert.equal(r.cost_source, 'provider');
});

test('falls back to self-reported confidence when no logprobs are returned', () => {
  const s = system();
  const json = chatPayload({ content: '{"label":"bug","confidence":0.65}', usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const r = parseChatResponse({ system: s, json, wantConfidence: true });
  assert.equal(r.confidence, 0.65);
  assert.equal(r.confidence_source, 'self_reported');
  assert.equal(r.cost, null); // no provider cost, no pricing
  assert.equal(r.cost_source, null);
});

test('confidence=logprobs is strict; confidence=none yields null', () => {
  const strict = system({ confidence: 'logprobs' });
  const json = chatPayload({ content: '{"label":"bug"}' });
  assert.throws(() => parseChatResponse({ system: strict, json, wantConfidence: true }), /no token logprobs/);

  const none = system({ confidence: 'none' });
  const r = parseChatResponse({ system: none, json: chatPayload({ content: '{"label":"bug"}' }), wantConfidence: true });
  assert.equal(r.confidence, null);
  assert.equal(r.confidence_source, null);
});

test('cost is estimated from configured pricing when the provider reports none', () => {
  const s = system({ provider: 'openai', model: 'gpt-4o-mini', pricing: { inputPerM: 0.15, outputPerM: 0.6 } });
  const json = chatPayload({ content: '{"label":"docs","confidence":0.5}', usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  const r = parseChatResponse({ system: s, json, wantConfidence: true });
  assert.ok(Math.abs(r.cost - (0.15 * 1000 + 0.6 * 100) / 1e6) < 1e-12);
  assert.equal(r.cost_source, 'configured_pricing');
});

test('lenient JSON: code fences and prose around the object are tolerated; bad labels throw', () => {
  const s = system({}, 'system2');
  const fenced = chatPayload({ content: 'Sure!\n```json\n{"label": "docs"}\n```' });
  assert.equal(parseChatResponse({ system: s, json: fenced, wantConfidence: false }).label, 'docs');

  const bad = chatPayload({ content: '{"label": "question"}' });
  assert.throws(() => parseChatResponse({ system: s, json: bad, wantConfidence: false }), /no usable label/);
});

test('adapter sends bearer auth from the named env var plus extra headers, and reports latency', async () => {
  const capture = {};
  const s = system({ provider: 'groq', model: 'llama-3.1-8b-instant', headers: { 'X-Title': 'demo' } });
  const adapter = createOpenAIChatAdapter(s, {
    env: { GROQ_API_KEY: 'gsk_test' },
    fetchImpl: mockFetch(chatPayload({ content: '{"label":"bug","confidence":0.9}' }), { capture }),
  });
  const r = await adapter.classify({ text: 'Title: crash', wantConfidence: true });
  assert.equal(capture.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(capture.init.headers.Authorization, 'Bearer gsk_test');
  assert.equal(capture.init.headers['X-Title'], 'demo');
  assert.equal(capture.body.model, 'llama-3.1-8b-instant');
  assert.equal(r.label, 'bug');
  assert.equal(typeof r.latency_ms, 'number');
});

test('adapter surfaces HTTP errors with status and host, never the key', async () => {
  const s = system();
  const adapter = createOpenAIChatAdapter(s, {
    env: { OPENROUTER_API_KEY: 'test-key-do-not-leak' },
    fetchImpl: mockFetch({ error: { message: 'model not found' } }, { status: 404 }),
  });
  await assert.rejects(adapter.classify({ text: 't', wantConfidence: true }), (e) => {
    assert.match(e.message, /HTTP 404 from openrouter\.ai: model not found/);
    assert.ok(!e.message.includes('test-key-do-not-leak'));
    return true;
  });
});
