import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/config.mjs';
import { saveDataset } from '../src/dataset.mjs';
import { mulberry32, seededShuffle } from '../src/metrics.mjs';
import { inProject } from './paths.mjs';

// Builds the five small tasks the playground adds to MASSIVE: three synthetic, deterministic sets
// that exercise documented weak spots of a decision model (counting, date ordering, arithmetic)
// and two public, CC BY 4.0 sets from the UCI repository (sentiment of short reviews, SMS spam).
//
//   node scripts/build-playground-sets.mjs [--n 120] [--seed 11]
//
// The UCI archives are downloaded to .cache/uci/ on first use (unzip must be on the PATH).

const UCI = {
  sms: {
    url: 'https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip',
    member: 'SMSSpamCollection',
    page: 'https://archive.ics.uci.edu/dataset/228/sms+spam+collection',
    citation: 'Almeida, Hidalgo & Yamakami, "Contributions to the study of SMS spam filtering: new collection and results", DocEng 2011',
  },
  sentiment: {
    url: 'https://archive.ics.uci.edu/static/public/331/sentiment+labelled+sentences.zip',
    members: ['sentiment labelled sentences/imdb_labelled.txt', 'sentiment labelled sentences/amazon_cells_labelled.txt', 'sentiment labelled sentences/yelp_labelled.txt'],
    page: 'https://archive.ics.uci.edu/dataset/331/sentiment+labelled+sentences',
    citation: 'Kotzias, Denil, de Freitas & Smyth, "From Group to Individual Labels using Deep Features", KDD 2015',
  },
};

const NOUNS = [
  'apples', 'bananas', 'cherries', 'grapes', 'lemons', 'mangoes', 'oranges', 'peaches', 'pears', 'plums',
  'carrots', 'onions', 'potatoes', 'tomatoes', 'peppers', 'cucumbers', 'radishes', 'leeks', 'beets', 'turnips',
  'hammers', 'nails', 'screws', 'bolts', 'wrenches', 'pliers', 'saws', 'drills', 'clamps', 'levels',
  'pencils', 'erasers', 'rulers', 'markers', 'staplers', 'folders', 'notebooks', 'envelopes', 'stamps', 'labels',
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function balanced(rng, n, makers) {
  // makers: { label: () => text }. Returns n items alternating labels, then shuffled.
  const labels = Object.keys(makers);
  const items = [];
  const seen = new Set();
  let guard = 0;
  while (items.length < n && guard++ < n * 50) {
    const label = labels[items.length % labels.length];
    const text = makers[label]();
    if (seen.has(text)) continue;
    seen.add(text);
    items.push({ text, truth: label });
  }
  return seededShuffle(items, rng).map((it, i) => ({ id: String(i + 1), ...it }));
}

// ---------- 1. counting ----------
export function buildCount({ n, seed }) {
  const rng = mulberry32(seed);
  const list = (k) => {
    const words = seededShuffle(NOUNS, rng).slice(0, k);
    const style = rng();
    if (style < 0.4) return `Shopping list: ${words.join(', ')}.`;
    if (style < 0.7) return `We need ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}.`;
    return `Items: ${words.join('; ')}`;
  };
  const items = balanced(rng, n, {
    more_than_5: () => list(pick(rng, [6, 6, 7, 7, 8])),
    five_or_fewer: () => list(pick(rng, [3, 4, 4, 5, 5, 5])),
  });
  return {
    name: 'count',
    generated_at: new Date().toISOString(),
    source: { name: 'synthetic, deterministic', sampling: `${n} lists of 3–8 nouns, seed ${seed}, half above five`, license: 'MIT (this repo)' },
    task: {
      name: 'count',
      instructions: 'Count the items in the list. Decide whether there are more than five.',
      labels: ['more_than_5', 'five_or_fewer'],
      criteria: {
        more_than_5: 'The list contains six or more items.',
        five_or_fewer: 'The list contains five items or fewer.',
      },
    },
    items,
  };
}

// ---------- 2. date ordering ----------
function fmtDate(rng, d) {
  const y = d.y, m = d.m, day = d.d;
  const style = rng();
  if (style < 0.35) return `${day} ${MONTHS[m - 1]} ${y}`;
  if (style < 0.7) return `${MONTHS[m - 1]} ${day}, ${y}`;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function toNum(d) {
  return d.y * 10000 + d.m * 100 + d.d;
}
export function buildDates({ n, seed }) {
  const rng = mulberry32(seed + 1);
  const randDate = () => ({ y: 2019 + Math.floor(rng() * 8), m: 1 + Math.floor(rng() * 12), d: 1 + Math.floor(rng() * 28) });
  const near = (a) => {
    // a second date close to the first: same year, often same month, so the answer needs a real comparison
    const kind = rng();
    if (kind < 0.4) return { y: a.y, m: a.m, d: 1 + Math.floor(rng() * 28) };
    if (kind < 0.8) return { y: a.y, m: 1 + Math.floor(rng() * 12), d: 1 + Math.floor(rng() * 28) };
    return { y: a.y + (rng() < 0.5 ? -1 : 1), m: 1 + Math.floor(rng() * 12), d: 1 + Math.floor(rng() * 28) };
  };
  const pair = (wantAFirst) => {
    for (;;) {
      const a = randDate();
      const b = near(a);
      if (toNum(a) === toNum(b)) continue;
      const aFirst = toNum(a) < toNum(b);
      if (aFirst !== wantAFirst) continue;
      return `Date A: ${fmtDate(rng, a)}. Date B: ${fmtDate(rng, b)}.`;
    }
  };
  const items = balanced(rng, n, { a_first: () => pair(true), b_first: () => pair(false) });
  return {
    name: 'dates',
    generated_at: new Date().toISOString(),
    source: { name: 'synthetic, deterministic', sampling: `${n} date pairs 2019–2026 in three formats, seed ${seed}, half A-first`, license: 'MIT (this repo)' },
    task: {
      name: 'dates',
      instructions: 'Two dates are given. Decide which one comes first in time.',
      labels: ['a_first', 'b_first'],
      criteria: {
        a_first: 'Date A is earlier than date B.',
        b_first: 'Date B is earlier than date A.',
      },
    },
    items,
  };
}

// ---------- 3. arithmetic ----------
export function buildArith({ n, seed }) {
  const rng = mulberry32(seed + 2);
  const eq = (correct) => {
    const op = pick(rng, ['+', '+', '-', '×']);
    let a, b, r;
    if (op === '+') { a = 11 + Math.floor(rng() * 88); b = 11 + Math.floor(rng() * 88); r = a + b; }
    else if (op === '-') { a = 30 + Math.floor(rng() * 69); b = 11 + Math.floor(rng() * (a - 11)); r = a - b; }
    else { a = 3 + Math.floor(rng() * 10); b = 3 + Math.floor(rng() * 10); r = a * b; }
    if (!correct) {
      const delta = pick(rng, [-10, -3, -2, -1, 1, 2, 3, 10]);
      r += delta;
    }
    return `${a} ${op} ${b} = ${r}`;
  };
  const items = balanced(rng, n, { correct: () => eq(true), incorrect: () => eq(false) });
  return {
    name: 'arith',
    generated_at: new Date().toISOString(),
    source: { name: 'synthetic, deterministic', sampling: `${n} equations (two-digit + −, one-digit ×), seed ${seed}, wrong ones off by 1–10`, license: 'MIT (this repo)' },
    task: {
      name: 'arith',
      instructions: 'Check the arithmetic. Decide whether the equation is correct.',
      labels: ['correct', 'incorrect'],
      criteria: {
        correct: 'The equation is true: the result on the right is exactly what the operation on the left gives.',
        incorrect: 'The equation is false: the result on the right is not what the operation on the left gives.',
      },
    },
    items,
  };
}

// ---------- UCI downloads ----------
function fetchZip(name, url) {
  const dir = inProject('.cache/uci');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${name}.zip`);
  if (!fs.existsSync(p)) {
    const r = spawnSync('curl', ['-sL', '-o', p, url], { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(p)) throw new Error(`download failed for ${url}: ${r.stderr}`);
  }
  return p;
}
function unzipMember(zip, member) {
  const r = spawnSync('unzip', ['-p', zip, member], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`unzip ${member} failed: ${r.stderr}`);
  return r.stdout;
}

// ---------- 4. sentiment (UCI, CC BY 4.0) ----------
export function buildSentiment({ n, seed, lines }) {
  const rng = mulberry32(seed + 3);
  const pos = [], neg = [];
  for (const { text, label, origin } of lines) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length < 12 || t.length > 160) continue;
    (label === '1' ? pos : neg).push({ text: t, origin });
  }
  const half = Math.floor(n / 2);
  const chosen = [...seededShuffle(pos, rng).slice(0, half).map((x) => ({ ...x, truth: 'positive' })), ...seededShuffle(neg, rng).slice(0, n - half).map((x) => ({ ...x, truth: 'negative' }))];
  const items = seededShuffle(chosen, rng).map((x, i) => ({ id: String(i + 1), text: x.text, truth: x.truth, meta: { origin: x.origin } }));
  return {
    name: 'sentiment',
    generated_at: new Date().toISOString(),
    source: {
      name: 'Sentiment Labelled Sentences (UCI)',
      url: UCI.sentiment.page,
      license: 'CC BY 4.0',
      citation: UCI.sentiment.citation,
      sampling: `${n} sentences of 12–160 characters, half positive, seeded (${seed}) from the IMDB, Amazon and Yelp files`,
    },
    task: {
      name: 'sentiment',
      instructions: 'Decide whether this short review is positive or negative.',
      labels: ['positive', 'negative'],
      criteria: { positive: 'The reviewer is satisfied, praises or recommends.', negative: 'The reviewer is dissatisfied, complains or warns against.' },
    },
    items,
  };
}

// ---------- 5. SMS spam (UCI, CC BY 4.0) ----------
export function buildSpam({ n, seed, lines }) {
  const rng = mulberry32(seed + 4);
  const spam = [], ham = [];
  for (const { text, label } of lines) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length < 15 || t.length > 200) continue;
    (label === 'spam' ? spam : ham).push({ text: t });
  }
  const half = Math.floor(n / 2);
  const chosen = [...seededShuffle(spam, rng).slice(0, half).map((x) => ({ ...x, truth: 'spam' })), ...seededShuffle(ham, rng).slice(0, n - half).map((x) => ({ ...x, truth: 'ham' }))];
  const items = seededShuffle(chosen, rng).map((x, i) => ({ id: String(i + 1), text: x.text, truth: x.truth }));
  return {
    name: 'spam',
    generated_at: new Date().toISOString(),
    source: {
      name: 'SMS Spam Collection (UCI)',
      url: UCI.sms.page,
      license: 'CC BY 4.0',
      citation: UCI.sms.citation,
      sampling: `${n} messages of 15–200 characters, half spam (the collection itself is 13% spam), seeded (${seed})`,
    },
    task: {
      name: 'spam',
      instructions: 'Decide whether this text message is spam or a normal personal message.',
      labels: ['spam', 'ham'],
      criteria: { spam: 'Unsolicited advertising, prize or lottery claims, premium-rate numbers, phishing.', ham: 'A normal message between people: plans, chit-chat, questions, replies.' },
    },
    items,
  };
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const n = Number(flags.n || 120);
  const seed = Number(flags.seed || 11);

  const docs = [buildCount({ n, seed }), buildDates({ n, seed }), buildArith({ n, seed })];

  const sentZip = fetchZip('sentiment', UCI.sentiment.url);
  const sentLines = [];
  for (const m of UCI.sentiment.members) {
    const origin = path.basename(m).split('_')[0];
    for (const line of unzipMember(sentZip, m).split('\n')) {
      const i = line.lastIndexOf('\t');
      if (i < 0) continue;
      sentLines.push({ text: line.slice(0, i), label: line.slice(i + 1).trim(), origin });
    }
  }
  docs.push(buildSentiment({ n, seed, lines: sentLines }));

  const smsZip = fetchZip('sms', UCI.sms.url);
  const smsLines = [];
  for (const line of unzipMember(smsZip, UCI.sms.member).split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    smsLines.push({ label: line.slice(0, i).trim(), text: line.slice(i + 1) });
  }
  docs.push(buildSpam({ n, seed, lines: smsLines }));

  for (const doc of docs) {
    const p = saveDataset(doc);
    const per = {};
    for (const it of doc.items) per[it.truth] = (per[it.truth] || 0) + 1;
    console.log(`Wrote ${p} (${doc.items.length} items, ${JSON.stringify(per)})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
