import fs from 'node:fs';

import { loadDotEnv } from '../src/env.mjs';
import { jevDecisions, buildIssueClassificationQuestions } from '../src/jev.mjs';
import { fableClassify } from '../src/fable.mjs';
import { envNumber, pickHybrid } from '../src/router.mjs';
import { mean, round } from '../src/util.mjs';
import { inProject } from './paths.mjs';

// Allow running from anywhere (e.g., repo root) without relying on cwd.
loadDotEnv({ file: inProject('.env') });

const DATASET_PATH = inProject('data/dataset.json');
const OUT_RESULTS = inProject('data/results.json');
const OUT_SWEEP = inProject('data/threshold_sweep.json');

function issueText(item) {
  const body = item.body ? `\n\n${item.body}` : '';
  return `Title: ${item.title}${body}`;
}

function accuracy(rows) {
  if (!rows.length) return 0;
  const ok = rows.filter((r) => r.pred === r.truth).length;
  return ok / rows.length;
}

function sumCost(rows) {
  return rows.reduce((a, r) => a + (r.cost || 0), 0);
}

function meanLatency(rows) {
  return mean(rows.map((r) => r.latency_ms || 0));
}

async function main() {
  if (!fs.existsSync(DATASET_PATH)) {
    throw new Error(
      `Missing ${DATASET_PATH}. Run: node scripts/build-dataset.mjs (or commit a dataset).`,
    );
  }

  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  const items = dataset.items || [];
  if (!items.length) throw new Error('Dataset is empty.');

  // Default threshold chosen from this repo's sweep (see data/threshold_sweep.json).
  const threshold = envNumber('HYBRID_CONFIDENCE_THRESHOLD', 0.4);

  const perItem = [];
  const questions = buildIssueClassificationQuestions();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const text = issueText(item);

    // Call System 1 (Jev)
    const jev = await jevDecisions({ state: text, questions });
    const jevAnswer = jev.json?.answers?.label;
    const jevLabel = jevAnswer?.choice;
    const jevConfidence = jevAnswer?.confidence ?? null;
    const jevCost = jev.json?.usage?.cost ?? 0;

    // Call System 2 (Fable)
    const fable = await fableClassify({ text });
    const fableLabel = fable.parsed.label;
    const fableCost = fable.json?.usage?.cost ?? 0;

    perItem.push({
      id: item.id,
      url: item.url,
      truth: item.truth,
      jev: {
        label: jevLabel,
        confidence: jevConfidence,
        cost: jevCost,
        latency_ms: jev.latency_ms,
        raw: jev.json,
      },
      fable: {
        label: fableLabel,
        cost: fableCost,
        latency_ms: fable.latency_ms,
        raw: fable.json,
      },
    });

    // Polite pacing (avoid spiky API usage)
    await new Promise((r) => setTimeout(r, 150));

    process.stderr.write(`\rEvaluated ${i + 1}/${items.length}...`);
  }
  process.stderr.write('\n');

  // Strategy A: Fable only
  const fableRows = perItem.map((x) => ({
    id: x.id,
    url: x.url,
    truth: x.truth,
    pred: x.fable.label,
    cost: x.fable.cost,
    latency_ms: x.fable.latency_ms,
  }));

  // Strategy B: Jev only
  const jevRows = perItem.map((x) => ({
    id: x.id,
    url: x.url,
    truth: x.truth,
    pred: x.jev.label,
    cost: x.jev.cost,
    latency_ms: x.jev.latency_ms,
    confidence: x.jev.confidence,
  }));

  // Strategy C: Hybrid @ threshold
  const hybridRows = perItem.map((x) => {
    const pick = pickHybrid({
      jevLabel: x.jev.label,
      jevConfidence: x.jev.confidence ?? 0,
      fableLabel: x.fable.label,
      threshold,
    });

    const escalated = pick.used === 'fable';

    return {
      id: x.id,
      url: x.url,
      truth: x.truth,
      pred: pick.label,
      used: pick.used,
      jev_confidence: x.jev.confidence,
      cost: x.jev.cost + (escalated ? x.fable.cost : 0),
      latency_ms: x.jev.latency_ms + (escalated ? x.fable.latency_ms : 0),
    };
  });

  const results = {
    generated_at: new Date().toISOString(),
    dataset: {
      generated_at: dataset.generated_at,
      source: dataset.source,
      count: items.length,
    },
    models: {
      system1: 'typesafe/jev-1.13',
      system2: 'anthropic/claude-fable-5.1',
    },
    threshold,
    summary: {
      fable_only: {
        accuracy: round(accuracy(fableRows), 4),
        total_cost_usd: round(sumCost(fableRows), 6),
        mean_latency_ms: round(meanLatency(fableRows), 1),
      },
      jev_only: {
        accuracy: round(accuracy(jevRows), 4),
        total_cost_usd: round(sumCost(jevRows), 6),
        mean_latency_ms: round(meanLatency(jevRows), 1),
      },
      hybrid: {
        accuracy: round(accuracy(hybridRows), 4),
        total_cost_usd: round(sumCost(hybridRows), 6),
        mean_latency_ms: round(meanLatency(hybridRows), 1),
        escalation_rate: round(
          hybridRows.filter((r) => r.used === 'fable').length / hybridRows.length,
          4,
        ),
      },
    },
    items: {
      fable_only: fableRows,
      jev_only: jevRows,
      hybrid: hybridRows,
    },
  };

  // Threshold sweep (no extra model calls)
  const sweep = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const tt = Math.round(t * 100) / 100;
    const rows = perItem.map((x) => {
      const pick = pickHybrid({
        jevLabel: x.jev.label,
        jevConfidence: x.jev.confidence ?? 0,
        fableLabel: x.fable.label,
        threshold: tt,
      });
      const escalated = pick.used === 'fable';
      return {
        truth: x.truth,
        pred: pick.label,
        used: pick.used,
        cost: x.jev.cost + (escalated ? x.fable.cost : 0),
        latency_ms: x.jev.latency_ms + (escalated ? x.fable.latency_ms : 0),
      };
    });

    sweep.push({
      threshold: tt,
      accuracy: round(accuracy(rows), 4),
      total_cost_usd: round(sumCost(rows), 6),
      mean_latency_ms: round(meanLatency(rows), 1),
      escalation_rate: round(
        rows.filter((r) => r.used === 'fable').length / rows.length,
        4,
      ),
    });
  }

  fs.mkdirSync(inProject('data'), { recursive: true });
  fs.writeFileSync(OUT_RESULTS, JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(
    OUT_SWEEP,
    JSON.stringify({ generated_at: results.generated_at, sweep }, null, 2) + '\n',
  );

  console.log('Wrote', OUT_RESULTS);
  console.log('Wrote', OUT_SWEEP);

  console.log('\nSummary:');
  console.log(results.summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
