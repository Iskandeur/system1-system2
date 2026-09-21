import { msNow } from './util.mjs';

export function getOpenRouterKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_API_KEY is missing. Copy .env.example to .env and fill it.');
  }
  return key;
}

export async function orFetchJson(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 120000 } = {},
) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg = json?.error?.message ? json.error.message : text;
      const err = new Error(`OpenRouter HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      err.responseText = text;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

export function authHeaders() {
  return {
    Authorization: 'Bearer ' + getOpenRouterKey(),
    'Content-Type': 'application/json',
  };
}

export function withTiming(fn) {
  return async (...args) => {
    const t0 = msNow();
    const out = await fn(...args);
    return { ...out, latency_ms: msNow() - t0 };
  };
}
