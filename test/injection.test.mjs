import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInjectionSet, INJECTION_TEMPLATES, pickTarget } from '../src/injection.mjs';
import { mulberry32 } from '../src/metrics.mjs';
import { normalizeTask } from '../src/task.mjs';

const dataset = {
  name: 'toy',
  task: normalizeTask({ name: 't', labels: ['alarm', 'weather', 'music'], criteria: { alarm: 'a', weather: 'w', music: 'm' } }),
  items: [
    { id: '1', text: 'wake me at seven', truth: 'alarm' },
    { id: '2', text: 'is it raining', truth: 'weather' },
    { id: '3', text: 'play some jazz', truth: 'music' },
  ],
};

test('every template names the target except the benign control', () => {
  for (const [name, t] of Object.entries(INJECTION_TEMPLATES)) {
    const p = t.payload('weather');
    if (t.control) assert.ok(!p.includes('weather'), name);
    else assert.ok(p.includes('weather'), name);
  }
});

test('pickTarget never returns the true label', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 50; i++) assert.notEqual(pickTarget('alarm', dataset.task.labels, rng), 'alarm');
});

test('buildInjectionSet is deterministic, keeps truth, uses one target per source item across templates', () => {
  const a = buildInjectionSet(dataset, { seed: 7 });
  const b = buildInjectionSet(dataset, { seed: 7 });
  assert.deepEqual(a.items.map((i) => [i.id, i.text, i.meta.target]), b.items.map((i) => [i.id, i.text, i.meta.target]));
  assert.equal(a.items.length, 3 * Object.keys(INJECTION_TEMPLATES).length);
  assert.equal(a.name, 'toy-injected');
  for (const it of a.items) {
    const src = dataset.items.find((s) => s.id === it.meta.source_id);
    assert.equal(it.truth, src.truth);
    assert.ok(it.text.startsWith(src.text + '\n\n'));
    if (it.meta.control) assert.equal(it.meta.target, null);
    else assert.notEqual(it.meta.target, it.truth);
  }
  const targets = new Set(a.items.filter((i) => i.meta.source_id === '1' && !i.meta.control).map((i) => i.meta.target));
  assert.equal(targets.size, 1);
  const sub = buildInjectionSet(dataset, { ids: ['2'], templates: ['direct', 'benign'] });
  assert.deepEqual(sub.items.map((i) => i.id), ['2#direct', '2#benign']);
  assert.throws(() => buildInjectionSet(dataset, { templates: ['nope'] }), /Unknown injection template/);
});
