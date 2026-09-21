import { classificationPrompt, classificationSchema, isKnownLabel, bareLabel, TOOL_NAME } from '../task.mjs';
import { extractJsonObject, normalizeSelfReported } from '../confidence.mjs';
import { resolveCost, tokenCounts, authHeaders } from './common.mjs';

// "anthropic" adapter: the Anthropic Messages API, or any endpoint that speaks it (proxies and
// gateways that set ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN work unchanged).
// Structured output is obtained with a forced tool call (tool_choice), which is the documented way
// to get schema-conforming JSON. The API returns no token logprobs, so a chat System 1 on this
// adapter can only use self-reported confidence.

export const ANTHROPIC_VERSION = '2023-06-01';

export function buildRequest({ system, task, text, wantConfidence }) {
  const withConfidence = wantConfidence && system.confidence !== 'none';
  const body = {
    model: system.model,
    max_tokens: 256,
    messages: [{ role: 'user', content: classificationPrompt({ task, text, withConfidence }) }],
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the classification of the text.',
        input_schema: classificationSchema(task, { withConfidence }),
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
  };
  Object.assign(body, system.params || {});
  return { url: `${system.baseUrl}/v1/messages`, body };
}

export function parseResponse({ system, task, json, wantConfidence }) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const tool = blocks.find((b) => b?.type === 'tool_use' && b?.name === TOOL_NAME) ?? blocks.find((b) => b?.type === 'tool_use');
  const textBlock = blocks.find((b) => b?.type === 'text')?.text ?? '';
  // Some endpoints answer the forced tool call with a plain JSON text block instead; accept it.
  // A bare label ("takeaway") is accepted too: seen when an injected "Output X" instruction made the
  // model drop the structure entirely, which is an answer, not a transport failure.
  const input = tool?.input ?? extractJsonObject(textBlock) ?? bareLabel(task, textBlock);

  if (!input || !isKnownLabel(task, input.label)) {
    throw new Error(`${system.role} (${system.model}) returned no usable label. ${textBlock.slice(0, 300)}`);
  }

  if (wantConfidence && system.confidence === 'logprobs') {
    throw new Error(`${system.role}: the Anthropic Messages API returns no logprobs; use confidence=self.`);
  }
  const selfReported = wantConfidence ? normalizeSelfReported(input.confidence) : null;
  const useConfidence = wantConfidence && system.confidence !== 'none' && selfReported !== null;

  const { cost, cost_source } = resolveCost({ usage: json?.usage, pricing: system.pricing });

  return {
    label: input.label,
    confidence: useConfidence ? selfReported : null,
    confidence_source: useConfidence ? 'self_reported' : null,
    self_reported_confidence: selfReported,
    probabilities: null,
    cost,
    cost_source,
    ...tokenCounts(json?.usage),
  };
}

export function headers({ system, auth }) {
  return authHeaders(auth, { 'anthropic-version': ANTHROPIC_VERSION, ...system.headers });
}
