import { clamp01 } from './util.mjs';

export function envNumber(name, fallback, env = process.env) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Confidence-gated routing. System 1 answers first; if its confidence is below the threshold
// (or unknown), the System 2 answer is used instead.
//
// The two ends of the threshold range are the two pure strategies: t = 0 never escalates a known
// confidence, t = 1 always escalates (a confidence of exactly 1.0 is still "below the bar"), so a
// sweep from 0 to 1 runs from System 1 only to System 2 only.
export function pickHybrid({ s1Label, s1Confidence, s2Label, threshold }) {
  const t = clamp01(threshold);
  const c = typeof s1Confidence === 'number' && Number.isFinite(s1Confidence) ? s1Confidence : null;
  if (c !== null && t < 1 && c >= t) {
    return { label: s1Label, used: 'system1' };
  }
  return { label: s2Label, used: 'system2' };
}
