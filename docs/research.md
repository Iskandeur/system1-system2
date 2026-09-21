# Research notes — System 1 / System 2 routing (Jev + Claude Fable)

This demo borrows the dual-process framing ("System 1" vs "System 2") and maps it to an engineering architecture:

- route **structured decisions** to a cheap/fast component first,
- then escalate to a more capable (and expensive) LLM when needed.

## Dual-process background

Daniel Kahneman popularized the System 1 / System 2 framing in *Thinking, Fast and Slow* (2011).

In LLM systems, the useful translation is architectural:

- System 1 = fast, narrow, structured outputs (classification / scoring / routing)
- System 2 = slower, general reasoning and language capability

## Cascades / routing for cost-quality tradeoffs

### FrugalGPT

FrugalGPT proposes cheap-first strategies (cascades / early-exit) to reduce cost while keeping performance.

- Paper: *FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance* (arXiv:2305.05176)
  - https://arxiv.org/abs/2305.05176

### RouteLLM

RouteLLM focuses on learning a router from preference data to pick between LLMs.

- Paper: *RouteLLM: Learning to Route LLMs with Preference Data* (arXiv:2406.18665)
  - https://arxiv.org/abs/2406.18665

## TypeSafe "System One" (Jev)

TypeSafe describes System One models as fast, structured decision models for software. Jev answers typed questions (Choice / Score / Noul) against some input `state`.

- Docs index (Mintlify llms.txt): https://docs.typesafe.ai/llms.txt
- Quickstart (shows request/response shape): https://docs.typesafe.ai/introduction/quickstart.md

### Request/response shape (TypeSafe direct API)

From the TypeSafe quickstart:

- `POST https://api.typesafe.ai/v1/systemone`
- body:
  - `state`: string or JSON
  - `model`: e.g. `"jev-latest"`
  - `questions`: typed question map

It returns `answers` with typed shapes (choice / score / noul) and a `confidence` field.

## OpenRouter integration detail: decisions models

OpenRouter exposes Jev as a **decisions model** (`text -> decisions`).

Empirically:

- Calling `typesafe/jev-1.13` via `POST /api/v1/chat/completions` returns an error that it "cannot be used with the chat/completions endpoint" and instructs to use `POST /api/alpha/decisions` instead.
- Calling Jev via `POST https://openrouter.ai/api/alpha/decisions` works and returns:
  - `answers.<key>.choice` and `answers.<key>.confidence` for Choice questions
  - plus `usage.cost` in USD.

OpenRouter docs (chat completions overview):

- https://openrouter.ai/docs/api-reference/overview
