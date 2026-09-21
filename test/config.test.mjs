import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseArgs,
  resolveRunConfig,
  resolveSystem,
  resolveAuth,
  getApiKey,
  applyListPrices,
  publicSystem,
  PRESETS,
  DEFAULTS,
} from '../src/config.mjs';

test('parseArgs handles --k v, --k=v, boolean flags and repeated flags', () => {
  const { flags, positionals } = parseArgs(['pos', '--s1-model', 'x/y', '--limit=5', '--dry-run', '--s2', 'a', '--s2', 'b']);
  assert.deepEqual(flags, { 's1-model': 'x/y', limit: '5', 'dry-run': true, s2: ['a', 'b'] });
  assert.deepEqual(positionals, ['pos']);
});

test('defaults are Jev (decision) + GPT-5.2 on OpenRouter (chat), dataset massive-en', () => {
  const cfg = resolveRunConfig({ argv: [], env: {} });
  assert.equal(cfg.system1.provider, 'jev');
  assert.equal(cfg.system1.kind, 'decision');
  assert.equal(cfg.system1.model, 'typesafe/jev-1.13');
  assert.equal(cfg.system1.baseUrl, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(cfg.system1.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(cfg.system2.provider, 'openrouter');
  assert.equal(cfg.system2.kind, 'chat');
  assert.equal(cfg.system2.model, 'openai/gpt-5.2');
  assert.equal(cfg.system2.jsonMode, 'json_schema');
  assert.equal(cfg.threshold, 0.4);
  assert.equal(cfg.limit, null);
  assert.equal(cfg.tag, null);
  assert.equal(cfg.dataset, 'massive-en');
});

test('env vars override presets; CLI overrides env', () => {
  const env = {
    S1_PROVIDER: 'openai',
    S1_MODEL: 'gpt-4o-mini',
    S2_PROVIDER: 'anthropic',
    S2_MODEL: 'claude-x',
    S2_HEADERS: '{"anthropic-beta":"foo"}',
    HYBRID_CONFIDENCE_THRESHOLD: '0.7',
    EVAL_DATASET: 'massive-fr',
  };
  const cfg = resolveRunConfig({ argv: ['--s1-model', 'gpt-4.1', '--threshold', '0.25', '--limit', '3', '--tag', 'alt-1', '--dataset', 'github-issues'], env });
  assert.equal(cfg.system1.provider, 'openai');
  assert.equal(cfg.system1.model, 'gpt-4.1'); // CLI wins over S1_MODEL
  assert.equal(cfg.system1.baseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.system2.kind, 'anthropic');
  assert.equal(cfg.system2.baseUrl, 'https://api.anthropic.com');
  assert.deepEqual(cfg.system2.headers, { 'anthropic-beta': 'foo' });
  assert.equal(cfg.threshold, 0.25);
  assert.equal(cfg.limit, 3);
  assert.equal(cfg.tag, 'alt-1');
  assert.equal(cfg.dataset, 'github-issues');
});

test('SDK-style base URL variables are honoured unless a base URL is given explicitly', () => {
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/', OPENAI_BASE_URL: 'https://proxy.example/v1' };
  const a = resolveSystem('system2', { layers: [{ provider: 'anthropic', model: 'm' }], env });
  assert.equal(a.baseUrl, 'http://127.0.0.1:9');
  assert.equal(a.authTokenEnv, 'ANTHROPIC_AUTH_TOKEN');
  const o = resolveSystem('system2', { layers: [{ provider: 'openai', model: 'm' }], env });
  assert.equal(o.baseUrl, 'https://proxy.example/v1');
  const explicit = resolveSystem('system2', { layers: [{ provider: 'anthropic', model: 'm', baseUrl: 'https://other.example' }], env });
  assert.equal(explicit.baseUrl, 'https://other.example');
});

test('config file is read and sits below env in precedence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1s2-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      system1: { provider: 'ollama', model: 'llama3.2', confidence: 'self', json_mode: 'json_object' },
      system2: { provider: 'openai-compatible', base_url: 'http://gpu-box:8000/v1/', model: 'my-model', api_key_env: 'MY_KEY', pricing: { input_per_m: 1, output_per_m: 2 } },
      threshold: 0.6,
    }),
  );
  const cfg = resolveRunConfig({ argv: ['--config', file], env: { S1_MODEL: 'qwen2.5:7b' } });
  assert.equal(cfg.system1.provider, 'ollama');
  assert.equal(cfg.system1.model, 'qwen2.5:7b'); // env wins over file
  assert.equal(cfg.system1.apiKeyEnv, null);
  assert.equal(cfg.system1.confidence, 'self');
  assert.equal(cfg.system2.baseUrl, 'http://gpu-box:8000/v1'); // trailing slash stripped
  assert.equal(cfg.system2.apiKeyEnv, 'MY_KEY');
  assert.deepEqual(cfg.system2.pricing, { inputPerM: 1, outputPerM: 2, source: 'configured' });
  assert.equal(cfg.threshold, 0.6);
});

test('validation errors name the variable to set', () => {
  assert.throws(() => resolveRunConfig({ argv: [], env: { S2_PROVIDER: 'openai-compatible', S2_MODEL: 'x' } }), /S2_BASE_URL/);
  assert.throws(() => resolveRunConfig({ argv: ['--s1-provider', 'nope'], env: {} }), /Known presets: .*ollama/);
  assert.throws(() => resolveRunConfig({ argv: [], env: { S2_CONFIDENCE: 'maybe' } }), /confidence must be one of/);
  assert.throws(() => resolveRunConfig({ argv: [], env: { S2_JSON_MODE: 'yaml' } }), /json_mode must be one of/);
  assert.throws(() => resolveRunConfig({ argv: [], env: { S2_HEADERS: 'not json' } }), /S2_HEADERS must be a JSON object/);
});

test('resolveAuth: named env var, bearer token fallback, optional for local servers, named when missing', () => {
  const s = resolveSystem('system1', { layers: [DEFAULTS.system1, { provider: 'openai', model: 'm' }] });
  assert.deepEqual(resolveAuth(s, { OPENAI_API_KEY: 'k1' }), { scheme: 'bearer', key: 'k1' });
  assert.equal(getApiKey(s, { OPENAI_API_KEY: 'k1' }), 'k1');
  assert.throws(() => resolveAuth(s, {}), /OPENAI_API_KEY/);

  const custom = resolveSystem('system2', { layers: [{ provider: 'groq', model: 'm', apiKeyEnv: 'MY_GROQ' }] });
  assert.equal(resolveAuth(custom, { MY_GROQ: 'k2', GROQ_API_KEY: 'wrong' }).key, 'k2');

  const local = resolveSystem('system2', { layers: [{ provider: 'ollama', model: 'llama3.2' }] });
  assert.equal(resolveAuth(local, {}), null);

  const a = resolveSystem('system2', { layers: [{ provider: 'anthropic', model: 'm' }] });
  assert.deepEqual(resolveAuth(a, { ANTHROPIC_API_KEY: 'k' }), { scheme: 'x-api-key', key: 'k' });
  assert.deepEqual(resolveAuth(a, { ANTHROPIC_AUTH_TOKEN: 't' }), { scheme: 'bearer', key: 't' });
  assert.throws(() => resolveAuth(a, {}), /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
});

test('applyListPrices fills pricing by full id or short name, and never overrides configured pricing', () => {
  const prices = { models: { 'gpt-5.2': { input: 1.75, output: 14 } } };
  const s = resolveSystem('system2', { layers: [{ provider: 'openrouter', model: 'openai/gpt-5.2' }] });
  applyListPrices(s, prices);
  assert.deepEqual(s.pricing, { inputPerM: 1.75, outputPerM: 14, source: 'list' });
  const c = resolveSystem('system2', { layers: [{ provider: 'openrouter', model: 'gpt-5.2', pricing: { inputPerM: 1, outputPerM: 1 } }] });
  applyListPrices(c, prices);
  assert.equal(c.pricing.source, 'configured');
  const u = resolveSystem('system2', { layers: [{ provider: 'openrouter', model: 'unknown' }] });
  assert.equal(applyListPrices(u, prices).pricing, null);
  assert.equal(publicSystem(s).pricing.source, 'list');
});

test('publicSystem never exposes the key or header values', () => {
  const s = resolveSystem('system1', { layers: [{ provider: 'openrouter', model: 'm', apiKey: 'SECRET', headers: { 'X-Secret': 'ALSO-SECRET' } }] });
  const text = JSON.stringify(publicSystem(s));
  assert.ok(!text.includes('SECRET'));
  assert.ok(text.includes('"extra_headers":["X-Secret"]'));
  assert.equal(publicSystem(s).api_key_env, 'OPENROUTER_API_KEY');
});

test('every preset has a kind the adapter factory knows', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.ok(['chat', 'anthropic', 'decision'].includes(p.kind), `${name}: ${p.kind}`);
  }
});
