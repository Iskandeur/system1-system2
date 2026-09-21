import { authHeaders, orFetchJson } from './openrouter.mjs';
import { msNow } from './util.mjs';

export async function fableClassify({ text, model = 'anthropic/claude-fable-5.1' }) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content:
          'Classify this GitHub issue into one label.\n' +
          'Return ONLY strict JSON with {"label": "bug"|"feature"|"docs"}.\n\n' +
          text,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'issue_classification',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', enum: ['bug', 'feature', 'docs'] },
          },
          required: ['label'],
        },
      },
    },
  };

  const t0 = msNow();
  const json = await orFetchJson(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const content = json?.choices?.[0]?.message?.content ?? '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  if (!parsed || !parsed.label) {
    throw new Error('Fable returned non-JSON or missing label: ' + content);
  }

  return {
    json,
    parsed,
    latency_ms: msNow() - t0,
  };
}
