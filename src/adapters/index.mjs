import * as chatOpenAI from './chat-openai.mjs';
import * as chatAnthropic from './chat-anthropic.mjs';
import * as decision from './decision.mjs';
import { fetchJson } from '../http.mjs';
import { msNow } from '../util.mjs';
import { resolveAuth } from '../config.mjs';

const KINDS = { chat: chatOpenAI, anthropic: chatAnthropic, decision };

// Every adapter module exposes buildRequest / parseResponse / headers. This factory composes them
// with authentication, the response cache and timing, so every kind behaves the same:
//
//   adapter.classify({ text, task, wantConfidence }) -> {
//     label, confidence (0..1 | null), confidence_source ('model'|'logprobs'|'self_reported'|null),
//     self_reported_confidence, probabilities, cost (USD | null), cost_source,
//     input_tokens, output_tokens, latency_ms, cached, raw }
export function createAdapter(system, { env = process.env, fetchImpl, cache = null, task = null, onRetry } = {}) {
  const impl = KINDS[system.kind];
  if (!impl) throw new Error(`Unknown adapter kind: ${system.kind}`);

  return {
    system,
    async classify({ text, task: t = task, wantConfidence = false }) {
      if (!t) throw new Error('classify needs a task (labels + criteria)');
      const auth = resolveAuth(system, env);
      const { url, body } = impl.buildRequest({ system, task: t, text, wantConfidence });
      const headers = impl.headers({ system, auth });

      const key = cache ? cache.key({ kind: system.kind, model: system.model, body }) : null;
      const hit = key ? cache.get(key) : null;

      let json;
      let latency_ms;
      let cached = false;
      if (hit) {
        json = hit.response;
        latency_ms = hit.latency_ms;
        cached = true;
      } else {
        const t0 = msNow();
        json = await fetchJson(url, { method: 'POST', headers, body, timeoutMs: system.timeoutMs, fetchImpl, onRetry });
        latency_ms = msNow() - t0;
        if (key) cache.set(key, { at: new Date().toISOString(), kind: system.kind, model: system.model, body, response: json, latency_ms });
      }

      return { ...impl.parseResponse({ system, task: t, json, wantConfidence }), latency_ms, cached, raw: json };
    },
  };
}
