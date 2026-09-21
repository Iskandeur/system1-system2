import { decisionQuestions, isKnownLabel, wrapText } from '../task.mjs';
import { resolveCost, tokenCounts, authHeaders } from './common.mjs';

// "decision" adapter: typed-question models (TypeSafe Jev "System One").
// Request: POST {base_url} with { model, state, questions }
//   -> { answers: { label: { choice, confidence, probabilities } }, usage }
// Works against OpenRouter's /api/alpha/decisions (default) and, with the same shape, TypeSafe's own API.
// The confidence is produced by the model itself (confidence_source = "model"): TypeSafe defines it as
// a statistic of how concentrated the probability mass is over the options, not as P(correct).

export function buildRequest({ system, task, text }) {
  const body = { model: system.model, state: wrapText(task, text), questions: decisionQuestions(task) };
  Object.assign(body, system.params || {});
  return { url: system.baseUrl, body };
}

function cleanProbabilities(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = Math.round(n * 1e4) / 1e4;
  }
  return Object.keys(out).length ? out : null;
}

export function parseResponse({ system, task, json }) {
  const answer = json?.answers?.label;
  const label = answer?.choice;
  if (!isKnownLabel(task, label)) {
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
    probabilities: cleanProbabilities(answer?.probabilities),
    cost,
    cost_source,
    ...tokenCounts(json?.usage),
  };
}

export function headers({ system, auth }) {
  return authHeaders(auth, system.headers);
}
