# System 1 / System 2: Confidence-Gated Hybrid Routing

A small, reproducible demo of a **dual-process** AI architecture, with **pluggable models on both sides**:

- **System 1**: a *fast* model answers first and must produce a **confidence**.
- **System 2**: a *slower, stronger* model is called only when that confidence is below a threshold.
- **Router**: `if (confidence_s1 < threshold) use System 2 else use System 1`.

Defaults (the published results): System 1 = **TypeSafe Jev** (`typesafe/jev-1.13`, a typed-decision model, via OpenRouter’s `/api/alpha/decisions`), System 2 = **Claude Fable 5.1** (`anthropic/claude-fable-5.1`, chat completions via OpenRouter). But any endpoint and any model can take either role: see [Bring your own models](#bring-your-own-models).

Live results page: https://iskandeur.github.io/system1-system2/

## Why this exists

This is a portfolio demo exploring the idea that:

- many product decisions are *structured* (classification / scoring / routing), and
- you don’t need an expensive general LLM for every call.

Instead:

1. ask a cheap, structured “System 1” model first,
2. fall back to a stronger model only when needed.

## Repo structure

- `src/config.mjs` – provider presets + configuration (config file < env vars < CLI flags). Keys are only ever read from environment variables.
- `src/adapters/` – one interface, three transports:
  - `chat-openai.mjs` – any OpenAI-compatible `/chat/completions` endpoint (OpenRouter, OpenAI, Groq, Together, DeepSeek, Mistral, vLLM, Ollama, LM Studio…). Works as System 2 **and** as System 1 (confidence from logprobs or self-reported).
  - `chat-anthropic.mjs` – native Anthropic Messages API (structured output via a forced tool call).
  - `decision.mjs` – TypeSafe “System One” decision API (Jev), through OpenRouter or TypeSafe directly.
- `src/router.mjs` – the confidence gate. `src/task.mjs` – the demo task (issue labels, prompts, schemas). `src/confidence.mjs` – logprob-based confidence and lenient JSON parsing.
- `scripts/build-dataset.mjs` – builds a small labeled dataset from a public GitHub repo.
- `scripts/run-eval.mjs` – runs 3 strategies (System 2 only / System 1 only / Hybrid) + a threshold sweep.
- `scripts/build-docs-assets.mjs` – publishes compact results to `docs/assets/`.
- `test/` – unit tests (`node:test`, mocked `fetch`, no network).
- `docs/` – static GitHub Pages site (renders saved results from `docs/assets/*.json`). No API key ever reaches the browser: the page only replays recorded results.

Zero dependencies. Node ≥ 22 (native `fetch`, `--env-file`).

## Quickstart

### 1) Configure

```bash
cp .env.example .env
# fill OPENROUTER_API_KEY (enough for the default pair)
```

### 2) Build dataset (optional)

A snapshot dataset is committed as `data/dataset.json`. You can rebuild it:

```bash
node scripts/build-dataset.mjs
```

### 3) Run evaluation

```bash
node scripts/run-eval.mjs                 # default pair, whole dataset
node scripts/run-eval.mjs --limit 6       # 6 issues only, spread across the three labels
node scripts/run-eval.mjs --dry-run       # print the resolved configuration (never the key) and exit
node scripts/run-eval.mjs --help
```

This writes `data/results.json` and `data/threshold_sweep.json` (or `data/results.<tag>.json` with `--tag`).

### 4) Publish docs assets

```bash
node scripts/build-docs-assets.mjs              # default run -> docs/assets/results.json
node scripts/build-docs-assets.mjs --tag mytag  # extra run  -> docs/assets/results.mytag.json + docs/assets/runs.json
```

Then push to GitHub; Pages will serve `docs/`.

### 5) Tests

```bash
npm test
```

## Bring your own models

System 1 and System 2 are configured independently. Each one is described by a **provider preset**, a **model id**, and optionally a **base URL**, the **name of the env var holding the key**, extra **headers** and extra **request params**. Precedence: CLI flags > environment variables > `--config` JSON file > preset defaults.

| Preset | Transport | Default base URL | Default key variable |
|---|---|---|---|
| `jev` (default S1) | decision | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` |
| `typesafe` | decision | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` |
| `openrouter` (default S2) | chat | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `openai` | chat | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `groq` / `together` / `deepseek` / `mistral` | chat | vendor `/v1` | `GROQ_API_KEY` / … |
| `ollama` / `lmstudio` / `vllm` | chat | `http://localhost:11434/v1` / `:1234/v1` / `:8000/v1` | none |
| `openai-compatible` | chat | **you must set it** | you name it |
| `anthropic` | anthropic | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |

Per-system settings (`S1_*` / `S2_*` env vars, `--s1-*` / `--s2-*` flags, or `system1` / `system2` objects in the config file):

| Env var | Flag | Config key | Meaning |
|---|---|---|---|
| `S1_PROVIDER` | `--s1-provider` | `provider` | preset name (table above) |
| `S1_MODEL` | `--s1-model` | `model` | model id as the endpoint expects it |
| `S1_BASE_URL` | `--s1-base-url` | `base_url` | override the preset URL |
| `S1_API_KEY_ENV` | `--s1-api-key-env` | `api_key_env` | *name* of the env var that holds the key |
| `S1_HEADERS` | `--s1-headers` | `headers` | JSON object of extra HTTP headers |
| `S1_PARAMS` | `--s1-params` | `params` | JSON object merged into the request body (`temperature`, `max_tokens`, `reasoning`…) |
| `S1_CONFIDENCE` | `--s1-confidence` | `confidence` | `auto` (default) / `logprobs` / `self` / `none` — chat models only |
| `S1_JSON_MODE` | `--s1-json-mode` | `json_mode` | `json_schema` (default) / `json_object` / `none` |
| `S1_PRICE_INPUT_PER_M`, `S1_PRICE_OUTPUT_PER_M` | – | `pricing.input_per_m`, `pricing.output_per_m` | USD per million tokens, for endpoints that don’t report cost |

### Examples

**OpenRouter, two chat models** (a small Llama as System 1, GPT-4o-mini as System 2; this is the pair measured below):

```bash
node scripts/run-eval.mjs \
  --s1-provider openrouter --s1-model meta-llama/llama-3.1-8b-instruct \
  --s2-provider openrouter --s2-model openai/gpt-4o-mini \
  --tag llama8b-gpt4omini
```

**OpenAI** (System 1 on `gpt-4o-mini` with logprob confidence, System 2 on `gpt-4.1`), keys in `OPENAI_API_KEY`:

```bash
S1_PROVIDER=openai S1_MODEL=gpt-4o-mini S1_CONFIDENCE=logprobs \
S2_PROVIDER=openai S2_MODEL=gpt-4.1 \
node scripts/run-eval.mjs
```

**Anthropic native API as System 2** (keep Jev as System 1), with pricing so cost is estimated from token usage:

```bash
S2_PROVIDER=anthropic S2_MODEL=claude-fable-5.1 \
S2_PRICE_INPUT_PER_M=10 S2_PRICE_OUTPUT_PER_M=50 \
node scripts/run-eval.mjs
```

**Local Ollama as System 1** (no key), Claude Fable via OpenRouter as System 2, from a config file:

```json
{
  "system1": { "provider": "ollama", "model": "llama3.2", "confidence": "self", "json_mode": "json_object" },
  "system2": { "provider": "openrouter", "model": "anthropic/claude-fable-5.1" },
  "threshold": 0.4
}
```

```bash
node scripts/run-eval.mjs --config config.json
```

**Any other OpenAI-compatible server** (vLLM behind a gateway that wants a custom header):

```bash
S1_PROVIDER=openai-compatible S1_BASE_URL=https://gpu.example.com/v1 S1_MODEL=Qwen/Qwen2.5-7B-Instruct \
S1_API_KEY_ENV=GATEWAY_TOKEN S1_HEADERS='{"X-Org":"research"}' S1_CONFIDENCE=logprobs \
node scripts/run-eval.mjs
```

See `config.example.json` for the file format.

### How confidence is obtained — and why it matters

The router is only as good as System 1’s confidence. Where it comes from depends on the adapter:

| System 1 kind | `confidence_source` | What it is |
|---|---|---|
| decision (Jev) | `model` | the confidence returned by the decision API (TypeSafe describes calibration over populations of answers, not per answer) |
| chat, endpoint returns logprobs | `logprobs` | the probability the model assigned to the label tokens it emitted: `exp(Σ logprob)` over the value of `"label"` in the JSON output. Requested with `logprobs: true`; OpenAI, Groq, DeepSeek, most Llama/Mistral/Qwen routes on OpenRouter, vLLM and llama.cpp servers return them |
| chat, no logprobs | `self_reported` | the number the model writes in `"confidence"`. **Self-reported confidence is poorly calibrated**: chat models tend to answer 0.8–0.95 whatever the input, so the threshold sweep degenerates to “almost never escalate” or “always escalate”. Fine as a plumbing demo, not as a routing signal. Set `confidence=logprobs` if you want the run to fail rather than silently fall back |
| Anthropic Messages API | `self_reported` | the API returns no logprobs |

With `confidence=none` (or a model that returns neither), the hybrid **always** escalates: an unknown confidence is treated as “not confident”, never as 0 or 1.

Logprob confidence is not a calibrated probability either (the JSON schema constrains the vocabulary, so the mass over the three labels is inflated), but it at least moves with the input. Two practical caveats seen while testing: with `json_mode=json_schema`, some providers apply constrained decoding and omit logprobs for the schema-forced tokens (the Llama route on OpenRouter returned logprobs only for the `confidence` digits), so switch to `json_mode=json_object`; and some providers return a *partial* token list (key tokens and opening quotes missing), which the span finder tolerates as long as the label itself is present.

Cost: OpenRouter reports `usage.cost` per call; other providers report tokens only, so cost is `null` unless you give `pricing`. Summaries publish `cost_coverage` (share of calls with a known cost) so an unknown cost never reads as free.

## Results (measured)

Dataset: **24** recent issues from `cli/cli` with ground-truth labels mapped from GitHub labels:

- `bug` → `bug`
- `enhancement` → `feature`
- `documentation` → `docs`

### Default pair

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

#### OpenRouter budget (credits)

We record the OpenRouter credits endpoint **before** and **after** the evaluation.

- Before: `total_usage = 22.355104048`, `total_credits = 30`
- After:  `total_usage = 22.73211907`,  `total_credits = 30`
- **Delta usage:** `0.377015022` USD for the whole evaluation.

### Other pairs (plumbing check, 6 issues each)

To prove the swap works end to end, two non-default pairs were run on a 6-issue stratified subset (3 `bug`, 3 `feature`) with the exact commands shown in [Examples](#examples). They are published as `docs/assets/results.<tag>.json` and listed under “Other model pairs” on the results page. **n = 6: read them as a smoke test of the plumbing, not as a comparison of models.**

| Run (tag) | System 1 | System 2 | S2 only | S1 only | Hybrid @ 0.40 | Escalation | Cost S2 only → hybrid |
|---|---|---|---:|---:|---:|---:|---:|
| `llama8b-gpt4omini` | `meta-llama/llama-3.1-8b-instruct` (`json_object`, confidence `auto` → 2 items logprobs, 4 self-reported) | `openai/gpt-4o-mini` | 0.8333 (5/6) | 0.6667 (4/6) | 0.6667 (4/6) | 0% | $0.000726 → $0.000158 |
| `gpt4omini-logprobs-mistral` | `openai/gpt-4o-mini` (confidence `logprobs`, strict) | `mistralai/mistral-small-3.2-24b-instruct` | 0.6667 (4/6) | 0.8333 (5/6) | 0.8333 (5/6) | 0% | $0.000720 → $0.001091 |

Measured 2026-09-21 through OpenRouter (`usage.cost` as reported per call). The default Jev + Fable pair was also re-run on 2 items through the new adapters (2/2 for every strategy, S1 cost $0.000068, S2 cost $0.018350) to check that the original path is intact. OpenRouter usage delta for all of these smoke runs together, including reruns: **$0.0242**.

What they show, beyond “the swap works”: **chat-model confidences saturate.** Llama self-reported 0.9–1.0 on every item, including the one it got wrong; GPT-4o-mini’s logprob confidence was ≥ 0.98 on all six, including the one every model disagrees with the GitHub label on. With confidences like that the threshold sweep is flat until 0.95 (never escalate) and then jumps to always escalate, so the hybrid simply inherits System 1’s errors. Jev’s spread-out confidence in the default run is what made a threshold meaningful. Note also that `confidence=auto` can mix sources within one run (the Llama route returned usable logprobs on 2 of 6 responses); per-item `confidence_source` is recorded in the results file, and `confidence=logprobs` or `self` forces one source.

## Notes / limitations — read these before quoting the numbers

- **This is a demonstration, not a benchmark.** With n = 24, one issue is 4.2 points of accuracy. The whole difference between “Jev only” and “Hybrid” is **one issue**: the hybrid escalated exactly one case to Fable, and Fable got it right. A different sample could erase or reverse that gap.
- **The threshold was chosen on the same 24 issues it is evaluated on.** The sweep (`docs/assets/threshold_sweep.json`) is in-sample. Any threshold from 0.30 to 0.55 gives the same single escalation, so the choice is not fragile *here* — but there is no held-out set, so it is not a validated operating point.
- **More escalation is not monotonically better.** Above a threshold of 0.60 accuracy drops back to 0.875: Fable disagrees with the GitHub label on cases Jev had right. On a label set this small and this subjective (bug vs. feature is often a judgment call), a stronger model is not automatically a more *agreeing* one.
- **Confidence calibration is not published by TypeSafe.** Their docs describe calibration over populations of answers, not a per-answer guarantee, so treating `confidence` as a probability of being right is an assumption this demo makes, not something it verified. The same caveat applies, more strongly, to logprob and self-reported confidences from chat models (see above).
- Jev is built for schema-stable structured outputs. It is not a general reasoner; tasks that need counting, date arithmetic or non-English text are out of its documented scope.
- Ground truth is GitHub’s human-assigned labels, which are themselves noisy. **The committed snapshot contains 12 `bug` and 12 `feature` issues and no `docs` issue** (the `documentation` search returned nothing usable at build time), so the third label is never exercised by the published numbers. Every model tested calls the “PGP signing key rotation” announcement (`cli/cli#13118`, labelled `enhancement`) `docs`; that one item is a labelling-noise example, not a model error.
- The `typesafe` preset (TypeSafe’s own endpoint) mirrors the request shape documented in their quickstart but has **not** been exercised with a real key here; only the OpenRouter route to Jev has.

What a real evaluation would add: a few hundred issues from several repositories, a held-out split for choosing the threshold, confidence intervals, and a reliability diagram for each System 1 confidence source.

## Sources

- Kahneman (System 1 / System 2 framing): *Thinking, Fast and Slow*.
- FrugalGPT (cascades / cheap-first strategies): arXiv:2305.05176.
- RouteLLM (learned routing between LLMs): arXiv:2406.18665.
- TypeSafe docs (System One / confidence routing): https://docs.typesafe.ai/
- OpenRouter docs (chat completions): https://openrouter.ai/docs/api-reference/overview
- Anthropic Messages API (tool use for structured output): https://docs.anthropic.com/en/api/messages
