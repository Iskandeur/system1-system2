import { pickHybrid } from './router.mjs';
import { round } from './util.mjs';

// Statistics used by the analyses. Everything here is pure and deterministic (seeded PRNG), so the
// published numbers can be recomputed from the committed predictions.

// Wilson score interval for a binomial proportion.
export function wilson(k, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// Small deterministic PRNG (mulberry32).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit hash of a string; used for deterministic tune/eval splits.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function seededShuffle(items, rng) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Percentile bootstrap CI of a statistic over rows.
export function bootstrapCI(rows, stat, { n = 1000, seed = 42, alpha = 0.05 } = {}) {
  if (!rows.length) return { lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const vals = [];
  for (let b = 0; b < n; b++) {
    const sample = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) sample[i] = rows[Math.floor(rng() * rows.length)];
    vals.push(stat(sample));
  }
  vals.sort((a, b) => a - b);
  const at = (q) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * vals.length)))];
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2) };
}

// ---------- calibration ----------

// rows: [{ confidence: number|null, correct: boolean }]. Equal-width bins on [0, 1].
export function reliability(rows, { bins = 10 } = {}) {
  const usable = rows.filter((r) => typeof r.confidence === 'number' && Number.isFinite(r.confidence));
  const out = [];
  for (let b = 0; b < bins; b++) out.push({ lo: b / bins, hi: (b + 1) / bins, count: 0, sumConf: 0, sumCorrect: 0 });
  for (const r of usable) {
    const idx = Math.min(bins - 1, Math.floor(r.confidence * bins));
    const bin = out[idx];
    bin.count++;
    bin.sumConf += r.confidence;
    bin.sumCorrect += r.correct ? 1 : 0;
  }
  let ece = 0;
  let mce = 0;
  const n = usable.length;
  const result = out.map((b) => {
    const conf = b.count ? b.sumConf / b.count : null;
    const acc = b.count ? b.sumCorrect / b.count : null;
    if (b.count) {
      const gap = Math.abs(acc - conf);
      ece += (b.count / n) * gap;
      mce = Math.max(mce, gap);
    }
    return { lo: b.lo, hi: b.hi, count: b.count, confidence: conf, accuracy: acc };
  });
  return {
    n,
    bins: result,
    ece,
    mce,
    mean_confidence: n ? usable.reduce((a, r) => a + r.confidence, 0) / n : null,
    accuracy: n ? usable.filter((r) => r.correct).length / n : null,
  };
}

export function ece(rows, opts) {
  return reliability(rows, opts).ece;
}

// Brier score of the top-label confidence against correctness.
export function brier(rows) {
  const usable = rows.filter((r) => typeof r.confidence === 'number');
  if (!usable.length) return null;
  return usable.reduce((a, r) => a + (r.confidence - (r.correct ? 1 : 0)) ** 2, 0) / usable.length;
}

// AUROC of confidence as a detector of correct answers (ties get half credit).
export function auroc(rows) {
  const pos = rows.filter((r) => typeof r.confidence === 'number' && r.correct).map((r) => r.confidence);
  const neg = rows.filter((r) => typeof r.confidence === 'number' && !r.correct).map((r) => r.confidence);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

// ---------- hybrid / routing ----------

// pairs: [{ id, truth, s1: { pred, confidence, cost, latency_ms }, s2: { pred, cost, latency_ms } }]
export function hybridRows(pairs, threshold) {
  return pairs.map((x) => {
    const pick = pickHybrid({ s1Label: x.s1.pred, s1Confidence: x.s1.confidence, s2Label: x.s2.pred, threshold });
    const escalated = pick.used === 'system2';
    let cost = null;
    if (typeof x.s1.cost === 'number' && (!escalated || typeof x.s2.cost === 'number')) {
      cost = x.s1.cost + (escalated ? x.s2.cost : 0);
    }
    return {
      id: x.id,
      truth: x.truth,
      pred: pick.label,
      used: pick.used,
      escalated,
      s1_correct: x.s1.pred === x.truth,
      confidence: x.s1.confidence,
      cost,
      latency_ms: (x.s1.latency_ms || 0) + (escalated ? x.s2.latency_ms || 0 : 0),
    };
  });
}

// Summary of a set of prediction rows: [{ truth, pred, cost, latency_ms, escalated? }].
export function summarize(rows) {
  const n = rows.length;
  const correct = rows.filter((r) => r.pred === r.truth).length;
  const known = rows.filter((r) => typeof r.cost === 'number');
  const costTotal = known.reduce((a, r) => a + r.cost, 0);
  const out = {
    n,
    correct,
    accuracy: n ? correct / n : 0,
    accuracy_ci: wilson(correct, n),
    cost_total_usd: costTotal,
    cost_per_1k_usd: known.length ? (costTotal / known.length) * 1000 : null,
    cost_coverage: n ? known.length / n : 0,
    mean_latency_ms: n ? rows.reduce((a, r) => a + (r.latency_ms || 0), 0) / n : 0,
  };
  if (rows.some((r) => r.escalated !== undefined)) {
    const esc = rows.filter((r) => r.escalated);
    const s1Wrong = rows.filter((r) => r.s1_correct === false);
    const s1Right = rows.filter((r) => r.s1_correct === true);
    out.escalation_rate = n ? esc.length / n : 0;
    // How well the gate separates System 1's errors from its correct answers.
    out.error_capture = s1Wrong.length ? s1Wrong.filter((r) => r.escalated).length / s1Wrong.length : null;
    out.waste = s1Right.length ? s1Right.filter((r) => r.escalated).length / s1Right.length : null;
    const kept = rows.filter((r) => !r.escalated);
    out.coverage = n ? kept.length / n : 0;
    out.selective_accuracy = kept.length ? kept.filter((r) => r.s1_correct).length / kept.length : null;
  }
  return out;
}

export function thresholdGrid(step = 0.02) {
  const out = [];
  for (let i = 0; i * step <= 1 + 1e-9; i++) out.push(Math.round(i * step * 1000) / 1000);
  if (out[out.length - 1] !== 1) out.push(1);
  return out;
}

export function sweep(pairs, { step = 0.02, thresholds = thresholdGrid(step) } = {}) {
  return thresholds.map((t) => ({ threshold: t, ...summarize(hybridRows(pairs, t)) }));
}

// Non-dominated points: no other point has (cost <=, accuracy >=) with one strict.
export function paretoFront(points, { x = 'cost_per_1k_usd', y = 'accuracy' } = {}) {
  return points.filter((p, i) =>
    !points.some((q, j) => j !== i && q[x] <= p[x] && q[y] >= p[y] && (q[x] < p[x] || q[y] > p[y])),
  );
}

// Deterministic half split by id: tune (even hash) / eval (odd hash).
export function splitHalves(pairs, seed = 42) {
  const tune = [];
  const evalSet = [];
  for (const p of pairs) (fnv1a(`${seed}:${p.id}`) % 2 === 0 ? tune : evalSet).push(p);
  return { tune, eval: evalSet };
}

// Operating point chosen on the tuning half only. Two rules:
//   'match' – the cheapest threshold whose hybrid accuracy matches or beats System 2 alone on
//             that half (if none does, falls back to 'best');
//   'best'  – the most accurate threshold on that half, cheapest among ties.
export function chooseThreshold(tunePairs, { thresholds = thresholdGrid(0.02), rule = 'match' } = {}) {
  const s2Acc = summarize(tunePairs.map((p) => ({ truth: p.truth, pred: p.s2.pred }))).accuracy;
  const grid = thresholds.map((t) => ({ threshold: t, ...summarize(hybridRows(tunePairs, t)) }));
  const best = () => grid.reduce((a, b) => (b.accuracy > a.accuracy || (b.accuracy === a.accuracy && b.escalation_rate < a.escalation_rate) ? b : a));
  const ok = rule === 'match' ? grid.filter((g) => g.accuracy >= s2Acc) : [];
  let pick;
  let ruleText;
  if (rule === 'match' && ok.length) {
    pick = ok.reduce((a, b) => (b.escalation_rate < a.escalation_rate ? b : a));
    ruleText = 'cheapest threshold matching System 2 accuracy on the tuning half';
  } else {
    pick = best();
    ruleText = rule === 'match' ? 'no threshold matched System 2 on the tuning half; most accurate threshold' : 'most accurate threshold on the tuning half (cheapest among ties)';
  }
  return { threshold: pick.threshold, rule: ruleText, tune_s2_accuracy: s2Acc, tune_hybrid_accuracy: pick.accuracy, tune_escalation_rate: pick.escalation_rate };
}

export function roundDeep(v, digits = 4) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : round(v, digits);
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, digits));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = roundDeep(x, digits);
    return o;
  }
  return v;
}
