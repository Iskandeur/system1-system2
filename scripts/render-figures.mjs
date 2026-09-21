import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/config.mjs';
import { inProject } from './paths.mjs';

// Renders docs/assets/hero.svg from docs/assets/results/<dataset>.json: the reliability diagram of
// every System 1 on the left, the accuracy/cost frontier of the first hybrid on the right. Pure
// string SVG, no dependencies, deterministic.
//
//   node scripts/render-figures.mjs --dataset massive-en --s1 jev --s2 gpt-5.2

const W = 1100;
const H = 460;
const FONT = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
const COLORS = ['#2563eb', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (n, d = 1) => Number(n).toFixed(d);

function reliabilityPanel(results, s1Tags, { x, y, w, h }) {
  const px = x + 52;
  const py = y + 34;
  const pw = w - 70;
  const ph = h - 84;
  const sx = (v) => px + v * pw;
  const sy = (v) => py + ph - v * ph;
  let out = `<text x="${x + 8}" y="${y + 16}" font-size="15" font-weight="600" fill="#111827">Reliability diagram (System 1 confidence vs. accuracy)</text>`;
  // grid + diagonal
  for (let i = 0; i <= 10; i += 2) {
    out += `<line x1="${sx(0)}" y1="${sy(i / 10)}" x2="${sx(1)}" y2="${sy(i / 10)}" stroke="#e5e7eb"/>`;
    out += `<text x="${px - 8}" y="${sy(i / 10) + 4}" font-size="11" text-anchor="end" fill="#6b7280">${i * 10}%</text>`;
    out += `<text x="${sx(i / 10)}" y="${py + ph + 16}" font-size="11" text-anchor="middle" fill="#6b7280">${f(i / 10, 1)}</text>`;
  }
  out += `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(1)}" stroke="#9ca3af" stroke-dasharray="4 4"/>`;
  out += `<text x="${px + pw / 2}" y="${py + ph + 32}" font-size="11" text-anchor="middle" fill="#6b7280">confidence</text>`;
  out += `<text transform="translate(${x + 14},${py + ph / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#6b7280">accuracy in bin</text>`;
  s1Tags.forEach((tag, k) => {
    const s = results.systems[tag];
    if (!s?.calibration) return;
    const color = COLORS[k % COLORS.length];
    const bins = s.calibration.bins;
    const bw = pw / bins.length;
    bins.forEach((b, i) => {
      if (!b.count) return;
      const cx = sx((b.lo + b.hi) / 2) + (k - (s1Tags.length - 1) / 2) * 6;
      const r = 3 + Math.min(7, Math.sqrt(b.count));
      out += `<line x1="${cx}" y1="${sy(0)}" x2="${cx}" y2="${sy(b.accuracy)}" stroke="${color}" stroke-opacity="0.25" stroke-width="${Math.max(2, bw * 0.3)}"/>`;
      out += `<circle cx="${cx}" cy="${sy(b.accuracy)}" r="${r}" fill="${color}" fill-opacity="0.9"><title>${esc(tag)} bin ${f(b.lo, 1)}–${f(b.hi, 1)}: n=${b.count}, acc ${f(b.accuracy * 100)}%</title></circle>`;
    });
    const ly = y + h - 8 - (s1Tags.length - 1 - k) * 16;
    out += `<circle cx="${x + 16}" cy="${ly - 4}" r="5" fill="${color}"/>`;
    out += `<text x="${x + 26}" y="${ly}" font-size="12" fill="#111827">${esc(s.model)} (${esc(s.confidence_sources?.join('/') ?? '')}) — ECE ${f(s.calibration.ece * 100)}% [${f(s.calibration.ece_ci.lo * 100)}, ${f(s.calibration.ece_ci.hi * 100)}], n=${s.calibration.n}</text>`;
  });
  return out;
}

function frontierPanel(results, hybrid, { x, y, w, h }) {
  const px = x + 56;
  const py = y + 34;
  const pw = w - 76;
  const ph = h - 84;
  const pts = hybrid.sweep.filter((p) => typeof p.cost_per_1k_usd === 'number');
  const s1 = hybrid.system1_only;
  const s2 = hybrid.system2_only;
  const costs = [...pts.map((p) => p.cost_per_1k_usd), s1.cost_per_1k_usd, s2.cost_per_1k_usd].filter((c) => c > 0);
  const minC = Math.min(...costs) / 1.5;
  const maxC = Math.max(...costs) * 1.5;
  const accs = [...pts.map((p) => p.accuracy), s1.accuracy, s2.accuracy];
  const minA = Math.max(0, Math.floor((Math.min(...accs) - 0.03) * 20) / 20);
  const maxA = Math.min(1, Math.ceil((Math.max(...accs) + 0.02) * 20) / 20);
  const sx = (c) => px + ((Math.log10(Math.max(c, minC)) - Math.log10(minC)) / (Math.log10(maxC) - Math.log10(minC))) * pw;
  const sy = (a) => py + ph - ((a - minA) / (maxA - minA)) * ph;
  let out = `<text x="${x + 8}" y="${y + 16}" font-size="15" font-weight="600" fill="#111827">Accuracy vs. cost as the threshold sweeps (${esc(results.systems[hybrid.s1].model)} → ${esc(results.systems[hybrid.s2].model)})</text>`;
  for (let a = minA; a <= maxA + 1e-9; a += 0.05) {
    out += `<line x1="${px}" y1="${sy(a)}" x2="${px + pw}" y2="${sy(a)}" stroke="#e5e7eb"/>`;
    out += `<text x="${px - 8}" y="${sy(a) + 4}" font-size="11" text-anchor="end" fill="#6b7280">${f(a * 100, 0)}%</text>`;
  }
  for (let e = Math.ceil(Math.log10(minC)); e <= Math.floor(Math.log10(maxC)); e++) {
    const c = 10 ** e;
    out += `<line x1="${sx(c)}" y1="${py}" x2="${sx(c)}" y2="${py + ph}" stroke="#e5e7eb"/>`;
    out += `<text x="${sx(c)}" y="${py + ph + 16}" font-size="11" text-anchor="middle" fill="#6b7280">$${c >= 1 ? c : c.toFixed(-e)}</text>`;
  }
  out += `<text x="${px + pw / 2}" y="${py + ph + 32}" font-size="11" text-anchor="middle" fill="#6b7280">cost per 1,000 items (USD, log scale)</text>`;
  out += `<text transform="translate(${x + 14},${py + ph / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="#6b7280">accuracy</text>`;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${f(sx(p.cost_per_1k_usd), 1)},${f(sy(p.accuracy), 1)}`).join(' ');
  out += `<path d="${d}" fill="none" stroke="#2563eb" stroke-width="2.5"/>`;
  for (const p of pts) out += `<circle cx="${sx(p.cost_per_1k_usd)}" cy="${sy(p.accuracy)}" r="2.5" fill="#2563eb"><title>t=${p.threshold}: acc ${f(p.accuracy * 100)}%, $${f(p.cost_per_1k_usd, 3)}/1k, escalation ${f(p.escalation_rate * 100)}%</title></circle>`;
  const ht = hybrid.heldout.threshold;
  const chosen = pts.reduce((a, b) => (Math.abs(b.threshold - ht) < Math.abs(a.threshold - ht) ? b : a));
  out += `<circle cx="${sx(chosen.cost_per_1k_usd)}" cy="${sy(chosen.accuracy)}" r="8" fill="none" stroke="#2563eb" stroke-width="2"/>`;
  out += `<text x="${sx(chosen.cost_per_1k_usd) + 12}" y="${sy(chosen.accuracy) - 10}" font-size="12" fill="#1f2937">t = ${ht} (held-out choice): ${f(chosen.accuracy * 100)}%, $${f(chosen.cost_per_1k_usd, 2)}/1k, ${f(chosen.escalation_rate * 100, 0)}% escalated</text>`;
  out += `<rect x="${sx(s1.cost_per_1k_usd) - 6}" y="${sy(s1.accuracy) - 6}" width="12" height="12" fill="#f59e0b"/>`;
  out += `<text x="${sx(s1.cost_per_1k_usd) + 10}" y="${sy(s1.accuracy) + 16}" font-size="12" fill="#1f2937">System 1 only: ${f(s1.accuracy * 100)}%, $${f(s1.cost_per_1k_usd, 3)}/1k</text>`;
  out += `<rect x="${sx(s2.cost_per_1k_usd) - 6}" y="${sy(s2.accuracy) - 6}" width="12" height="12" fill="#10b981"/>`;
  out += `<text x="${sx(s2.cost_per_1k_usd) - 10}" y="${sy(s2.accuracy) + 20}" font-size="12" text-anchor="end" fill="#1f2937">System 2 only: ${f(s2.accuracy * 100)}%, $${f(s2.cost_per_1k_usd, 2)}/1k</text>`;
  return out;
}

export function renderHero(results, { s1Tags, s2Tag }) {
  const hybrid = results.hybrids.find((h) => h.s1 === s1Tags[0] && h.s2 === s2Tag) ?? results.hybrids[0];
  const half = W / 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`;
  svg += `<rect width="${W}" height="${H}" rx="10" fill="#ffffff" stroke="#e5e7eb"/>`;
  svg += reliabilityPanel(results, s1Tags, { x: 10, y: 10, w: half - 20, h: H - 20 });
  svg += frontierPanel(results, hybrid, { x: half + 10, y: 10, w: half - 20, h: H - 20 });
  svg += `<text x="${W - 12}" y="${H - 8}" font-size="10" text-anchor="end" fill="#9ca3af">${esc(results.dataset.name)}, n=${results.dataset.count}, ${esc(String(results.generated_at).slice(0, 10))}</text>`;
  svg += '</svg>\n';
  return svg;
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const datasetName = flags.dataset && flags.dataset !== true ? String(flags.dataset) : 'massive-en';
  const results = JSON.parse(fs.readFileSync(inProject('docs/assets/results', `${datasetName}.json`), 'utf8'));
  const s1Tags = flags.s1 ? [].concat(flags.s1).flatMap((s) => String(s).split(',')) : results.s1;
  const s2Tag = flags.s2 && flags.s2 !== true ? String(flags.s2) : results.s2[0];
  const out = inProject('docs/assets', flags.out && flags.out !== true ? String(flags.out) : 'hero.svg');
  fs.writeFileSync(out, renderHero(results, { s1Tags, s2Tag }));
  console.log('Wrote', out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
