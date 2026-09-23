// Pure functions shared by the playground page (docs/index.html) and the unit tests (test/).
// No DOM, no I/O. An item is:
//   { truth, s1: { pred, conf, cost, ms }, s2: { pred, cost, ms } }
// where conf is System 1's confidence (0..1, or null when unknown), cost is USD per call, ms latency.

// Same rule as src/router.mjs: keep System 1 when its confidence is known and >= t (t < 1);
// t = 0 never escalates a known confidence, t = 1 always escalates.
export function keepsSystem1(conf, threshold) {
  const t = Math.min(1, Math.max(0, Number(threshold) || 0));
  const c = typeof conf === 'number' && Number.isFinite(conf) ? conf : null;
  return c !== null && t < 1 && c >= t;
}

// Per-item view at one threshold.
export function scoreItem(item, threshold) {
  const escalated = !keepsSystem1(item.s1.conf, threshold);
  const hybridPred = escalated ? item.s2.pred : item.s1.pred;
  return {
    escalated,
    s1ok: item.s1.pred === item.truth,
    s2ok: item.s2.pred === item.truth,
    hybridPred,
    hybridOk: hybridPred === item.truth,
    hybridCost: (item.s1.cost || 0) + (escalated ? item.s2.cost || 0 : 0),
    hybridMs: (item.s1.ms || 0) + (escalated ? item.s2.ms || 0 : 0),
  };
}

// Accuracy is over the items whose right answer is known (`labelled`); cost and latency over all.
function summarize(n, labelled, correct, cost, ms, extra = {}) {
  return {
    n,
    labelled,
    correct,
    accuracy: labelled ? correct / labelled : 0,
    cost1k: n ? (cost / n) * 1000 : 0,
    ms: n ? ms / n : 0,
    ...extra,
  };
}

// The three strategies at one threshold: System 1 only, hybrid, System 2 only.
export function strategies(items, threshold) {
  let c1 = 0, c2 = 0, ch = 0, cost1 = 0, cost2 = 0, costh = 0, ms1 = 0, ms2 = 0, msh = 0, esc = 0, labelled = 0;
  for (const it of items) {
    const s = scoreItem(it, threshold);
    if (it.truth !== null && it.truth !== undefined) {
      labelled++;
      if (s.s1ok) c1++;
      if (s.s2ok) c2++;
      if (s.hybridOk) ch++;
    }
    cost1 += it.s1.cost || 0;
    cost2 += it.s2.cost || 0;
    costh += s.hybridCost;
    ms1 += it.s1.ms || 0;
    ms2 += it.s2.ms || 0;
    msh += s.hybridMs;
    if (s.escalated) esc++;
  }
  const n = items.length;
  return {
    s1: summarize(n, labelled, c1, cost1, ms1),
    hybrid: summarize(n, labelled, ch, costh, msh, { escalated: esc, escalationRate: n ? esc / n : 0 }),
    s2: summarize(n, labelled, c2, cost2, ms2),
  };
}

// What a strategy costs per 1,000 items once wrong answers are priced: API cost plus
// (errors per 1,000) x (what one wrong answer costs you). errorCost = 0 is pure API cost.
export function totalCost1k(strategy, errorCost = 0) {
  return strategy.cost1k + (1 - strategy.accuracy) * 1000 * (Number(errorCost) || 0);
}

// The winner is the strategy with the lowest total cost per 1,000 (API + priced mistakes).
// Ties (within a tenth of a cent) go to the more accurate one, then to the cheaper API bill.
export function pickWinner(strats, errorCost = 0) {
  const keys = ['s1', 'hybrid', 's2'];
  const rows = keys.map((k) => ({ key: k, total: totalCost1k(strats[k], errorCost), acc: strats[k].accuracy, cost1k: strats[k].cost1k }));
  rows.sort((a, b) => {
    if (Math.abs(a.total - b.total) > 1e-4) return a.total - b.total;
    if (Math.abs(a.acc - b.acc) > 1e-9) return b.acc - a.acc;
    return a.cost1k - b.cost1k;
  });
  return { key: rows[0].key, ranking: rows };
}

// Threshold sweep for charts: [{ threshold, ...strategies(items, threshold).hybrid }]
export function sweep(items, steps = 50) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = Math.round((i / steps) * 1000) / 1000;
    out.push({ threshold: t, ...strategies(items, t).hybrid });
  }
  return out;
}

function pct(x) {
  return `${Math.round(x * 1000) / 10}%`;
}
function usd(x) {
  return x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`;
}
function ratio(a, b) {
  if (!b || !a) return null;
  const r = a / b;
  return r >= 10 ? `${Math.round(r)}×` : `${Math.round(r * 10) / 10}×`;
}

// One plain sentence a non-specialist can read. names = { s1, s2 } display names.
export function verdict(strats, errorCost = 0, names = { s1: 'Jev', s2: 'the LLM' }) {
  const { key } = pickWinner(strats, errorCost);
  const { s1, s2, hybrid } = strats;
  const dAcc = (a, b) => Math.round((a.accuracy - b.accuracy) * 1000) / 10;

  if (key === 's1') {
    const d = dAcc(s2, s1);
    const how = d <= 0 ? `at least as right as ${names.s2}` : `only ${d} points behind ${names.s2}`;
    return `On this task ${names.s1} alone wins: ${pct(s1.accuracy)} right, ${how}, for ${ratio(s2.cost1k, s1.cost1k) || 'a fraction'} less money and ${ratio(s2.ms, s1.ms) || ''} faster.`;
  }
  if (key === 'hybrid') {
    const d = dAcc(hybrid, s2);
    const acc = d >= 0 ? `as right as ${names.s2}` : `${-d} points behind ${names.s2}`;
    return `On this task the hybrid wins: ${acc} (${pct(hybrid.accuracy)}) while sending only ${pct(hybrid.escalationRate)} of items to ${names.s2}, so it costs ${ratio(s2.cost1k, hybrid.cost1k) || ''} less than ${names.s2} alone and fixes ${Math.max(0, hybrid.correct - s1.correct)} of ${names.s1}'s ${s1.n - s1.correct} mistakes.`;
  }
  const d = dAcc(s2, s1);
  return `On this task ${names.s2} alone wins: ${pct(s2.accuracy)} right against ${pct(s1.accuracy)} for ${names.s1} (${d} points), and ${names.s1}'s confidence does not isolate its mistakes well enough for the hybrid to close the gap cheaply.`;
}

// Cost estimate for a live run: n items, average text length, list prices per million tokens.
export function estimateLiveCost({ n, avgChars, labels = 2, llmInputPerM = 0, llmOutputPerM = 0, jevPerCall = 0.00003 }) {
  const promptTokens = Math.ceil(avgChars / 4) + 60 + labels * 18;
  const llm = (n * (promptTokens * llmInputPerM + 40 * llmOutputPerM)) / 1e6;
  const jev = n * jevPerCall;
  return { jev, llm, total: jev + llm };
}
