// The demo task: classify a GitHub issue into one of three labels.
// Everything task-specific (labels, criteria, prompts, schemas) lives here so the adapters stay generic.

export const LABELS = ['bug', 'feature', 'docs'];

export const LABEL_CRITERIA = {
  bug: 'A bug report: something broken, incorrect behavior, crash, error, regression.',
  feature: 'A feature request or enhancement: new capability, improvement, change request.',
  docs: 'Documentation or question: asking how to use, clarifying behavior, docs updates.',
};

export function issueText(item) {
  const body = item.body ? `\n\n${item.body}` : '';
  return `Title: ${item.title}${body}`;
}

// Typed question map for "decision" models (TypeSafe Jev). Unchanged from the original demo.
export function decisionQuestions() {
  return {
    label: {
      type: 'choice',
      instructions: 'Classify this GitHub issue. Choose the best label for the content.',
      criteria: { ...LABEL_CRITERIA },
    },
  };
}

// Prompt for chat models. With withConfidence=false this is byte-for-byte the prompt used by the
// original System 2 (Claude Fable) run, so default results stay reproducible.
export function classificationPrompt({ text, withConfidence = false }) {
  const enumText = LABELS.map((l) => JSON.stringify(l)).join('|');
  if (!withConfidence) {
    return (
      'Classify this GitHub issue into one label.\n' +
      `Return ONLY strict JSON with {"label": ${enumText}}.\n\n` +
      text
    );
  }
  return (
    'Classify this GitHub issue into one label.\n' +
    `Return ONLY strict JSON with {"label": ${enumText}, "confidence": <number between 0 and 1>}.\n` +
    '"confidence" is your own estimate of the probability that the label is correct.\n\n' +
    text
  );
}

// JSON schema for structured outputs (OpenAI-style response_format / Anthropic tool input_schema).
export function classificationSchema({ withConfidence = false } = {}) {
  const properties = { label: { type: 'string', enum: [...LABELS] } };
  const required = ['label'];
  if (withConfidence) {
    properties.confidence = { type: 'number', minimum: 0, maximum: 1 };
    required.push('confidence');
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

export function isKnownLabel(label) {
  return typeof label === 'string' && LABELS.includes(label);
}

// `--limit n` subset: round-robin across ground-truth labels, keeping dataset order within a label.
// The committed dataset is grouped by label, so "first n" would be all bugs.
export function stratifiedSubset(items, n) {
  if (!n || n >= items.length) return items.slice();
  const buckets = new Map();
  for (const it of items) {
    const k = it.truth ?? '';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  const out = [];
  const queues = [...buckets.values()];
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (out.length >= n) break;
      if (q.length) out.push(q.shift());
    }
  }
  return out;
}
