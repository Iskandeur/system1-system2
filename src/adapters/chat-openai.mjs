import { classificationPrompt, classificationSchema, isKnownLabel } from '../task.mjs';
import { extractJsonObject, labelSpanConfidence, normalizeSelfReported } from '../confidence.mjs';
import { resolveCost, tokenCounts, isOpenRouter, authHeaders } from './common.mjs';

// "chat" adapter: any OpenAI-compatible /chat/completions endpoint
// (OpenRouter, OpenAI, Groq, Together, DeepSeek, Mistral, vLLM, Ollama, LM Studio, ...).
//
// Used as System 2 it returns a label. Used as System 1 it also returns a confidence:
//   - from token logprobs when the endpoint returns them (confidence_source = "logprobs"),
//   - else the model's self-reported number (confidence_source = "self_reported").

export function buildRequest({ system, task, text, wantConfidence }) {
  const withConfidence = wantConfidence && system.confidence !== 'none';
  const askLogprobs = wantConfidence && (system.confidence === 'auto' || system.confidence === 'logprobs');
  const askSelf = withConfidence && system.confidence !== 'logprobs';

  const body = {
    model: system.model,
    messages: [{ role: 'user', content: classificationPrompt({ task, text, withConfidence: askSelf }) }],
  };

  if (system.jsonMode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'classification',
        strict: true,
        schema: classificationSchema(task, { withConfidence: askSelf }),
      },
    };
  } else if (system.jsonMode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  if (askLogprobs) body.logprobs = true;
  if (isOpenRouter(system.baseUrl)) body.usage = { include: true };

  Object.assign(body, system.params || {});

  return { url: `${system.baseUrl}/chat/completions`, body };
}

export function parseResponse({ system, task, json, wantConfidence }) {
  const message = json?.choices?.[0]?.message;
  const content = typeof message?.content === 'string' ? message.content : '';
  const parsed = extractJsonObject(content);

  if (!parsed || !isKnownLabel(task, parsed.label)) {
    throw new Error(`${system.role} (${system.model}) returned no usable label. Content: ${content.slice(0, 300)}`);
  }

  const selfReported = wantConfidence ? normalizeSelfReported(parsed.confidence) : null;
  let confidence = null;
  let confidenceSource = null;

  if (wantConfidence && system.confidence !== 'none') {
    const tokens = json?.choices?.[0]?.logprobs?.content;
    const fromLogprobs = system.confidence === 'self' ? null : labelSpanConfidence({ tokens, label: parsed.label });

    if (fromLogprobs !== null) {
      confidence = fromLogprobs;
      confidenceSource = 'logprobs';
    } else if (system.confidence === 'logprobs') {
      throw new Error(
        `${system.role} (${system.model}): confidence=logprobs but the endpoint returned no token logprobs. ` +
          'Use confidence=auto or self.',
      );
    } else if (selfReported !== null) {
      confidence = selfReported;
      confidenceSource = 'self_reported';
    }
  }

  const { cost, cost_source } = resolveCost({ usage: json?.usage, pricing: system.pricing });

  return {
    label: parsed.label,
    confidence,
    confidence_source: confidenceSource,
    self_reported_confidence: selfReported,
    probabilities: null,
    cost,
    cost_source,
    ...tokenCounts(json?.usage),
  };
}

export function headers({ system, auth }) {
  return authHeaders(auth, system.headers);
}
