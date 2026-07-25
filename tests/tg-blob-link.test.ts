import './env.js';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TelegramBlobStore } from '../src/connectors/telegram/blobStore.js';
import { LinkSnapshotter } from '../src/connectors/telegram/linkSnapshot.js';

test('blob store hashes and deduplicates files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'icarus-tg-blob-'));
  const input = path.join(root, 'input.part');
  writeFileSync(input, 'same');
  const store = new TelegramBlobStore(path.join(root, 'archive'), () => 20 * 1024 ** 3);
  const first = await store.putFile(input);
  writeFileSync(input, 'same');
  const second = await store.putFile(input);
  assert.equal(first.hash, second.hash);
  assert.equal(first.path, second.path);
  assert.ok(existsSync(first.path));
});

test('blob store reports low disk without writing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'icarus-tg-space-'));
  const store = new TelegramBlobStore(root, () => 9 * 1024 ** 3);
  assert.equal(store.hasFreeSpace(10 * 1024 ** 3), false);
});

test('blob store removes media and link snapshot forms by hash', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'icarus-tg-delete-'));
  const mediaInput = path.join(root, 'media.part');
  writeFileSync(mediaInput, 'media');
  const store = new TelegramBlobStore(path.join(root, 'archive'));
  const media = await store.putFile(mediaInput);
  const link = await store.putBuffer(Buffer.from('snapshot'), '.txt');
  const bareLink = await store.putBuffer(Buffer.from('bare snapshot'));
  store.deleteBlob(media.hash);
  store.deleteBlob(link.hash);
  store.deleteBlob(bareLink.hash);
  assert.equal(existsSync(media.path), false);
  assert.equal(existsSync(link.path), false);
  assert.equal(existsSync(bareLink.path), false);
});

test('link snapshot enforces text normalization and response limits', async () => {
  const fetcher: typeof fetch = async () =>
    new Response('<html><body><h1>Title</h1><script>bad()</script><p>Body</p></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  const snapshotter = new LinkSnapshotter(fetcher);
  const result = await snapshotter.snapshot('https://example.com/a');
  assert.equal(result.status, 'complete');
  assert.match(result.text ?? '', /Title\s+Body/);
  assert.doesNotMatch(result.text ?? '', /bad/);
});

test('link snapshot cancels bodies it rejects from response headers', async () => {
  const cases = [
    new Response('error', { status: 500 }),
    new Response('oversized', {
      headers: { 'content-type': 'text/plain', 'content-length': String(6 * 1024 * 1024) },
    }),
    new Response('binary', { headers: { 'content-type': 'image/png' } }),
  ];
  for (const response of cases) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const tracked = new Response(stream, { status: response.status, headers: response.headers });
    const snapshotter = new LinkSnapshotter(async () => tracked);
    assert.equal((await snapshotter.snapshot('https://example.com/a')).status, 'unavailable');
    assert.equal(cancelled, true);
  }
});

test('link snapshot parses exact media types and HTML case-insensitively', async () => {
  const jsonp = new LinkSnapshotter(async () =>
    new Response('callback({})', { headers: { 'content-type': 'application/jsonp' } }),
  );
  assert.equal((await jsonp.snapshot('https://example.com/a')).status, 'unavailable');

  const html = new LinkSnapshotter(async () =>
    new Response('<h1>Title</h1><script>bad()</script>', {
      headers: { 'content-type': 'TEXT/HTML; charset=utf-8' },
    }),
  );
  const result = await html.snapshot('https://example.com/a');
  assert.equal(result.status, 'complete');
  assert.equal(result.text, 'Title');
});
