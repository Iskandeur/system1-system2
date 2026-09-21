import { createOpenAIChatAdapter } from './chat-openai.mjs';
import { createAnthropicAdapter } from './chat-anthropic.mjs';
import { createDecisionAdapter } from './decision.mjs';

// Every adapter exposes the same surface:
//   adapter.classify({ text, wantConfidence }) -> {
//     label, confidence (0..1 | null), confidence_source ('model'|'logprobs'|'self_reported'|null),
//     self_reported_confidence, cost (USD | null), cost_source, usage, latency_ms, raw }
export function createAdapter(system, opts = {}) {
  switch (system.kind) {
    case 'chat':
      return createOpenAIChatAdapter(system, opts);
    case 'anthropic':
      return createAnthropicAdapter(system, opts);
    case 'decision':
      return createDecisionAdapter(system, opts);
    default:
      throw new Error(`Unknown adapter kind: ${system.kind}`);
  }
}
