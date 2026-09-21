import fs from 'node:fs';

import { loadDotEnv } from '../src/env.mjs';
import { resolveRunConfig, publicSystem, getApiKey, helpText } from '../src/config.mjs';
import { createAdapter } from '../src/adapters/index.mjs';
import { pickHybrid } from '../src/router.mjs';
import { issueText, stratifiedSubset } from '../src/task.mjs';
import { mean, round } from '../src/util.mjs';
import { inProject } from './paths.mjs';

// Allow running from anywhere (e.g., repo root) without relying on cwd.
loadDotEnv({ file: inProject('.env') });

const DATASET_PATH = inProject('data/dataset.json');

function outPaths(tag) {
  const suffix = tag ? `.${tag}` : '';
  return {
    results: inProject(`data/results${suffix}.json`),
    sweep: inProject(`data/threshold_sweep${suffix}.json`),
  };
}

function accuracy(rows) {
  if (!rows.length) return 0;
  const ok = rows.filter((r) => r.pred === r.truth).length;
  return ok / rows.length;
}

// Costs may be unknown (null) for providers that report neither cost nor configured pricing.
// We sum what is known and publish the coverage, so an unknown cost never reads as "free".
function sumCost(rows) {
  const known = rows.filter((r) => typeof r.cost === 'number');
  return {
    total: known.reduce((a, r) => a + r.cost, 0),
    coverage: rows.length ? known.length / rows.length : 0,
  };
}

function meanLatency(rows) {
  return mean(rows.map((r) => r.latency_ms || 0));
}

function strategySummary(rows, { withEscalation = false } = {}) {
  const cost = sumCost(rows);
  const out = {
    accuracy: round(accuracy(rows), 4),
    correct: rows.filter((r) => r.pred === r.truth).length,
    total_cost_usd: round(cost.total, 6),
    cost_coverage: round(cost.coverage, 4),
    mean_latency_ms: round(meanLatency(rows), 1),
  };
  if (withEscalation) {
    out.escalation_rate = round(rows.filter((r) => r.used === 'system2').length / rows.length, 4);
  }
  return out;
}

function hybridRowsAt(perItem, threshold) {
  return perItem.map((x) => {
    const pick = pickHybrid({
      s1Label: x.system1.label,
      s1Confidence: x.system1.confidence,
      s2Label: x.system2.label,
      threshold,
    });
    const escalated = pick.used === 'system2';
    const s1Cost = x.system1.cost;
    const s2Cost = x.system2.cost;
    let cost = null;
    if (typeof s1Cost === 'number' && (!escalated || typeof s2Cost === 'number')) {
      cost = s1Cost + (escalated ? s2Cost : 0);
    }
    return {
      id: x.id,
      url: x.url,
      truth: x.truth,
      pred: pick.label,
      used: pick.used,
      system1_confidence: x.system1.confidence,
      cost,
      latency_ms: x.system1.latency_ms + (escalated ? x.system2.latency_ms : 0),
    };
  });
}

async function main() {
  const cfg = resolveRunConfig({ argv: process.argv.slice(2), env: process.env });

  if (cfg.help) {
    process.stdout.write(helpText());
    return;
  }

  const publicConfig = {
    system1: publicSystem(cfg.system1),
    system2: publicSystem(cfg.system2),
    threshold: cfg.threshold,
    limit: cfg.limit,
    tag: cfg.tag,
    config_file: cfg.configFile,
  };

  if (cfg.dryRun) {
    console.log(JSON.stringify(publicConfig, null, 2));
    return;
  }

  // Fail early (and by name) on a missing key rather than after the first HTTP call.
  getApiKey(cfg.system1, process.env);
  getApiKey(cfg.system2, process.env);

  if (!fs.existsSync(DATASET_PATH)) {
    throw new Error(`Missing ${DATASET_PATH}. Run: node scripts/build-dataset.mjs (or commit a dataset).`);
  }

  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  let items = dataset.items || [];
  if (!items.length) throw new Error('Dataset is empty.');
  if (cfg.limit) items = stratifiedSubset(items, cfg.limit);

  const s1 = createAdapter(cfg.system1);
  const s2 = createAdapter(cfg.system2);

  console.error(
    `System 1: ${cfg.system1.provider} / ${cfg.system1.model} (${cfg.system1.kind}, confidence=${cfg.system1.confidence})`,
  );
  console.error(`System 2: ${cfg.system2.provider} / ${cfg.system2.model} (${cfg.system2.kind})`);
  console.error(`Threshold: ${cfg.threshold}  Items: ${items.length}${cfg.tag ? `  Tag: ${cfg.tag}` : ''}`);

  const perItem = [];
  const startedAt = new Date().toISOString();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const text = issueText(item);

    // Both systems are always called so that all three strategies (and the threshold sweep)
    // can be computed from one pass. A production router would only call System 2 on escalation.
    const r1 = await s1.classify({ text, wantConfidence: true });
    const r2 = await s2.classify({ text, wantConfidence: false });

    perItem.push({
      id: item.id,
      url: item.url,
      truth: item.truth,
      system1: r1,
      system2: r2,
    });

    // Polite pacing (avoid spiky API usage)
    await new Promise((r) => setTimeout(r, 150));

    process.stderr.write(`\rEvaluated ${i + 1}/${items.length}...`);
  }
  process.stderr.write('\n');

  const strip = (x, r) => ({
    id: x.id,
    url: x.url,
    truth: x.truth,
    pred: r.label,
    cost: r.cost,
    latency_ms: r.latency_ms,
  });

  // Strategy A: System 2 only
  const s2Rows = perItem.map((x) => strip(x, x.system2));

  // Strategy B: System 1 only
  const s1Rows = perItem.map((x) => ({
    ...strip(x, x.system1),
    confidence: x.system1.confidence,
    confidence_source: x.system1.confidence_source,
  }));

  // Strategy C: Hybrid @ threshold
  const hybridRows = hybridRowsAt(perItem, cfg.threshold);

  const confidenceSources = [...new Set(perItem.map((x) => x.system1.confidence_source).filter(Boolean))];

  const results = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    dataset: {
      generated_at: dataset.generated_at,
      source: dataset.source,
      count: items.length,
      total_in_dataset: (dataset.items || []).length,
    },
    models: {
      system1: { ...publicConfig.system1, confidence_sources_seen: confidenceSources },
      system2: publicConfig.system2,
    },
    threshold: cfg.threshold,
    tag: cfg.tag,
    summary: {
      system2_only: strategySummary(s2Rows),
      system1_only: strategySummary(s1Rows),
      hybrid: strategySummary(hybridRows, { withEscalation: true }),
    },
    items: {
      system2_only: s2Rows,
      system1_only: s1Rows,
      hybrid: hybridRows,
    },
    raw: perItem.map((x) => ({
      id: x.id,
      system1: { ...x.system1, raw: x.system1.raw },
      system2: { ...x.system2, raw: x.system2.raw },
    })),
  };

  // Threshold sweep (no extra model calls)
  const sweep = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const tt = Math.round(t * 100) / 100;
    const rows = hybridRowsAt(perItem, tt);
    sweep.push({ threshold: tt, ...strategySummary(rows, { withEscalation: true }) });
  }

  const out = outPaths(cfg.tag);
  fs.mkdirSync(inProject('data'), { recursive: true });
  fs.writeFileSync(out.results, JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(
    out.sweep,
    JSON.stringify({ generated_at: results.generated_at, tag: cfg.tag, models: results.models, sweep }, null, 2) + '\n',
  );

  console.log('Wrote', out.results);
  console.log('Wrote', out.sweep);

  console.log('\nModels:');
  console.log(JSON.stringify(results.models, null, 2));
  console.log('\nSummary:');
  console.log(results.summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
