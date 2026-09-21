import fs from 'node:fs';

import { inProject } from './paths.mjs';

// Refreshes data/prices.json from OpenRouter's public model listing (no key needed). These are the
// public list prices used to cost System 2 calls made against endpoints that report tokens but no
// price. Keys are the short model names used in this repo; `listed_as` is the OpenRouter id.

const MODELS = {
  'gpt-5.2': 'openai/gpt-5.2',
  'gpt-5': 'openai/gpt-5',
  'gpt-5-mini': 'openai/gpt-5-mini',
  'gpt-5-nano': 'openai/gpt-5-nano',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'grok-4.3': 'x-ai/grok-4.3',
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'qwen3.6-27b': 'qwen/qwen3.6-27b',
  'gemma-4-31b-it': 'google/gemma-4-31b-it',
};

const res = await fetch('https://openrouter.ai/api/v1/models');
if (!res.ok) throw new Error(`HTTP ${res.status} from openrouter.ai/api/v1/models`);
const listing = (await res.json()).data;
const byId = new Map(listing.map((m) => [m.id, m]));

const models = {};
for (const [short, id] of Object.entries(MODELS)) {
  const m = byId.get(id);
  if (!m) {
    console.error(`not listed: ${id}`);
    continue;
  }
  models[short] = {
    listed_as: id,
    input: Number(m.pricing.prompt) * 1e6,
    output: Number(m.pricing.completion) * 1e6,
  };
}

const doc = {
  source: 'OpenRouter public model listing, https://openrouter.ai/api/v1/models',
  fetched_at: new Date().toISOString(),
  unit: 'USD per million tokens',
  models,
};
const out = inProject('data/prices.json');
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote ${out} (${Object.keys(models).length} models)`);
