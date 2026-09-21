// Minimal JSON-over-HTTP helper on top of native fetch (Node >= 22). No dependencies.

export async function fetchJson(
  url,
  { method = 'POST', headers = {}, body, timeoutMs = 120000, fetchImpl = globalThis.fetch } = {},
) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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
      const msg = json?.error?.message ?? json?.error ?? text;
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // keep raw url
      }
      const err = new Error(`HTTP ${res.status} from ${host}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      err.responseText = text;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}
