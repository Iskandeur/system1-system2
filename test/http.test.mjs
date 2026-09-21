import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchJson, retryDelayMs } from '../src/http.mjs';

function responder(sequence) {
  let i = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init);
    const step = sequence[Math.min(i++, sequence.length - 1)];
    if (step.throw) throw Object.assign(new Error('boom'), { name: step.throw });
    return {
      ok: step.status < 400,
      status: step.status,
      headers: { get: (k) => (k === 'retry-after' ? step.retryAfter ?? null : null) },
      text: async () => JSON.stringify(step.body ?? {}),
    };
  };
  return { fetchImpl, seen };
}

test('retries 429/5xx and network errors with backoff, honouring Retry-After, then succeeds', async () => {
  const { fetchImpl, seen } = responder([{ status: 429, retryAfter: '2' }, { status: 502 }, { throw: 'TypeError' }, { status: 200, body: { ok: 1 } }]);
  const sleeps = [];
  const json = await fetchJson('https://x.example/v1', { body: { a: 1 }, fetchImpl, sleep: async (ms) => sleeps.push(ms), backoffMs: 100 });
  assert.deepEqual(json, { ok: 1 });
  assert.equal(seen.length, 4);
  assert.equal(sleeps[0], 2000); // Retry-After wins
  assert.ok(sleeps[1] >= 200 && sleeps[1] < 450); // 100 * 2^1 + jitter
  assert.ok(sleeps[2] >= 400 && sleeps[2] < 650);
});

test('gives up after `retries` attempts and does not retry 4xx other than 429', async () => {
  const r1 = responder([{ status: 503 }]);
  await assert.rejects(fetchJson('https://x.example/v1', { fetchImpl: r1.fetchImpl, sleep: async () => {}, retries: 2 }), /HTTP 503 from x\.example/);
  assert.equal(r1.seen.length, 3);

  const r2 = responder([{ status: 400, body: { error: { message: 'bad request' } } }]);
  await assert.rejects(fetchJson('https://x.example/v1', { fetchImpl: r2.fetchImpl, sleep: async () => {} }), /HTTP 400 from x\.example: bad request/);
  assert.equal(r2.seen.length, 1);
});

test('retryDelayMs caps Retry-After and grows exponentially otherwise', () => {
  assert.equal(retryDelayMs({ attempt: 0, backoffMs: 100, retryAfter: '600', jitter: () => 0 }), 120000);
  assert.equal(retryDelayMs({ attempt: 3, backoffMs: 1000, jitter: () => 0 }), 8000);
  assert.equal(retryDelayMs({ attempt: 20, backoffMs: 1000, jitter: () => 0 }), 60000);
});
