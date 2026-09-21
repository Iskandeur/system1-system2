// Minimal JSON-over-HTTP helper on top of native fetch (Node >= 22). No dependencies.
// Transient failures (429, 5xx, network) are retried with exponential backoff, honouring
// Retry-After. Everything else throws once, with the status and host but never the key.

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function retryDelayMs({ attempt, backoffMs, retryAfter, jitter = Math.random }) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 120000);
  return Math.min(backoffMs * 2 ** attempt + Math.floor(jitter() * 250), 60000);
}

export async function fetchJson(
  url,
  {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 120000,
    fetchImpl = globalThis.fetch,
    retries = 4,
    backoffMs = 1500,
    sleep = defaultSleep,
    onRetry,
  } = {},
) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep raw url
  }
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, { method, headers, body: payload, signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      clearTimeout(timeout);
      if (attempt < retries) {
        const delay = retryDelayMs({ attempt, backoffMs });
        onRetry?.({ attempt: attempt + 1, delay, reason: e?.name === 'AbortError' ? 'timeout' : 'network' });
        await sleep(delay);
        continue;
      }
      const err = new Error(`${e?.name === 'AbortError' ? 'Timeout' : 'Network error'} calling ${host}: ${e?.message ?? e}`);
      err.cause = e;
      throw err;
    }
    clearTimeout(timeout);

    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (res.ok) return json;

    if (RETRYABLE.has(res.status) && attempt < retries) {
      const retryAfter = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
      const delay = retryDelayMs({ attempt, backoffMs, retryAfter });
      onRetry?.({ attempt: attempt + 1, delay, reason: `HTTP ${res.status}` });
      await sleep(delay);
      continue;
    }

    const msg = json?.error?.message ?? json?.error ?? text;
    const err = new Error(`HTTP ${res.status} from ${host}: ${typeof msg === 'string' ? msg.slice(0, 500) : JSON.stringify(msg).slice(0, 500)}`);
    err.status = res.status;
    err.responseText = text;
    throw err;
  }
}
