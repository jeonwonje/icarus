import './env.js';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import {
  GramJsTelegramAdapter,
  PollTracker,
  classifyDialog,
  normalizeChannelDifference,
  normalizeGlobalDifference,
  normalizeMessage,
  normalizeUpdates,
} from '../src/connectors/telegram/adapter.js';
import { FakeTelegramAdapter } from '../src/connectors/telegram/fakeAdapter.js';
import type { TelegramMessage } from '../src/connectors/telegram/types.js';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

const dmPeer = new Api.PeerUser({ userId: bigInt(1) });

function dmMessage(id: number, args: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) {
  return new Api.Message({
    id,
    peerId: dmPeer,
    date: 1700000000,
    message: '',
    ...args,
  });
}

test('dialog classifier accepts only DMs and groups', () => {
  assert.equal(classifyDialog({ isUser: true, isGroup: false, isChannel: false }), 'dm');
  assert.equal(classifyDialog({ isUser: false, isGroup: true, isChannel: false }), 'group');
  assert.equal(classifyDialog({ isUser: false, isGroup: true, isChannel: true }), 'supergroup');
  assert.equal(classifyDialog({ isUser: false, isGroup: false, isChannel: true }), undefined);
});

test('fake adapter exposes only read operations and deterministic history', async () => {
  const fake = new FakeTelegramAdapter({
    dialogs: [{ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: false }],
    messages: { 'dm:1': [] },
  });
  assert.deepEqual(await fake.listDialogs(), [
    { peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: false },
  ]);
  for (const forbidden of ['sendMessage', 'editMessage', 'deleteMessages', 'markAsRead']) {
    assert.equal(forbidden in fake, false);
  }
});

test('normalizeMessage keeps edits, replies, grouping, reactions, and poll state', () => {
  const reactions = new Api.MessageReactions({
    results: [
      new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '👍' }), count: 2 }),
    ],
  });
  const media = new Api.MessageMediaPoll({
    poll: new Api.Poll({
      id: bigInt(555),
      closed: true,
      question: new Api.TextWithEntities({ text: 'Lunch?', entities: [] }),
      answers: [
        new Api.PollAnswer({
          text: new Api.TextWithEntities({ text: 'Yes', entities: [] }),
          option: Buffer.from([0]),
        }),
        new Api.PollAnswer({
          text: new Api.TextWithEntities({ text: 'No', entities: [] }),
          option: Buffer.from([1]),
        }),
      ],
    }),
    results: new Api.PollResults({
      results: [
        new Api.PollAnswerVoters({ option: Buffer.from([0]), voters: 3, chosen: true }),
        new Api.PollAnswerVoters({ option: Buffer.from([1]), voters: 1 }),
      ],
      totalVoters: 4,
    }),
  });
  const message = dmMessage(9, {
    fromId: new Api.PeerUser({ userId: bigInt(42) }),
    message: 'pick one',
    editDate: 1700000100,
    replyTo: new Api.MessageReplyHeader({ replyToMsgId: 3 }),
    groupedId: bigInt(77),
    reactions,
    media,
  });

  const normalized = normalizeMessage('dm:1', message, 'Alice');

  assert.equal(normalized.peerKey, 'dm:1');
  assert.equal(normalized.messageId, 9);
  assert.equal(normalized.senderKey, '42');
  assert.equal(normalized.senderName, 'Alice');
  assert.equal(normalized.sentAt, '2023-11-14T22:13:20.000Z');
  assert.equal(normalized.editedAt, '2023-11-14T22:15:00.000Z');
  assert.equal(normalized.replyToMessageId, 3);
  assert.equal(normalized.groupedId, '77');
  assert.equal(normalized.text, 'pick one');
  assert.equal(JSON.parse(normalized.reactionsJson).className, 'MessageReactions');
  assert.deepEqual(normalized.poll, {
    pollId: '555',
    question: 'Lunch?',
    closed: true,
    options: [
      { optionKey: 'AA==', text: 'Yes', voters: 3, chosen: true },
      { optionKey: 'AQ==', text: 'No', voters: 1, chosen: false },
    ],
  });
  assert.deepEqual(normalized.media, []);
});

test('normalizeMessage retains descriptors for documents and unsupported media', () => {
  const document = new Api.MessageMediaDocument({
    document: new Api.Document({
      id: bigInt(4242),
      accessHash: bigInt(1),
      fileReference: Buffer.from([1]),
      date: 1700000000,
      mimeType: 'application/pdf',
      size: bigInt(2048),
      dcId: 2,
      attributes: [new Api.DocumentAttributeFilename({ fileName: 'report.pdf' })],
    }),
  });
  const withDocument = normalizeMessage('dm:1', dmMessage(10, { media: document }));
  assert.deepEqual(withDocument.media, [
    {
      mediaKey: 'dm:1:10:document:4242',
      kind: 'document',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      descriptorJson: withDocument.media[0].descriptorJson,
    },
  ]);
  assert.equal(JSON.parse(withDocument.media[0].descriptorJson).className, 'MessageMediaDocument');

  const unsupported = normalizeMessage('dm:1', dmMessage(11, { media: new Api.MessageMediaUnsupported() }));
  assert.equal(unsupported.media.length, 1);
  assert.equal(unsupported.media[0].kind, 'unsupported');
  assert.equal(unsupported.media[0].mediaKey, 'dm:1:11:unsupported');

  const geo = normalizeMessage('dm:1', dmMessage(12, {
    media: new Api.MessageMediaGeo({ geo: new Api.GeoPoint({ long: 1, lat: 2, accessHash: bigInt(0) }) }),
  }));
  assert.equal(geo.media.length, 1);
  assert.equal(geo.media[0].kind, 'geo');
});

test('normalizeMessage deduplicates links and attaches web page previews', () => {
  const text = 'see https://example.com/a and https://example.com/a plus link';
  const message = dmMessage(13, {
    message: text,
    entities: [
      new Api.MessageEntityTextUrl({
        offset: text.indexOf('link'),
        length: 4,
        url: 'https://example.com/b',
      }),
      new Api.MessageEntityUrl({ offset: text.indexOf('https'), length: 21 }),
    ],
    media: new Api.MessageMediaWebPage({
      webpage: new Api.WebPage({
        id: bigInt(3),
        url: 'https://example.com/a',
        displayUrl: 'example.com/a',
        hash: 0,
        siteName: 'Example',
        title: 'Title',
        description: 'Description',
      }),
    }),
  });

  const normalized = normalizeMessage('dm:1', message);
  const urls = normalized.links.map((link) => link.url).sort();
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.com/b']);
  const preview = normalized.links.find((link) => link.url === 'https://example.com/a')?.previewJson;
  assert.equal(JSON.parse(preview ?? '{}').siteName, 'Example');
  assert.equal(normalized.media.length, 0);
});

test('raw updates normalize into reaction and poll domain events', () => {
  const reactions = new Api.MessageReactions({
    results: [
      new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '🎉' }), count: 1 }),
    ],
  });
  const [reactionEvent] = normalizeUpdates(
    [new Api.UpdateMessageReactions({ peer: dmPeer, msgId: 9, reactions })],
    OBSERVED_AT,
  );
  assert.deepEqual(reactionEvent, {
    type: 'reactions',
    peerKey: 'dm:1',
    messageId: 9,
    reactionsJson: JSON.stringify(reactions),
    observedAt: OBSERVED_AT,
  });

  const polls = new PollTracker();
  const pollMessage = normalizeMessage(
    'dm:1',
    dmMessage(14, {
      media: new Api.MessageMediaPoll({
        poll: new Api.Poll({
          id: bigInt(555),
          question: new Api.TextWithEntities({ text: 'Lunch?', entities: [] }),
          answers: [
            new Api.PollAnswer({
              text: new Api.TextWithEntities({ text: 'Yes', entities: [] }),
              option: Buffer.from([0]),
            }),
          ],
        }),
        results: new Api.PollResults({}),
      }),
    }),
  );
  polls.observe(pollMessage);
  const events = normalizeUpdates(
    [
      new Api.UpdateMessagePoll({
        pollId: bigInt(555),
        results: new Api.PollResults({
          results: [new Api.PollAnswerVoters({ option: Buffer.from([0]), voters: 5, chosen: true })],
          totalVoters: 5,
        }),
      }),
    ],
    OBSERVED_AT,
    polls,
  );
  assert.deepEqual(events, [
    {
      type: 'poll',
      peerKey: 'dm:1',
      messageId: 14,
      poll: {
        pollId: '555',
        question: 'Lunch?',
        closed: false,
        options: [{ optionKey: 'AA==', text: 'Yes', voters: 5, chosen: true }],
      },
      observedAt: OBSERVED_AT,
    },
  ]);

  assert.deepEqual(
    normalizeUpdates(
      [new Api.UpdateDeleteChannelMessages({ channelId: bigInt(2), messages: [4, 5], pts: 1, ptsCount: 2 })],
      OBSERVED_AT,
    ),
    [{ type: 'delete', peerKey: 'supergroup:2', messageIds: [4, 5], observedAt: OBSERVED_AT }],
  );
  assert.deepEqual(
    normalizeUpdates(
      [new Api.UpdateDeleteMessages({ messages: [6], pts: 1, ptsCount: 1 })],
      OBSERVED_AT,
    ),
    [{ type: 'delete', peerKey: undefined, messageIds: [6], observedAt: OBSERVED_AT }],
  );
});

test('global difference results serialize durable update positions', () => {
  const previous = { pts: 1, qts: 2, date: 3, seq: 4 };
  const state = new Api.updates.State({ pts: 10, qts: 0, date: 5, seq: 1, unreadCount: 0 });
  const full = normalizeGlobalDifference(
    new Api.updates.Difference({
      newMessages: [dmMessage(20, { message: 'missed' })],
      newEncryptedMessages: [],
      otherUpdates: [],
      chats: [],
      users: [],
      state,
    }),
    previous,
    OBSERVED_AT,
  );
  assert.equal(full.complete, true);
  assert.equal(full.globalState, '{"pts":10,"qts":0,"date":5,"seq":1}');
  assert.equal(full.events.length, 1);
  assert.equal(full.events[0].type === 'message' && full.events[0].message.text, 'missed');

  const slice = normalizeGlobalDifference(
    new Api.updates.DifferenceSlice({
      newMessages: [],
      newEncryptedMessages: [],
      otherUpdates: [],
      chats: [],
      users: [],
      intermediateState: state,
    }),
    previous,
    OBSERVED_AT,
  );
  assert.equal(slice.complete, false);
  assert.equal(slice.globalState, '{"pts":10,"qts":0,"date":5,"seq":1}');

  const empty = normalizeGlobalDifference(
    new Api.updates.DifferenceEmpty({ date: 9, seq: 8 }),
    previous,
    OBSERVED_AT,
  );
  assert.deepEqual(empty, {
    events: [],
    globalState: '{"pts":1,"qts":2,"date":9,"seq":8}',
    complete: true,
  });

  const tooLong = normalizeGlobalDifference(
    new Api.updates.DifferenceTooLong({ pts: 99 }),
    previous,
    OBSERVED_AT,
  );
  assert.deepEqual(tooLong, {
    events: [],
    globalState: '{"pts":99,"qts":2,"date":3,"seq":4}',
    complete: false,
  });
});

test('channel difference results serialize durable update positions', () => {
  const channelMessage = new Api.Message({
    id: 21,
    peerId: new Api.PeerChannel({ channelId: bigInt(2) }),
    date: 1700000000,
    message: 'group message',
  });
  const partial = normalizeChannelDifference(
    new Api.updates.ChannelDifference({
      pts: 42,
      newMessages: [channelMessage],
      otherUpdates: [],
      chats: [],
      users: [],
    }),
    OBSERVED_AT,
  );
  assert.equal(partial.channelState, '{"pts":42}');
  assert.equal(partial.complete, false);
  assert.equal(partial.events.length, 1);

  const done = normalizeChannelDifference(
    new Api.updates.ChannelDifferenceEmpty({ final: true, pts: 43 }),
    OBSERVED_AT,
  );
  assert.deepEqual(done, { events: [], channelState: '{"pts":43}', complete: true });

  const tooLong = normalizeChannelDifference(
    new Api.updates.ChannelDifferenceTooLong({
      dialog: new Api.Dialog({
        peer: new Api.PeerChannel({ channelId: bigInt(2) }),
        topMessage: 21,
        readInboxMaxId: 0,
        readOutboxMaxId: 0,
        unreadCount: 0,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        notifySettings: new Api.PeerNotifySettings({}),
        pts: 77,
      }),
      messages: [channelMessage],
      chats: [],
      users: [],
    }),
    OBSERVED_AT,
  );
  assert.equal(tooLong.channelState, '{"pts":77}');
  assert.equal(tooLong.complete, false);
  assert.equal(tooLong.events.length, 1);
});

test('gramJS adapter exposes no Telegram write operations', () => {
  const adapter = new GramJsTelegramAdapter({ apiId: 1, apiHash: 'hash', session: '' });
  for (const forbidden of [
    'sendMessage',
    'editMessage',
    'deleteMessages',
    'markAsRead',
    'forwardMessages',
    'sendFile',
    'invoke',
    'client',
  ]) {
    assert.equal(forbidden in adapter, false, `${forbidden} must not be reachable`);
  }
  for (const required of [
    'connect',
    'disconnect',
    'isAuthorized',
    'listDialogs',
    'countMessages',
    'fetchHistoryPage',
    'fetchMessage',
    'downloadMedia',
    'getGlobalDifference',
    'getChannelDifference',
    'onEvent',
    'onConnectionChange',
  ]) {
    assert.equal(typeof (adapter as unknown as Record<string, unknown>)[required], 'function');
  }
});

test('fake adapter paginates, clones, and downloads media without network', async () => {
  const base: TelegramMessage = {
    peerKey: 'dm:1',
    messageId: 1,
    sentAt: '2026-01-01T00:00:00.000Z',
    text: 'one',
    entitiesJson: '[]',
    reactionsJson: '[]',
    media: [],
    links: [],
  };
  const fake = new FakeTelegramAdapter({
    dialogs: [{ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true }],
    messages: {
      'dm:1': [base, { ...base, messageId: 2, text: 'two' }, { ...base, messageId: 3, text: 'three' }],
    },
    mediaFiles: { 'dm:1:1:photo:1': Buffer.from('payload') },
    globalDifferences: [{ events: [], globalState: '{"pts":2}', complete: true }],
  });

  assert.equal(await fake.countMessages('dm:1'), 3);
  const first = await fake.fetchHistoryPage('dm:1', null, 2);
  assert.deepEqual(first.messages.map((m) => m.messageId), [3, 2]);
  assert.equal(first.totalMessages, 3);
  assert.equal(first.nextBeforeMessageId, 2);
  const second = await fake.fetchHistoryPage('dm:1', first.nextBeforeMessageId, 2);
  assert.deepEqual(second.messages.map((m) => m.messageId), [1]);
  assert.equal(second.nextBeforeMessageId, null);

  const fetched = await fake.fetchMessage('dm:1', 1);
  fetched!.text = 'mutated';
  assert.equal((await fake.fetchMessage('dm:1', 1))?.text, 'one');
  assert.equal(await fake.fetchMessage('dm:1', 99), undefined);

  const root = mkdtempSync(path.join(tmpdir(), 'icarus-tg-fake-'));
  const output = path.join(root, 'photo.bin');
  assert.equal(await fake.downloadMedia('dm:1', 1, 'photo:1', output), 7);
  assert.equal(existsSync(output), true);
  assert.equal(readFileSync(output, 'utf8'), 'payload');
  assert.deepEqual(fake.downloads, ['dm:1:1:photo:1']);
  await assert.rejects(() => fake.downloadMedia('dm:1', 1, 'missing', output), /fake media missing/);

  assert.deepEqual(await fake.getGlobalDifference(undefined), {
    events: [],
    globalState: '{"pts":2}',
    complete: true,
  });
  assert.deepEqual(await fake.getGlobalDifference('{"pts":2}'), { events: [], complete: true });
  assert.deepEqual(await fake.getChannelDifference('supergroup:2', undefined), {
    events: [],
    complete: true,
  });
});

test('fake adapter notifies connection and event consumers with cloned payloads', async () => {
  const message: TelegramMessage = {
    peerKey: 'dm:1',
    messageId: 4,
    sentAt: '2026-01-01T00:00:00.000Z',
    text: 'live',
    entitiesJson: '[]',
    reactionsJson: '[]',
    media: [],
    links: [],
  };
  const fake = new FakeTelegramAdapter({ dialogs: [], messages: {} });
  const states: boolean[] = [];
  const seen: TelegramMessage[] = [];
  const offConnection = fake.onConnectionChange((connected) => states.push(connected));
  const offEvent = fake.onEvent(async (event) => {
    if (event.type === 'message') seen.push(event.message);
  });

  await fake.connect();
  assert.equal(fake.connected, true);
  assert.equal(await fake.isAuthorized(), true);
  await fake.emit({ type: 'message', message });
  await fake.disconnect();
  assert.deepEqual(states, [true, false]);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], message);
  assert.deepEqual(seen[0], message);

  offConnection();
  offEvent();
  await fake.connect();
  await fake.emit({ type: 'message', message });
  assert.deepEqual(states, [true, false]);
  assert.equal(seen.length, 1);
});
