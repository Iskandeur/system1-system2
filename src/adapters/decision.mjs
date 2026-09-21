import { fetchJson } from '../http.mjs';
import { msNow } from '../util.mjs';
import { getApiKey } from '../config.mjs';
import { decisionQuestions, isKnownLabel } from '../task.mjs';
import { resolveCost, bearerHeaders } from './common.mjs';

// "decision" adapter: typed-question models (TypeSafe Jev "System One").
// Request: POST {base_url} with { model, state, questions }  -> { answers: { label: { choice, confidence } }, usage }
// Works against OpenRouter's /api/alpha/decisions (default) and, with the same shape, TypeSafe's own API.
// The confidence here is produced by the model itself (confidence_source = "model").

export function buildDecisionRequest({ system, text }) {
  const body = { model: system.model, state: text, questions: decisionQuestions() };
  Object.assign(body, system.params || {});
  return { url: system.baseUrl, body };
}

export function parseDecisionResponse({ system, json }) {
  const answer = json?.answers?.label;
  const label = answer?.choice;
  if (!isKnownLabel(label)) {
    throw new Error(`${system.role} (${system.model}) returned no usable choice: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const c = Number(answer?.confidence);
  const confidence = Number.isFinite(c) ? c : null;
  const { cost, cost_source } = resolveCost({ usage: json?.usage, pricing: system.pricing });
  return {
    label,
    confidence,
    confidence_source: confidence === null ? null : 'model',
    self_reported_confidence: null,
    cost,
    cost_source,
    usage: json?.usage ?? null,
  };
}

export function createDecisionAdapter(system, { env = process.env, fetchImpl } = {}) {
  return {
    system,
    async classify({ text }) {
      const apiKey = getApiKey(system, env);
      const { url, body } = buildDecisionRequest({ system, text });
      const t0 = msNow();
      const json = await fetchJson(url, {
        method: 'POST',
        headers: bearerHeaders(apiKey, system.headers),
        body,
        timeoutMs: system.timeoutMs,
        fetchImpl,
      });
      const latency_ms = msNow() - t0;
      return { ...parseDecisionResponse({ system, json }), latency_ms, raw: json };
    },
  };
}
