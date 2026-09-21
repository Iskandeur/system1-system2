import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSystem } from '../src/config.mjs';
import { buildAnthropicRequest, parseAnthropicResponse, createAnthropicAdapter, ANTHROPIC_VERSION } from '../src/adapters/chat-anthropic.mjs';

function system(overrides = {}, role = 'system2') {
  return resolveSystem(role, { layers: [{ provider: 'anthropic', model: 'claude-fable-5.1', ...overrides }] });
}

test('request uses the Messages API with a forced tool call carrying the schema', () => {
  const s = system();
  const { url, body } = buildAnthropicRequest({ system: s, text: 'Title: x', wantConfidence: false });
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(body.model, 'claude-fable-5.1');
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'classify_issue' });
  assert.deepEqual(body.tools[0].input_schema.required, ['label']);
  assert.equal(body.messages[0].role, 'user');
});

test('as System 1 the schema asks for a confidence field', () => {
  const s = system({}, 'system1');
  const { body } = buildAnthropicRequest({ system: s, text: 't', wantConfidence: true });
  assert.deepEqual(body.tools[0].input_schema.required, ['label', 'confidence']);
});

test('response parsing reads tool_use input; cost from configured pricing on input/output tokens', () => {
  const s = system({ pricing: { inputPerM: 10, outputPerM: 50 } }, 'system1');
  const json = {
    content: [
      { type: 'text', text: 'Classifying.' },
      { type: 'tool_use', name: 'classify_issue', input: { label: 'feature', confidence: 0.8 } },
    ],
    usage: { input_tokens: 2000, output_tokens: 20 },
  };
  const r = parseAnthropicResponse({ system: s, json, wantConfidence: true });
  assert.equal(r.label, 'feature');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.confidence_source, 'self_reported');
  assert.ok(Math.abs(r.cost - (10 * 2000 + 50 * 20) / 1e6) < 1e-12);
  assert.equal(r.cost_source, 'configured_pricing');
});

test('confidence=logprobs is refused on this API; missing tool_use throws', () => {
  const strict = system({ confidence: 'logprobs' }, 'system1');
  const json = { content: [{ type: 'tool_use', name: 'classify_issue', input: { label: 'bug' } }] };
  assert.throws(() => parseAnthropicResponse({ system: strict, json, wantConfidence: true }), /no logprobs/);

  const s = system();
  assert.throws(
    () => parseAnthropicResponse({ system: s, json: { content: [{ type: 'text', text: 'nope' }] }, wantConfidence: false }),
    /no usable label/,
  );
});

test('adapter sends x-api-key and anthropic-version headers', async () => {
  const capture = {};
  const s = system();
  const adapter = createAnthropicAdapter(s, {
    env: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
    fetchImpl: async (url, init) => {
      capture.url = url;
      capture.init = init;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ content: [{ type: 'tool_use', name: 'classify_issue', input: { label: 'docs' } }], usage: {} }),
      };
    },
  });
  const r = await adapter.classify({ text: 'How do I…', wantConfidence: false });
  assert.equal(capture.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(capture.init.headers['x-api-key'], 'test-anthropic-key');
  assert.equal(capture.init.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(capture.init.headers.Authorization, undefined);
  assert.equal(r.label, 'docs');
  assert.equal(r.cost, null);
});
