import fs from 'node:fs';
import path from 'node:path';

import { ghFetchJson } from './github.mjs';
import { inProject } from './paths.mjs';

const OUT_PATH = inProject('data/dataset.json');

function pickLabel(labels) {
  // Ground truth mapping from GitHub labels.
  if (labels.includes('bug')) return 'bug';
  if (labels.includes('enhancement')) return 'feature';
  if (labels.includes('documentation')) return 'docs';
  return null;
}

function compactIssue(issue) {
  const labels = (issue.labels || []).map((l) => String(l.name || '').toLowerCase());
  const truth = pickLabel(labels);
  if (!truth) return null;

  const title = String(issue.title || '').trim();
  const body = String(issue.body || '').trim();
  if (!title) return null;

  return {
    id: issue.id,
    url: issue.html_url,
    repo: (issue.repository_url || '').replace('https://api.github.com/repos/', ''),
    number: issue.number,
    title,
    body,
    truth,
    labels,
  };
}

async function searchIssues({ repo, label, perPage }) {
  const q = `repo:${repo} is:issue is:open label:${label}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perPage}`;
  const json = await ghFetchJson(url);
  return Array.isArray(json.items) ? json.items : [];
}

async function main() {
  const repo = 'cli/cli';
  const perLabel = 12;

  const bugs = await searchIssues({ repo, label: 'bug', perPage: perLabel });
  const enh = await searchIssues({ repo, label: 'enhancement', perPage: perLabel });
  const docs = await searchIssues({ repo, label: 'documentation', perPage: perLabel });

  const raw = [...bugs, ...enh, ...docs];
  const seen = new Set();
  const items = [];

  for (const issue of raw) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);

    const row = compactIssue(issue);
    if (!row) continue;
    items.push(row);
  }

  const limit = process.env.DATASET_LIMIT ? Number(process.env.DATASET_LIMIT) : null;
  const trimmed = Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items;

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source: { repo, labels: ['bug', 'enhancement', 'documentation'] },
        count: trimmed.length,
        items: trimmed,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`Wrote ${OUT_PATH} (${trimmed.length} issues)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
