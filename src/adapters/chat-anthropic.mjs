import { fetchJson } from '../http.mjs';
import { msNow } from '../util.mjs';
import { getApiKey } from '../config.mjs';
import { classificationPrompt, classificationSchema, isKnownLabel } from '../task.mjs';
import { normalizeSelfReported } from '../confidence.mjs';
import { resolveCost } from './common.mjs';

// "chat" adapter for the native Anthropic Messages API.
// Structured output is obtained with a forced tool call (tool_choice), which is the documented way
// to get schema-conforming JSON from Claude. The API returns no token logprobs, so a chat System 1
// on this adapter can only use self-reported confidence.

export const ANTHROPIC_VERSION = '2023-06-01';
const TOOL_NAME = 'classify_issue';

export function buildAnthropicRequest({ system, text, wantConfidence }) {
  const withConfidence = wantConfidence && system.confidence !== 'none';
  const body = {
    model: system.model,
    max_tokens: 256,
    messages: [{ role: 'user', content: classificationPrompt({ text, withConfidence }) }],
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the classification of the GitHub issue.',
        input_schema: classificationSchema({ withConfidence }),
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
  };
  Object.assign(body, system.params || {});
  return { url: `${system.baseUrl}/v1/messages`, body };
}

export function parseAnthropicResponse({ system, json, wantConfidence }) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const tool = blocks.find((b) => b?.type === 'tool_use' && b?.name === TOOL_NAME) ?? blocks.find((b) => b?.type === 'tool_use');
  const input = tool?.input;

  if (!input || !isKnownLabel(input.label)) {
    const textBlock = blocks.find((b) => b?.type === 'text')?.text ?? '';
    throw new Error(`${system.role} (${system.model}) returned no usable label. ${textBlock.slice(0, 300)}`);
  }

  const selfReported = wantConfidence ? normalizeSelfReported(input.confidence) : null;
  const useConfidence = wantConfidence && system.confidence !== 'none' && selfReported !== null;
  if (wantConfidence && system.confidence === 'logprobs') {
    throw new Error(`${system.role}: the Anthropic Messages API returns no logprobs; use confidence=self.`);
  }

  const { cost, cost_source } = resolveCost({ usage: json?.usage, pricing: system.pricing });

  return {
    label: input.label,
    confidence: useConfidence ? selfReported : null,
    confidence_source: useConfidence ? 'self_reported' : null,
    self_reported_confidence: selfReported,
    cost,
    cost_source,
    usage: json?.usage ?? null,
  };
}

export function createAnthropicAdapter(system, { env = process.env, fetchImpl } = {}) {
  return {
    system,
    async classify({ text, wantConfidence = false }) {
      const apiKey = getApiKey(system, env);
      const { url, body } = buildAnthropicRequest({ system, text, wantConfidence });
      const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        ...system.headers,
      };
      if (apiKey) headers['x-api-key'] = apiKey;

      const t0 = msNow();
      const json = await fetchJson(url, { method: 'POST', headers, body, timeoutMs: system.timeoutMs, fetchImpl });
      const latency_ms = msNow() - t0;
      return { ...parseAnthropicResponse({ system, json, wantConfidence }), latency_ms, raw: json };
    },
  };
}
