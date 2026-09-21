import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotEnv } from '../src/env.mjs';
import { resolveRunConfig, publicSystem, helpText } from '../src/config.mjs';
import { predict, defaultTag } from './predict.mjs';
import { analyze } from './analyze.mjs';
import { inProject } from './paths.mjs';

// One-shot evaluation: System 1 predictions, System 2 predictions, then the analysis, on one
// dataset. Equivalent to running scripts/predict.mjs twice and scripts/analyze.mjs once.
//
//   node scripts/run-eval.mjs --limit 20            # quick look with the default pair
//   node scripts/run-eval.mjs --dataset massive-fr  # whole dataset

loadDotEnv({ file: inProject('.env') });

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const cfg = resolveRunConfig({ argv: process.argv.slice(2), env: process.env });
  if (cfg.help) {
    process.stdout.write(helpText());
    return;
  }
  const defense = cfg.flags.defense && cfg.flags.defense !== true ? String(cfg.flags.defense) : 'none';
  const useCache = !(cfg.flags['no-cache'] === true || cfg.flags['no-cache'] === 'true');
  const tags = {
    system1: cfg.tag ? `${cfg.tag}-s1` : defaultTag(cfg.system1, defense),
    system2: cfg.tag ? `${cfg.tag}-s2` : defaultTag(cfg.system2, defense),
  };

  if (cfg.dryRun) {
    console.log(JSON.stringify({ dataset: cfg.dataset, system1: publicSystem(cfg.system1), system2: publicSystem(cfg.system2), tags, threshold: cfg.threshold, limit: cfg.limit, defense }, null, 2));
    return;
  }

  for (const role of ['system1', 'system2']) {
    const system = cfg[role];
    console.error(`${role}: ${system.provider} / ${system.model} (${system.kind})`);
    await predict({ system, role, datasetName: cfg.dataset, tag: tags[role], defense, limit: cfg.limit, useCache, log: (m) => console.error(m) });
  }

  const doc = analyze({ datasetName: cfg.dataset, s1Tags: [tags.system1], s2Tags: [tags.system2] });
  const h = doc.hybrids[0];
  const s1 = doc.systems[tags.system1];
  console.log('');
  console.log(`Dataset ${doc.dataset.name}, n=${h.n}${cfg.limit ? ' (limited)' : ''}`);
  console.log(`System 1 only  ${cfg.system1.model.padEnd(28)} acc ${pct(h.system1_only.accuracy)}  cost/1k $${(h.system1_only.cost_per_1k_usd ?? 0).toFixed(3)}  ECE ${s1.calibration.ece.toFixed(3)}`);
  console.log(`System 2 only  ${cfg.system2.model.padEnd(28)} acc ${pct(h.system2_only.accuracy)}  cost/1k $${(h.system2_only.cost_per_1k_usd ?? 0).toFixed(3)}`);
  const t = cfg.flags.threshold !== undefined ? cfg.threshold : h.heldout.threshold;
  const row = h.sweep.reduce((a, b) => (Math.abs(b.threshold - t) < Math.abs(a.threshold - t) ? b : a));
  console.log(`Hybrid @ ${row.threshold.toFixed(2)}  ${''.padEnd(28)} acc ${pct(row.accuracy)}  cost/1k $${(row.cost_per_1k_usd ?? 0).toFixed(3)}  escalation ${pct(row.escalation_rate)}${cfg.flags.threshold !== undefined ? '' : '  (threshold chosen on the tuning half)'}`);
  console.log(`Full analysis: docs/assets/results/${doc.dataset.name}.json is NOT written by this command; run scripts/analyze.mjs --dataset ${doc.dataset.name} to publish.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
