export function msNow() {
  return Date.now();
}

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function round(n, digits = 3) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function readJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function assertNever(x, msg = 'Unexpected value') {
  throw new Error(msg + ': ' + String(x));
}
