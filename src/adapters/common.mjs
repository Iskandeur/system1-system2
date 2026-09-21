// Shared helpers for adapters.

// Cost in USD for one call.
// 1. If the provider reports a cost (OpenRouter `usage.cost`), use it.
// 2. Else, if the user configured pricing (per million tokens), estimate from token usage.
// 3. Else null (unknown), never 0: an unknown cost must not look like a free call.
export function resolveCost({ usage, pricing }) {
  const reported = Number(usage?.cost);
  if (usage && Number.isFinite(reported)) return { cost: reported, cost_source: 'provider' };

  if (pricing) {
    const inTok = Number(usage?.prompt_tokens ?? usage?.input_tokens);
    const outTok = Number(usage?.completion_tokens ?? usage?.output_tokens);
    if (Number.isFinite(inTok) && Number.isFinite(outTok)) {
      const cost = (inTok * (pricing.inputPerM || 0) + outTok * (pricing.outputPerM || 0)) / 1e6;
      return { cost, cost_source: 'configured_pricing' };
    }
  }

  return { cost: null, cost_source: null };
}

export function isOpenRouter(baseUrl) {
  try {
    return new URL(baseUrl).host.endsWith('openrouter.ai');
  } catch {
    return false;
  }
}

export function bearerHeaders(apiKey, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (apiKey) h.Authorization = 'Bearer ' + apiKey;
  return h;
}
