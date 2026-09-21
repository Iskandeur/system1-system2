import { clamp01 } from './util.mjs';

// Lenient JSON extraction for chat models that wrap JSON in prose or code fences.
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

// Confidence from token logprobs: probability the model assigned to the exact label string it
// emitted, i.e. exp(sum of logprobs of the tokens that spell the value of "label").
//
// `tokens` is the OpenAI-style `choices[0].logprobs.content` array: [{ token, logprob }, ...].
// Returns null when logprobs are absent or the label span cannot be located.
// Find where the label value sits in the token text.
// 1. Exact: `"label": "<label>"`.
// 2. Fallback: some providers return a partial token list (e.g. CoreWeave's Llama route omits the
//    `label` key tokens and opening quotes), so also accept the label as a standalone JSON value:
//    not preceded by a letter, followed by a quote, comma, brace or end of text.
export function locateLabelSpan(joined, label) {
  const exact = /"label"\s*:\s*"/.exec(joined);
  if (exact) {
    const start = exact.index + exact[0].length;
    if (joined.slice(start, start + label.length) === label) return { start, end: start + label.length };
  }
  let from = 0;
  while (from <= joined.length) {
    const idx = joined.indexOf(label, from);
    if (idx === -1) return null;
    const before = idx === 0 ? '' : joined[idx - 1];
    const after = joined[idx + label.length] ?? '';
    if (!/[A-Za-z_]/.test(before) && (after === '' || /["},\s]/.test(after))) {
      return { start: idx, end: idx + label.length };
    }
    from = idx + 1;
  }
  return null;
}

export function labelSpanConfidence({ tokens, label }) {
  if (!Array.isArray(tokens) || !tokens.length || typeof label !== 'string' || !label) return null;

  const pieces = tokens.map((t) => (typeof t?.token === 'string' ? t.token : ''));
  const joined = pieces.join('');

  const span = locateLabelSpan(joined, label);
  if (!span) return null;
  const { start, end } = span;

  let offset = 0;
  let sum = 0;
  let hit = false;
  for (let i = 0; i < pieces.length; i++) {
    const len = pieces[i].length;
    const tokStart = offset;
    const tokEnd = offset + len;
    offset = tokEnd;
    if (len === 0) continue;
    if (tokEnd <= start || tokStart >= end) continue;
    const lp = Number(tokens[i]?.logprob);
    if (!Number.isFinite(lp)) return null;
    sum += lp;
    hit = true;
  }

  if (!hit) return null;
  return clamp01(Math.exp(sum));
}

export function normalizeSelfReported(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Tolerate models answering in percent (2..100); 1 < n < 2 is just an out-of-range probability.
  if (n >= 2 && n <= 100) return clamp01(n / 100);
  return clamp01(n);
}
