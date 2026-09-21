import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, forbiddenTerms, BLOCK_PATTERNS } from '../scripts/lint-no-secrets.mjs';

test('scanText flags key-shaped strings and .env assignments', () => {
  assert.deepEqual(scanText('nothing here'), []);
  assert.ok(scanText('OPENROUTER_API_KEY=abc').includes('OPENROUTER_API_KEY assignment'));
  assert.deepEqual(scanText('OPENROUTER_API_KEY='), []);
  assert.ok(scanText('key: sk-ant-' + 'a'.repeat(30)).some((h) => /Anthropic key/.test(h)));
  assert.ok(scanText('Authorization: Bearer ' + 'x'.repeat(40)).some((h) => /Bearer/.test(h)));
  assert.ok(BLOCK_PATTERNS.length >= 5);
});

test('forbidden terms are decoded from hex and matched case-insensitively, without appearing here', () => {
  const terms = forbiddenTerms(['6162636465', '78797a']); // "abcde", "xyz"
  assert.deepEqual(terms, ['abcde', 'xyz']);
  assert.equal(scanText('plain text', { terms }).length, 0);
  assert.equal(scanText('an ABCDE inside', { terms }).length, 1);
  assert.match(scanText('xyz', { terms })[0], /forbidden term \(3 chars, starts with "x"\)/);
  // the real list is non-empty and every entry is lower-case ascii
  const real = forbiddenTerms();
  assert.ok(real.length >= 4);
  for (const t of real) assert.match(t, /^[a-z0-9-]+$/);
});
