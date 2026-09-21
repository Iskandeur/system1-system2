export function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'system1-system2-demo',
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }

  return headers;
}

export async function ghFetchJson(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(`GitHub HTTP ${res.status}: ${text}`);
  }

  return json;
}
