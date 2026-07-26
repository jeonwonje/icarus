import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanvasAuthError, CanvasRateLimitError, createCanvasClient } from '../src/connectors/canvasClient.js';

test('Authorization Bearer header and strips trailing slash', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer secret-token');
    assert.equal(headers.get('Accept'), 'application/json');
    return new Response(JSON.stringify([{ id: 1, name: 'CS' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com/',
    token: 'secret-token',
    fetchImpl,
  });
  const courses = await client.listCourses();
  assert.equal(courses.length, 1);
  assert.match(calls[0]!, /^https:\/\/school\.instructure\.com\/api\/v1\/courses\?/);
});

test('paginates via Link rel=next', async () => {
  let n = 0;
  const fetchImpl: typeof fetch = async () => {
    n++;
    if (n === 1) {
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Link: '<https://school.instructure.com/api/v1/courses?page=2&per_page=100>; rel="next"',
        },
      });
    }
    return new Response(JSON.stringify([{ id: 2 }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com',
    token: 't',
    fetchImpl,
  });
  const courses = await client.listCourses();
  assert.deepEqual(courses.map((c) => c.id), [1, 2]);
});

test('401 throws CanvasAuthError', async () => {
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com',
    token: 'bad',
    fetchImpl: async () => new Response('nope', { status: 401 }),
  });
  await assert.rejects(() => client.listCourses(), CanvasAuthError);
});

test('403 throws CanvasAuthError', async () => {
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com',
    token: 'bad',
    fetchImpl: async () => new Response('forbidden', { status: 403 }),
  });
  await assert.rejects(() => client.listCourses(), CanvasAuthError);
});

test('429 throws CanvasRateLimitError', async () => {
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com',
    token: 't',
    fetchImpl: async () => new Response('slow', { status: 429 }),
  });
  await assert.rejects(() => client.listCourses(), CanvasRateLimitError);
});
