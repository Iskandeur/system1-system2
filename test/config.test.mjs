import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseArgs,
  resolveRunConfig,
  resolveSystem,
  getApiKey,
  publicSystem,
  PRESETS,
  DEFAULTS,
} from '../src/config.mjs';

test('parseArgs handles --k v, --k=v and boolean flags', () => {
  const { flags, positionals } = parseArgs(['pos', '--s1-model', 'x/y', '--limit=5', '--dry-run']);
  assert.deepEqual(flags, { 's1-model': 'x/y', limit: '5', 'dry-run': true });
  assert.deepEqual(positionals, ['pos']);
});

test('defaults are Jev (decision) + Claude Fable on OpenRouter (chat)', () => {
  const cfg = resolveRunConfig({ argv: [], env: {} });
  assert.equal(cfg.system1.provider, 'jev');
  assert.equal(cfg.system1.kind, 'decision');
  assert.equal(cfg.system1.model, 'typesafe/jev-1.13');
  assert.equal(cfg.system1.baseUrl, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(cfg.system1.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(cfg.system2.provider, 'openrouter');
  assert.equal(cfg.system2.kind, 'chat');
  assert.equal(cfg.system2.model, 'anthropic/claude-fable-5.1');
  assert.equal(cfg.system2.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(cfg.system2.jsonMode, 'json_schema');
  assert.equal(cfg.threshold, 0.4);
  assert.equal(cfg.limit, null);
  assert.equal(cfg.tag, null);
});

test('env vars override presets; CLI overrides env', () => {
  const env = {
    S1_PROVIDER: 'openai',
    S1_MODEL: 'gpt-4o-mini',
    S2_PROVIDER: 'anthropic',
    S2_MODEL: 'claude-x',
    S2_HEADERS: '{"anthropic-beta":"foo"}',
    HYBRID_CONFIDENCE_THRESHOLD: '0.7',
  };
  const cfg = resolveRunConfig({ argv: ['--s1-model', 'gpt-4.1', '--threshold', '0.25', '--limit', '3', '--tag', 'alt-1'], env });
  assert.equal(cfg.system1.provider, 'openai');
  assert.equal(cfg.system1.kind, 'chat');
  assert.equal(cfg.system1.model, 'gpt-4.1'); // CLI wins over S1_MODEL
  assert.equal(cfg.system1.baseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.system1.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(cfg.system2.kind, 'anthropic');
  assert.equal(cfg.system2.baseUrl, 'https://api.anthropic.com');
  assert.deepEqual(cfg.system2.headers, { 'anthropic-beta': 'foo' });
  assert.equal(cfg.threshold, 0.25); // CLI wins over env
  assert.equal(cfg.limit, 3);
  assert.equal(cfg.tag, 'alt-1');
});

test('config file is read and sits below env in precedence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1s2-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      system1: { provider: 'ollama', model: 'llama3.2', confidence: 'self', json_mode: 'json_object' },
      system2: {
        provider: 'openai-compatible',
        base_url: 'http://gpu-box:8000/v1/',
        model: 'my-model',
        api_key_env: 'MY_KEY',
        pricing: { input_per_m: 1, output_per_m: 2 },
      },
      threshold: 0.6,
    }),
  );

  const cfg = resolveRunConfig({ argv: ['--config', file], env: { S1_MODEL: 'qwen2.5:7b' } });
  assert.equal(cfg.system1.provider, 'ollama');
  assert.equal(cfg.system1.model, 'qwen2.5:7b'); // env wins over file
  assert.equal(cfg.system1.baseUrl, 'http://localhost:11434/v1');
  assert.equal(cfg.system1.apiKeyEnv, null);
  assert.equal(cfg.system1.confidence, 'self');
  assert.equal(cfg.system1.jsonMode, 'json_object');
  assert.equal(cfg.system2.baseUrl, 'http://gpu-box:8000/v1'); // trailing slash stripped
  assert.equal(cfg.system2.apiKeyEnv, 'MY_KEY');
  assert.deepEqual(cfg.system2.pricing, { inputPerM: 1, outputPerM: 2 });
  assert.equal(cfg.threshold, 0.6);
  assert.equal(cfg.configFile, path.resolve(file));
});

test('openai-compatible without base_url fails with a named variable', () => {
  assert.throws(
    () => resolveRunConfig({ argv: [], env: { S2_PROVIDER: 'openai-compatible', S2_MODEL: 'x' } }),
    /S2_BASE_URL/,
  );
});

test('unknown provider lists the presets', () => {
  assert.throws(() => resolveRunConfig({ argv: ['--s1-provider', 'nope'], env: {} }), /Known presets: .*ollama/);
});

test('bad confidence / json_mode / headers values are rejected', () => {
  assert.throws(() => resolveRunConfig({ argv: [], env: { S2_CONFIDENCE: 'maybe' } }), /confidence must be one of/);
  assert.throws(() => resolveRunConfig({ argv: [], env: { S2_JSON_MODE: 'yaml' } }), /json_mode must be one of/);
  assert.throws(() => resolveRunConfig({ argv: [], env: { S2_HEADERS: 'not json' } }), /S2_HEADERS must be a JSON object/);
});

test('getApiKey reads the named env var, names it when missing, and is optional for local servers', () => {
  const s = resolveSystem('system1', { layers: [DEFAULTS.system1, { provider: 'openai', model: 'm' }] });
  assert.equal(getApiKey(s, { OPENAI_API_KEY: 'k1' }), 'k1');
  assert.throws(() => getApiKey(s, {}), /OPENAI_API_KEY/);

  const custom = resolveSystem('system2', { layers: [{ provider: 'groq', model: 'm', apiKeyEnv: 'MY_GROQ' }] });
  assert.equal(getApiKey(custom, { MY_GROQ: 'k2', GROQ_API_KEY: 'wrong' }), 'k2');

  const local = resolveSystem('system2', { layers: [{ provider: 'ollama', model: 'llama3.2' }] });
  assert.equal(getApiKey(local, {}), null);
});

test('publicSystem never exposes the key or header values', () => {
  const s = resolveSystem('system1', {
    layers: [{ provider: 'openrouter', model: 'm', apiKey: 'SECRET', headers: { 'X-Secret': 'ALSO-SECRET' } }],
  });
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
