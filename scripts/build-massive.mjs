import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { inProject } from './paths.mjs';
import { saveDataset } from '../src/dataset.mjs';
import { mulberry32, seededShuffle } from '../src/metrics.mjs';

// Builds data/massive-en.json and data/massive-fr.json from the MASSIVE 1.1 dataset
// (Amazon, CC BY 4.0, https://github.com/alexa/massive): the same N utterances, by id, in en-US and
// fr-FR, sampled from the test split proportionally to the 18 scenarios with a fixed seed.
// Zero dependencies: the tarball is read with a minimal ustar reader.

const TARBALL_URL = 'https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz';
const CACHE = inProject('.cache/amazon-massive-dataset-1.1.tar.gz');
const N = Number(process.env.MASSIVE_N || 600);
const SEED = Number(process.env.MASSIVE_SEED || 42);
const LOCALES = { en: 'en-US', fr: 'fr-FR' };

// One line per scenario, written from the intents each scenario contains in MASSIVE.
export const SCENARIOS = {
  alarm: 'Setting, checking or removing alarms and wake-up calls.',
  audio: "Controlling the assistant's sound volume: mute, louder, quieter.",
  calendar: 'Creating, checking or deleting calendar events, meetings and reminders.',
  cooking: 'Recipes and cooking instructions.',
  datetime: 'Asking the current time or date, or converting between time zones.',
  email: 'Reading, sending or searching emails; managing email contacts.',
  general: 'Chit-chat, greetings, jokes, and replies to the assistant (yes, no, stop, repeat, thanks) with no task.',
  iot: 'Smart-home devices: lights, plugs, coffee machine, vacuum cleaner.',
  lists: 'Creating, adding to, reading or removing items from lists (shopping, to-do).',
  music: 'Music preferences and settings: liking or disliking a song, asking what is playing, playback settings.',
  news: 'News and headlines.',
  play: 'Starting playback of music, radio, podcasts, audiobooks or games.',
  qa: 'Factual questions: definitions, facts, maths, stock prices, currency rates.',
  recommendation: 'Recommendations for events, movies, restaurants or places.',
  social: 'Social media: posting an update or checking feeds and notifications.',
  takeaway: 'Ordering takeaway food or checking a food order.',
  transport: 'Trains, buses, taxis and traffic: timetables, tickets, rides, traffic conditions.',
  weather: 'Weather forecasts and conditions.',
};

function cstr(buf, off, len) {
  const s = buf.subarray(off, off + len);
  const end = s.indexOf(0);
  return s.subarray(0, end === -1 ? len : end).toString('utf8');
}

// Minimal ustar/GNU tar reader: yields { name, data } for regular files.
export function* tarEntries(buf) {
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = longName ?? (cstr(h, 345, 155) ? `${cstr(h, 345, 155)}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    longName = null;
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'L') longName = cstr(data, 0, data.length);
    else if (type === '0' || type === '\0' || type === '') yield { name, data };
  }
}

async function tarball() {
  if (!fs.existsSync(CACHE)) {
    console.error(`Downloading ${TARBALL_URL} …`);
    const res = await fetch(TARBALL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading MASSIVE`);
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, Buffer.from(await res.arrayBuffer()));
  }
  return zlib.gunzipSync(fs.readFileSync(CACHE));
}

function parseJsonl(data) {
  return data
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Proportional allocation with largest remainders, so the sample keeps the natural label mix.
export function allocate(counts, n) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const raw = Object.entries(counts).map(([k, c]) => ({ k, exact: (c / total) * n }));
  const alloc = Object.fromEntries(raw.map((r) => [r.k, Math.floor(r.exact)]));
  let left = n - Object.values(alloc).reduce((a, b) => a + b, 0);
  for (const r of raw.sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
    if (left <= 0) break;
    alloc[r.k]++;
    left--;
  }
  return alloc;
}

export function sampleIds(rows, n, seed) {
  const test = rows.filter((r) => r.partition === 'test');
  const byScenario = new Map();
  for (const r of test) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(r);
  }
  const counts = Object.fromEntries([...byScenario].map(([k, v]) => [k, v.length]));
  const alloc = allocate(counts, n);
  const ids = [];
  for (const [scenario, list] of [...byScenario].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = list.slice().sort((a, b) => Number(a.id) - Number(b.id));
    const rng = mulberry32(seed + scenario.length * 1000 + scenario.charCodeAt(0));
    for (const r of seededShuffle(sorted, rng).slice(0, alloc[scenario])) ids.push(String(r.id));
  }
  return { ids, alloc, test_size: test.length };
}

async function main() {
  const buf = await tarball();
  const files = {};
  for (const e of tarEntries(buf)) {
    for (const loc of Object.values(LOCALES)) if (e.name.endsWith(`/${loc}.jsonl`)) files[loc] = parseJsonl(e.data);
  }
  for (const loc of Object.values(LOCALES)) if (!files[loc]) throw new Error(`${loc}.jsonl not found in the tarball`);

  const en = files[LOCALES.en];
  const { ids, alloc, test_size } = sampleIds(en, N, SEED);
  const generated_at = new Date().toISOString();

  for (const [short, loc] of Object.entries(LOCALES)) {
    const byId = new Map(files[loc].map((r) => [String(r.id), r]));
    const items = ids.map((id) => {
      const r = byId.get(id);
      if (!r) throw new Error(`id ${id} missing in ${loc}`);
      return { id, text: r.utt, truth: r.scenario, meta: { intent: r.intent, locale: loc } };
    });
    const p = saveDataset({
      name: `massive-${short}`,
      generated_at,
      source: {
        name: 'MASSIVE 1.1',
        url: 'https://github.com/alexa/massive',
        download: TARBALL_URL,
        license: 'CC BY 4.0',
        citation: 'FitzGerald et al., "MASSIVE: A 1M-Example Multilingual Natural Language Understanding Dataset with 51 Typologically-Diverse Languages", 2022',
        locale: loc,
        split: 'test',
        sampling: `${N} of ${test_size} test utterances, proportional to scenario, seed ${SEED}; identical ids across locales`,
        per_label: alloc,
      },
      task: {
        name: 'scenario',
        instructions: 'Classify this voice-assistant request into the scenario it belongs to.',
        labels: Object.keys(SCENARIOS),
        criteria: SCENARIOS,
      },
      items,
    });
    console.log(`Wrote ${p} (${items.length} items)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
