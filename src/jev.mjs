import { authHeaders, orFetchJson } from './openrouter.mjs';
import { msNow } from './util.mjs';

// Jev on OpenRouter is a "decisions" model. It cannot be called via /chat/completions.
// OpenRouter returns a helpful error pointing to /api/alpha/decisions.
export async function jevDecisions({ state, questions, model = 'typesafe/jev-1.13' }) {
  const url = 'https://openrouter.ai/api/alpha/decisions';

  const t0 = msNow();
  const json = await orFetchJson(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model, state, questions }),
  });

  return {
    json,
    latency_ms: msNow() - t0,
  };
}

export function buildIssueClassificationQuestions() {
  return {
    label: {
      type: 'choice',
      instructions:
        'Classify this GitHub issue. Choose the best label for the content.',
      criteria: {
        bug: 'A bug report: something broken, incorrect behavior, crash, error, regression.',
        feature:
          'A feature request or enhancement: new capability, improvement, change request.',
        docs: 'Documentation or question: asking how to use, clarifying behavior, docs updates.',
      },
    },
  };
}
