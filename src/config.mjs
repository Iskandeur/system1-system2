import fs from 'node:fs';
import path from 'node:path';

// Provider presets. A preset only fills in defaults; any field can be overridden
// (config file < environment < CLI flags).
//
// kind:
//   'chat'      -> OpenAI-compatible POST {base_url}/chat/completions
//   'anthropic' -> Anthropic Messages API POST {base_url}/v1/messages
//   'decision'  -> TypeSafe "System One" decision API (Jev): POST {base_url} with {model, state, questions}
//
// baseUrlEnv / authTokenEnv mirror what the official SDKs read, so a proxy or gateway that sets
// ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (or OPENAI_BASE_URL) works without any flag.
export const PRESETS = {
  jev: {
    kind: 'decision',
    baseUrl: 'https://openrouter.ai/api/alpha/decisions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    model: 'typesafe/jev-1.13',
    description: 'TypeSafe Jev through the OpenRouter decisions endpoint (default System 1)',
  },
  typesafe: {
    kind: 'decision',
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    model: 'jev-latest',
    description: 'TypeSafe native API (same request shape as the OpenRouter decisions endpoint)',
  },
  openrouter: {
    kind: 'chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description: 'Any chat model on OpenRouter (default System 2 = openai/gpt-5.2)',
  },
  openai: { kind: 'chat', baseUrl: 'https://api.openai.com/v1', baseUrlEnv: 'OPENAI_BASE_URL', apiKeyEnv: 'OPENAI_API_KEY' },
  groq: { kind: 'chat', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  together: { kind: 'chat', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
  deepseek: { kind: 'chat', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  mistral: { kind: 'chat', baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY' },
  ollama: { kind: 'chat', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: null },
  lmstudio: { kind: 'chat', baseUrl: 'http://localhost:1234/v1', apiKeyEnv: null },
  vllm: { kind: 'chat', baseUrl: 'http://localhost:8000/v1', apiKeyEnv: null },
  'openai-compatible': {
    kind: 'chat',
    baseUrl: null,
    apiKeyEnv: null,
    description: 'Any other OpenAI-compatible endpoint; base_url is required',
  },
  anthropic: {
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    authTokenEnv: 'ANTHROPIC_AUTH_TOKEN',
    description: 'Anthropic Messages API, or any Anthropic-compatible endpoint (honours ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)',
  },
};

export const ROLES = ['system1', 'system2'];
export const ROLE_PREFIX = { system1: 'S1', system2: 'S2' };

export const DEFAULT_THRESHOLD = 0.4;

export const DEFAULTS = {
  system1: { provider: 'jev' },
  system2: { provider: 'openrouter', model: 'openai/gpt-5.2' },
};

const CONFIDENCE_MODES = ['auto', 'logprobs', 'self', 'none'];
const JSON_MODES = ['json_schema', 'json_object', 'none'];

// ---------- CLI ----------

// Tiny argv parser: --key value, --key=value, --flag (boolean). Returns { flags, positionals }.
// A repeated flag collects into an array.
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const put = (k, v) => {
    if (flags[k] === undefined) flags[k] = v;
    else flags[k] = [].concat(flags[k], v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      put(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      put(body, next);
      i++;
    } else {
      put(body, true);
    }
  }
  return { flags, positionals };
}

// ---------- layers ----------

function parseJsonField(raw, what) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (e) {
    throw new Error(`${what} must be a JSON object, got: ${String(raw).slice(0, 80)} (${e.message})`);
  }
}

function numberOrUndefined(v, what) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number, got: ${v}`);
  return n;
}

// Normalize one system section from the config file (snake_case keys).
export function normalizeFileSystem(section, role) {
  if (!section) return {};
  if (typeof section !== 'object') throw new Error(`config.${role} must be an object`);
  const out = {};
  if (section.provider !== undefined) out.provider = String(section.provider);
  if (section.model !== undefined) out.model = String(section.model);
  if (section.base_url !== undefined) out.baseUrl = String(section.base_url);
  if (section.api_key_env !== undefined) out.apiKeyEnv = section.api_key_env === null ? null : String(section.api_key_env);
  if (section.headers !== undefined) out.headers = parseJsonField(section.headers, `config.${role}.headers`);
  if (section.params !== undefined) out.params = parseJsonField(section.params, `config.${role}.params`);
  if (section.confidence !== undefined) out.confidence = String(section.confidence);
  if (section.json_mode !== undefined) out.jsonMode = String(section.json_mode);
  if (section.timeout_ms !== undefined) out.timeoutMs = numberOrUndefined(section.timeout_ms, `config.${role}.timeout_ms`);
  if (section.pricing !== undefined && section.pricing !== null) {
    out.pricing = {
      inputPerM: numberOrUndefined(section.pricing.input_per_m, `config.${role}.pricing.input_per_m`),
      outputPerM: numberOrUndefined(section.pricing.output_per_m, `config.${role}.pricing.output_per_m`),
    };
  }
  return out;
}

export function envLayer(role, env) {
  const p = ROLE_PREFIX[role];
  const get = (k) => {
    const v = env[`${p}_${k}`];
    return v === undefined || v === '' ? undefined : v;
  };
  const out = {};
  if (get('PROVIDER')) out.provider = get('PROVIDER');
  if (get('MODEL')) out.model = get('MODEL');
  if (get('BASE_URL')) out.baseUrl = get('BASE_URL');
  if (get('API_KEY_ENV')) out.apiKeyEnv = get('API_KEY_ENV');
  if (get('API_KEY')) out.apiKey = get('API_KEY');
  if (get('HEADERS')) out.headers = parseJsonField(get('HEADERS'), `${p}_HEADERS`);
  if (get('PARAMS')) out.params = parseJsonField(get('PARAMS'), `${p}_PARAMS`);
  if (get('CONFIDENCE')) out.confidence = get('CONFIDENCE');
  if (get('JSON_MODE')) out.jsonMode = get('JSON_MODE');
  if (get('TIMEOUT_MS')) out.timeoutMs = numberOrUndefined(get('TIMEOUT_MS'), `${p}_TIMEOUT_MS`);
  const pin = get('PRICE_INPUT_PER_M');
  const pout = get('PRICE_OUTPUT_PER_M');
  if (pin !== undefined || pout !== undefined) {
    out.pricing = {
      inputPerM: numberOrUndefined(pin, `${p}_PRICE_INPUT_PER_M`),
      outputPerM: numberOrUndefined(pout, `${p}_PRICE_OUTPUT_PER_M`),
    };
  }
  return out;
}

export function cliLayer(role, flags) {
  const p = role === 'system1' ? 's1' : 's2';
  const get = (k) => {
    const v = flags[`${p}-${k}`];
    return v === undefined || v === true || v === '' ? undefined : String(v);
  };
  const out = {};
  if (get('provider')) out.provider = get('provider');
  if (get('model')) out.model = get('model');
  if (get('base-url')) out.baseUrl = get('base-url');
  if (get('api-key-env')) out.apiKeyEnv = get('api-key-env');
  if (get('headers')) out.headers = parseJsonField(get('headers'), `--${p}-headers`);
  if (get('params')) out.params = parseJsonField(get('params'), `--${p}-params`);
  if (get('confidence')) out.confidence = get('confidence');
  if (get('json-mode')) out.jsonMode = get('json-mode');
  if (get('timeout-ms')) out.timeoutMs = numberOrUndefined(get('timeout-ms'), `--${p}-timeout-ms`);
  return out;
}

export function loadConfigFile(file) {
  if (!file) return {};
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new Error(`Config file not found: ${p}`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Config file ${p} is not valid JSON: ${e.message}`);
  }
  if (!json || typeof json !== 'object') throw new Error(`Config file ${p} must contain a JSON object`);
  return json;
}

// ---------- resolution ----------

function mergeLayers(...layers) {
  const out = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer || {})) {
      if (v === undefined) continue;
      if (k === 'headers' || k === 'params') {
        out[k] = { ...(out[k] || {}), ...v };
      } else if (k === 'pricing') {
        out.pricing = { ...(out.pricing || {}), ...v };
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

export function resolveSystem(role, { layers, env = {} }) {
  const merged = mergeLayers(...layers);
  const provider = merged.provider ?? DEFAULTS[role].provider;
  const preset = PRESETS[provider];
  if (!preset) {
    throw new Error(
      `Unknown provider "${provider}" for ${role}. Known presets: ${Object.keys(PRESETS).join(', ')}`,
    );
  }

  const kind = preset.kind;
  const envBase = preset.baseUrlEnv && env[preset.baseUrlEnv] ? env[preset.baseUrlEnv] : undefined;
  const baseUrl = (merged.baseUrl ?? envBase ?? preset.baseUrl) || null;
  const model = merged.model ?? preset.model ?? null;
  const apiKeyEnv = merged.apiKeyEnv !== undefined ? merged.apiKeyEnv : preset.apiKeyEnv;

  if (!baseUrl) throw new Error(`${role}: provider "${provider}" needs base_url (set ${ROLE_PREFIX[role]}_BASE_URL)`);
  if (!model) throw new Error(`${role}: provider "${provider}" needs a model id (set ${ROLE_PREFIX[role]}_MODEL)`);

  const confidence = merged.confidence ?? (kind === 'decision' ? 'model' : 'auto');
  if (kind !== 'decision' && !CONFIDENCE_MODES.includes(confidence)) {
    throw new Error(`${role}: confidence must be one of ${CONFIDENCE_MODES.join('|')}, got "${confidence}"`);
  }
  const jsonMode = merged.jsonMode ?? 'json_schema';
  if (!JSON_MODES.includes(jsonMode)) {
    throw new Error(`${role}: json_mode must be one of ${JSON_MODES.join('|')}, got "${jsonMode}"`);
  }

  const pricing =
    merged.pricing && (merged.pricing.inputPerM !== undefined || merged.pricing.outputPerM !== undefined)
      ? { inputPerM: merged.pricing.inputPerM ?? 0, outputPerM: merged.pricing.outputPerM ?? 0, source: 'configured' }
      : null;

  return {
    role,
    provider,
    kind,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKeyEnv: apiKeyEnv ?? null,
    authTokenEnv: preset.authTokenEnv ?? null,
    apiKey: merged.apiKey ?? null,
    headers: merged.headers ?? {},
    params: merged.params ?? {},
    confidence,
    jsonMode,
    pricing,
    timeoutMs: merged.timeoutMs ?? 120000,
  };
}

export function resolveRunConfig({ argv = [], env = process.env, file } = {}) {
  const { flags } = parseArgs(argv);
  const configPath = flags.config ?? env.S1S2_CONFIG ?? file ?? null;
  const fileJson = configPath ? loadConfigFile(configPath) : {};

  const systems = {};
  for (const role of ROLES) {
    systems[role] = resolveSystem(role, {
      layers: [DEFAULTS[role], normalizeFileSystem(fileJson[role], role), envLayer(role, env), cliLayer(role, flags)],
      env,
    });
  }

  const thresholdRaw = flags.threshold ?? env.HYBRID_CONFIDENCE_THRESHOLD ?? fileJson.threshold;
  const threshold =
    thresholdRaw === undefined || thresholdRaw === '' || thresholdRaw === true
      ? DEFAULT_THRESHOLD
      : numberOrUndefined(thresholdRaw, 'threshold');

  const limitRaw = flags.limit ?? env.EVAL_LIMIT;
  const limit = limitRaw === undefined || limitRaw === true || limitRaw === '' ? null : Number(limitRaw);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error(`--limit must be a positive integer`);

  const tagRaw = flags.tag ?? env.EVAL_TAG;
  const tag = tagRaw && tagRaw !== true ? String(tagRaw) : null;
  if (tag && !/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) throw new Error(`--tag must match [a-z0-9._-]+, got "${tag}"`);

  const dataset = flags.dataset && flags.dataset !== true ? String(flags.dataset) : env.EVAL_DATASET || 'massive-en';

  return {
    system1: systems.system1,
    system2: systems.system2,
    threshold,
    limit,
    tag,
    dataset,
    configFile: configPath ? path.resolve(configPath) : null,
    dryRun: flags['dry-run'] === true || flags['dry-run'] === 'true',
    help: flags.help === true,
    flags,
  };
}

// How to authenticate a system: { scheme: 'bearer' | 'x-api-key', key } or null for keyless
// local servers. Anthropic-style endpoints take ANTHROPIC_API_KEY as x-api-key or
// ANTHROPIC_AUTH_TOKEN as a bearer token, like the official SDK.
export function resolveAuth(system, env = process.env) {
  const defaultScheme = system.kind === 'anthropic' ? 'x-api-key' : 'bearer';
  if (system.apiKey) return { scheme: defaultScheme, key: system.apiKey };
  if (system.apiKeyEnv && env[system.apiKeyEnv]) return { scheme: defaultScheme, key: env[system.apiKeyEnv] };
  if (system.authTokenEnv && env[system.authTokenEnv]) return { scheme: 'bearer', key: env[system.authTokenEnv] };
  if (!system.apiKeyEnv && !system.authTokenEnv) return null;
  const names = [system.apiKeyEnv, system.authTokenEnv].filter(Boolean).join(' or ');
  throw new Error(
    `${system.role}: API key missing. Set ${names} in your environment or .env ` +
      `(provider "${system.provider}"), or point ${ROLE_PREFIX[system.role]}_API_KEY_ENV at another variable.`,
  );
}

// Back-compat helper: the key alone (null when the provider needs none).
export function getApiKey(system, env = process.env) {
  return resolveAuth(system, env)?.key ?? null;
}

// Fill in pricing from a public list-price table when the provider reports no cost and the user
// configured none. Keys are matched on the full model id, then on its last path segment.
export function applyListPrices(system, prices) {
  if (system.pricing || !prices?.models) return system;
  const id = String(system.model);
  const short = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const entry = prices.models[id] ?? prices.models[short];
  if (!entry) return system;
  system.pricing = { inputPerM: Number(entry.input) || 0, outputPerM: Number(entry.output) || 0, source: 'list' };
  return system;
}

// What we are allowed to write into results files and logs: never a key, never header values.
export function publicSystem(system) {
  return {
    provider: system.provider,
    kind: system.kind,
    model: system.model,
    base_url: system.baseUrl,
    api_key_env: system.apiKeyEnv,
    confidence: system.confidence,
    json_mode: system.kind === 'decision' ? undefined : system.jsonMode,
    extra_headers: Object.keys(system.headers || {}),
    params: system.params && Object.keys(system.params).length ? system.params : undefined,
    pricing: system.pricing
      ? { input_per_m: system.pricing.inputPerM, output_per_m: system.pricing.outputPerM, source: system.pricing.source }
      : undefined,
  };
}

export function helpText() {
  return `Usage: node scripts/run-eval.mjs [options]

Options (each also has an env var; CLI > env > config file > preset defaults):
  --dataset <name|file>      Dataset in data/<name>.json (env: EVAL_DATASET). Default: massive-en
  --config <file>            JSON config file (env: S1S2_CONFIG). See config.example.json
  --s1-provider <name>       System 1 preset (env: S1_PROVIDER). Default: jev
  --s1-model <id>            System 1 model id (env: S1_MODEL)
  --s1-base-url <url>        System 1 base URL (env: S1_BASE_URL)
  --s1-api-key-env <VAR>     Env var holding the System 1 key (env: S1_API_KEY_ENV)
  --s1-headers '<json>'      Extra HTTP headers (env: S1_HEADERS)
  --s1-params '<json>'       Extra request body fields, e.g. {"temperature":0} (env: S1_PARAMS)
  --s1-confidence <mode>     auto|logprobs|self|none for chat System 1 (env: S1_CONFIDENCE)
  --s1-json-mode <mode>      json_schema|json_object|none (env: S1_JSON_MODE)
  --s2-...                   Same options for System 2 (env: S2_*)
  --threshold <0..1>         Escalation threshold (env: HYBRID_CONFIDENCE_THRESHOLD). Default 0.4
  --limit <n>                Only evaluate n dataset items, spread across labels (env: EVAL_LIMIT)
  --tag <name>               Name the predictions files (default: derived from the model ids)
  --defense none|hardened    Prompt-level injection defense (default none)
  --no-cache                 Do not read or write .cache/responses
  --dry-run                  Print the resolved configuration (no key) and exit
  --help

Presets: ${Object.keys(PRESETS).join(', ')}
`;
}
