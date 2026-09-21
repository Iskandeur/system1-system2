import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTask,
  withDefense,
  classificationPrompt,
  classificationSchema,
  decisionQuestions,
  wrapText,
  stratifiedSubset,
  HARDENED_NOTE,
} from '../src/task.mjs';

const TASK = {
  name: 'issue-label',
  instructions: 'Classify this GitHub issue into one label.',
  labels: ['bug', 'feature', 'docs'],
  criteria: { bug: 'Broken.', feature: 'New capability.', docs: 'Docs or question.' },
};

test('normalizeTask validates labels and fills criteria', () => {
  const t = normalizeTask(TASK);
  assert.deepEqual(t.labels, ['bug', 'feature', 'docs']);
  assert.equal(t.defense, 'none');
  assert.throws(() => normalizeTask({ labels: ['a'] }), /at least two/);
  assert.throws(() => normalizeTask({ labels: ['a', 'a'] }), /unique/);
  assert.throws(() => normalizeTask({ ...TASK, defense: 'magic' }), /defense must be one of/);
  assert.equal(normalizeTask({ labels: ['x', 'y'] }).criteria.x, '');
});

test('chat prompt lists every label with its criterion and asks for confidence only as System 1', () => {
  const t = normalizeTask(TASK);
  const p = classificationPrompt({ task: t, text: 'Title: crash' });
  assert.match(p, /^Classify this GitHub issue into one label\.\n/);
  assert.match(p, /\{"label": "bug"\|"feature"\|"docs"\}/);
  assert.match(p, /- feature: New capability\./);
  assert.ok(p.endsWith('\n\nTitle: crash'));
  assert.ok(!p.includes('confidence'));
  const withConf = classificationPrompt({ task: t, text: 'x', withConfidence: true });
  assert.match(withConf, /"confidence": <number between 0 and 1>/);
});

test('schema and decision question are derived from the task', () => {
  const t = normalizeTask(TASK);
  assert.deepEqual(classificationSchema(t).properties.label.enum, ['bug', 'feature', 'docs']);
  assert.deepEqual(classificationSchema(t, { withConfidence: true }).required, ['label', 'confidence']);
  const q = decisionQuestions(t);
  assert.equal(q.label.type, 'choice');
  assert.equal(q.label.instructions, TASK.instructions);
  assert.deepEqual(q.label.criteria, TASK.criteria);
});

test('the hardened defense delimits the text and adds the note to every prompt form', () => {
  const t = withDefense(normalizeTask(TASK), 'hardened');
  assert.equal(wrapText(t, 'hi'), '<untrusted_input>\nhi\n</untrusted_input>');
  assert.ok(classificationPrompt({ task: t, text: 'hi' }).includes(HARDENED_NOTE));
  assert.ok(classificationPrompt({ task: t, text: 'hi' }).includes('<untrusted_input>\nhi\n</untrusted_input>'));
  assert.ok(decisionQuestions(t).label.instructions.endsWith(HARDENED_NOTE));
  // and nothing of it without the defense
  const plain = normalizeTask(TASK);
  assert.equal(wrapText(plain, 'hi'), 'hi');
  assert.ok(!decisionQuestions(plain).label.instructions.includes('untrusted'));
});

test('stratifiedSubset spreads --limit across labels and keeps order within a label', () => {
  const items = [
    { id: 1, truth: 'bug' }, { id: 2, truth: 'bug' }, { id: 3, truth: 'bug' },
    { id: 4, truth: 'feature' }, { id: 5, truth: 'feature' },
    { id: 6, truth: 'docs' },
  ];
  assert.deepEqual(stratifiedSubset(items, 4).map((i) => i.id), [1, 4, 6, 2]);
  assert.deepEqual(stratifiedSubset(items, 6).map((i) => i.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stratifiedSubset(items, 100).map((i) => i.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stratifiedSubset(items, null).length, 6);
});
