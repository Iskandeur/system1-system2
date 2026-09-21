import { fetchJson } from '../http.mjs';
import { msNow } from '../util.mjs';
import { getApiKey } from '../config.mjs';
import { classificationPrompt, classificationSchema, isKnownLabel } from '../task.mjs';
import { extractJsonObject, labelSpanConfidence, normalizeSelfReported } from '../confidence.mjs';
import { resolveCost, isOpenRouter, bearerHeaders } from './common.mjs';

// "chat" adapter: any OpenAI-compatible /chat/completions endpoint
// (OpenRouter, OpenAI, Groq, Together, DeepSeek, Mistral, vLLM, Ollama, LM Studio, ...).
//
// Used as System 2 it returns a label. Used as System 1 it also returns a confidence:
//   - from token logprobs when the endpoint returns them (confidence_source = "logprobs"),
//   - else the model's self-reported number (confidence_source = "self_reported").

export function buildChatRequest({ system, text, wantConfidence }) {
  const withConfidence = wantConfidence && system.confidence !== 'none';
  const askLogprobs = wantConfidence && (system.confidence === 'auto' || system.confidence === 'logprobs');
  const askSelf = withConfidence && system.confidence !== 'logprobs';

  const body = {
    model: system.model,
    messages: [{ role: 'user', content: classificationPrompt({ text, withConfidence: askSelf }) }],
  };

  if (system.jsonMode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'issue_classification',
        strict: true,
        schema: classificationSchema({ withConfidence: askSelf }),
      },
    };
  } else if (system.jsonMode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  if (askLogprobs) body.logprobs = true;
  if (isOpenRouter(system.baseUrl)) body.usage = { include: true };

  Object.assign(body, system.params || {});

  return {
    url: `${system.baseUrl}/chat/completions`,
    body,
  };
}

export function parseChatResponse({ system, json, wantConfidence }) {
  const message = json?.choices?.[0]?.message;
  const content = typeof message?.content === 'string' ? message.content : '';
  const parsed = extractJsonObject(content);

  if (!parsed || !isKnownLabel(parsed.label)) {
    throw new Error(`${system.role} (${system.model}) returned no usable label. Content: ${content.slice(0, 300)}`);
  }

  const selfReported = wantConfidence ? normalizeSelfReported(parsed.confidence) : null;
  let confidence = null;
  let confidenceSource = null;

  if (wantConfidence && system.confidence !== 'none') {
    const tokens = json?.choices?.[0]?.logprobs?.content;
    const fromLogprobs =
      system.confidence === 'self' ? null : labelSpanConfidence({ tokens, label: parsed.label });

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
    cost,
    cost_source,
    usage: json?.usage ?? null,
  };
}

export function createOpenAIChatAdapter(system, { env = process.env, fetchImpl } = {}) {
  return {
    system,
    async classify({ text, wantConfidence = false }) {
      const apiKey = getApiKey(system, env);
      const { url, body } = buildChatRequest({ system, text, wantConfidence });
      const t0 = msNow();
      const json = await fetchJson(url, {
        method: 'POST',
        headers: bearerHeaders(apiKey, system.headers),
        body,
        timeoutMs: system.timeoutMs,
        fetchImpl,
      });
      const latency_ms = msNow() - t0;
      return { ...parseChatResponse({ system, json, wantConfidence }), latency_ms, raw: json };
    },
  };
}
