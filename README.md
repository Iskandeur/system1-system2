# System 1 / System 2: Confidence-Gated Hybrid Routing (Jev + Claude Fable)

A small, reproducible demo of a **dual-process** AI architecture:

- **System 1**: *fast, structured decisions* using **TypeSafe Jev** via OpenRouter’s **/api/alpha/decisions** endpoint.
- **System 2**: *slower, more general reasoning* using **Claude Fable 5.1** (chat completions).
- **Router**: confidence-gated: if Jev’s `confidence < threshold`, we escalate to Fable.

Live results page: https://iskandeur.github.io/system1-system2/

## Why this exists

This is a portfolio demo exploring the idea that:

- many product decisions are *structured* (classification / scoring / routing), and
- you don’t need an expensive general LLM for every call.

Instead:

1. ask a cheap, structured “System 1” model first,
2. fall back to a stronger model only when needed.

## Repo structure

- `src/` – OpenRouter clients + routing logic.
- `scripts/build-dataset.mjs` – builds a small labeled dataset from a public GitHub repo.
- `scripts/run-eval.mjs` – runs 3 strategies (Fable-only / Jev-only / Hybrid) + threshold sweep.
- `docs/` – static GitHub Pages site (renders saved results from `docs/assets/*.json`). No API key ever reaches the browser: the page only replays recorded results.

## Quickstart

### 1) Install

```bash
npm install # (no deps; this is mostly a convenience)
```

### 2) Configure

```bash
cp .env.example .env
# fill OPENROUTER_API_KEY
```

### 3) Build dataset (optional)

A snapshot dataset is committed as `data/dataset.json`. You can rebuild it:

```bash
node scripts/build-dataset.mjs
```

### 4) Run evaluation

```bash
node scripts/run-eval.mjs
```

This writes:

- `data/results.json`
- `data/threshold_sweep.json`

### 5) Publish docs assets

```bash
node scripts/build-docs-assets.mjs
```

Then push to GitHub; Pages will serve `docs/`.

## Results (measured)

Dataset: **24** recent issues from `cli/cli` with ground-truth labels mapped from GitHub labels:

- `bug` → `bug`
- `enhancement` → `feature`
- `documentation` → `docs`

Models:

- System 1: `typesafe/jev-1.13` (OpenRouter decisions)
- System 2: `anthropic/claude-fable-5.1` (OpenRouter chat completions)

Measured (2026-09-21):

| Strategy | Accuracy | Total cost (USD) | Mean latency (ms) | Escalation |
|---|---:|---:|---:|---:|
| Fable only | 0.9167 (22/24) | 0.375810 | 3949.8 | – |
| Jev only | 0.8750 (21/24) | 0.001205 | 319.0 | 0% |
| Hybrid (threshold=0.40) | 0.9167 (22/24) | 0.007915 | 458.0 | 4.17% (1/24) |

On this run the hybrid matched Fable-only accuracy at roughly **1/47 of the cost** and **1/8.6 of the latency**.

### OpenRouter budget (credits)

We record the OpenRouter credits endpoint **before** and **after** the evaluation.

- Before: `total_usage = 22.355104048`, `total_credits = 30`
- After:  `total_usage = 22.73211907`,  `total_credits = 30`
- **Delta usage:** `0.377015022` USD for the whole evaluation.

## Notes / limitations — read these before quoting the numbers

- **This is a demonstration, not a benchmark.** With n = 24, one issue is 4.2 points of accuracy. The whole difference between “Jev only” and “Hybrid” is **one issue**: the hybrid escalated exactly one case to Fable, and Fable got it right. A different sample could erase or reverse that gap.
- **The threshold was chosen on the same 24 issues it is evaluated on.** The sweep (`docs/assets/threshold_sweep.json`) is in-sample. Any threshold from 0.30 to 0.55 gives the same single escalation, so the choice is not fragile *here* — but there is no held-out set, so it is not a validated operating point.
- **More escalation is not monotonically better.** Above a threshold of 0.60 accuracy drops back to 0.875: Fable disagrees with the GitHub label on cases Jev had right. On a label set this small and this subjective (bug vs. feature is often a judgment call), a stronger model is not automatically a more *agreeing* one.
- **Confidence calibration is not published by TypeSafe.** Their docs describe calibration over populations of answers, not a per-answer guarantee, so treating `confidence` as a probability of being right is an assumption this demo makes, not something it verified.
- Jev is built for schema-stable structured outputs. It is not a general reasoner; tasks that need counting, date arithmetic or non-English text are out of its documented scope.
- Ground truth is GitHub’s human-assigned labels, which are themselves noisy.

What a real evaluation would add: a few hundred issues from several repositories, a held-out split for choosing the threshold, confidence intervals, and a reliability diagram for Jev’s confidence.

## Sources

- Kahneman (System 1 / System 2 framing): *Thinking, Fast and Slow*.
- FrugalGPT (cascades / cheap-first strategies): arXiv:2305.05176.
- RouteLLM (learned routing between LLMs): arXiv:2406.18665.
- TypeSafe docs (System One / confidence routing): https://docs.typesafe.ai/
- OpenRouter docs (chat completions): https://openrouter.ai/docs/api-reference/overview
