import { clamp01 } from './util.mjs';

export function envNumber(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function pickHybrid({ jevLabel, jevConfidence, fableLabel, threshold }) {
  const t = clamp01(threshold);
  if (jevConfidence >= t) {
    return { label: jevLabel, used: 'jev' };
  }

  return { label: fableLabel, used: 'fable' };
}
