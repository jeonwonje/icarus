import './env.js';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import {
  GramJsTelegramAdapter,
  PollTracker,
  classifyDialog,
  inputPeerFromDialog,
  normalizeChannelDifference,
  normalizeGlobalDifference,
  normalizeMessage,
  normalizeUpdates,
  type TelegramReadClient,
} from '../src/connectors/telegram/adapter.js';
import { FakeTelegramAdapter } from '../src/connectors/telegram/fakeAdapter.js';
import type { TelegramDialog, TelegramMessage } from '../src/connectors/telegram/types.js';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

const dmPeer = new Api.PeerUser({ userId: bigInt(1) });

const ALICE: TelegramDialog = {
  peerKey: 'dm:1',
  kind: 'dm',
  title: 'Alice',
  accessHash: '11',
  selected: true,
};

function dmMessage(id: number, args: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) {
  return new Api.Message({
    id,
    peerId: dmPeer,
    date: 1700000000,
    message: '',
    ...args,
  });
}

function documentMedia(): Api.MessageMediaDocument {
  return new Api.MessageMediaDocument({
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
}

function tempPath(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'icarus-tg-adapter-')), name);
}

interface StubBehavior {
  invoke?: (request: Api.AnyRequest) => Promise<unknown>;
  getMessages?: (params: Record<string, unknown>) => Promise<Api.Message[]>;
  downloadMedia?: (message: Api.Message, outputFile: WriteStream) => Promise<void>;
}

/** Stands in for the gramJS client so adapter call shapes can be asserted offline. */
class StubClient {
  readonly invoked: Api.AnyRequest[] = [];
  readonly getMessagesCalls: Record<string, unknown>[] = [];
  readonly downloaded: Api.Message[] = [];
  iterDialogsCalls = 0;
  getInputEntityCalls = 0;

  constructor(private readonly behavior: StubBehavior = {}) {}

  async invoke(request: Api.AnyRequest): Promise<unknown> {
    this.invoked.push(request);
    if (!this.behavior.invoke) throw new Error(`unexpected request: ${request.className}`);
    return this.behavior.invoke(request);
  }

  async getMessages(_peer: unknown, params: Record<string, unknown> = {}): Promise<Api.Message[]> {
    this.getMessagesCalls.push(params);
    return (await this.behavior.getMessages?.(params)) ?? [];
  }

  async downloadMedia(message: Api.Message, params: { outputFile?: unknown }): Promise<void> {
    this.downloaded.push(message);
    await this.behavior.downloadMedia?.(message, params.outputFile as WriteStream);
  }

  iterDialogs(): never {
    this.iterDialogsCalls += 1;
    throw new Error('iterDialogs must not run');
  }

  async getInputEntity(): Promise<never> {
    this.getInputEntityCalls += 1;
    throw new Error('getInputEntity must not run');
  }

  addEventHandler(): void {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async checkAuthorization(): Promise<boolean> {
    return true;
  }
}

function stubAdapter(behavior: StubBehavior = {}): {
  adapter: GramJsTelegramAdapter;
  client: StubClient;
} {
  const client = new StubClient(behavior);
  const adapter = new GramJsTelegramAdapter({
    apiId: 1,
    apiHash: 'hash',
    session: '',
    client: client as unknown as TelegramReadClient,
  });
  return { adapter, client };
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
  assert.equal(full.gap, false);
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
  // A slice is progress, not data loss: keep fetching from the intermediate state.
  assert.equal(slice.complete, false);
  assert.equal(slice.gap, false);
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
    gap: false,
  });

  // Too long is an unrecoverable gap: it advances past the lost range so the caller cannot
  // request the same pts forever, and flags that history must be reconciled instead.
  const tooLong = normalizeGlobalDifference(
    new Api.updates.DifferenceTooLong({ pts: 99 }),
    previous,
    OBSERVED_AT,
  );
  assert.deepEqual(tooLong, {
    events: [],
    globalState: '{"pts":99,"qts":2,"date":3,"seq":4}',
    complete: true,
    gap: true,
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
  assert.equal(partial.gap, false);
  assert.equal(partial.events.length, 1);

  const done = normalizeChannelDifference(
    new Api.updates.ChannelDifferenceEmpty({ final: true, pts: 43 }),
    OBSERVED_AT,
  );
  assert.deepEqual(done, {
    events: [],
    channelState: '{"pts":43}',
    complete: true,
    gap: false,
  });

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
  assert.equal(tooLong.complete, true);
  assert.equal(tooLong.gap, true);
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
    globalDifferences: [{ events: [], globalState: '{"pts":2}', complete: true, gap: false }],
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
    gap: false,
  });
  assert.deepEqual(await fake.getGlobalDifference('{"pts":2}'), {
    events: [],
    complete: true,
    gap: false,
  });
  assert.deepEqual(await fake.getChannelDifference('supergroup:2', undefined), {
    events: [],
    complete: true,
    gap: false,
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

test('countMessages reads the reported total without paginating history', async () => {
  const { adapter, client } = stubAdapter({
    invoke: async () =>
      new Api.messages.MessagesSlice({
        count: 4321,
        messages: [dmMessage(1)],
        chats: [],
        users: [],
      }),
  });
  adapter.primePeers([ALICE]);

  assert.equal(await adapter.countMessages('dm:1'), 4321);
  // getMessages(limit: 0) walks every page in gramJS; the count must cost one request.
  assert.equal(client.getMessagesCalls.length, 0);
  assert.equal(client.invoked.length, 1);
  const request = client.invoked[0];
  assert.ok(request instanceof Api.messages.GetHistory);
  assert.equal(request.limit, 1);
  assert.equal(request.offsetId, 0);
  assert.equal(request.addOffset, 0);
  assert.equal(request.minId, 0);
  assert.equal(request.maxId, 0);
});

test('countMessages falls back to the returned messages when Telegram reports no total', async () => {
  const { adapter } = stubAdapter({
    invoke: async () =>
      new Api.messages.Messages({ messages: [dmMessage(1), dmMessage(2)], chats: [], users: [] }),
  });
  adapter.primePeers([ALICE]);
  assert.equal(await adapter.countMessages('dm:1'), 2);
});

test('persisted dialogs rebuild input peers so a cold restart skips listDialogs', async () => {
  const { adapter, client } = stubAdapter({
    invoke: async () =>
      new Api.messages.ChannelMessages({
        pts: 1,
        count: 7,
        messages: [],
        topics: [],
        chats: [],
        users: [],
      }),
  });
  adapter.primePeers([
    ALICE,
    { peerKey: 'supergroup:2', kind: 'supergroup', title: 'Team', accessHash: '22', selected: true },
    { peerKey: 'group:3', kind: 'group', title: 'Basic', selected: true },
  ]);

  await adapter.countMessages('dm:1');
  await adapter.countMessages('supergroup:2');
  await adapter.countMessages('group:3');

  const peers = client.invoked.map((request) => (request as Api.messages.GetHistory).peer);
  const [dm, supergroup, group] = peers;
  assert.ok(dm instanceof Api.InputPeerUser);
  assert.equal(dm.userId.toString(), '1');
  assert.equal(dm.accessHash.toString(), '11');
  assert.ok(supergroup instanceof Api.InputPeerChannel);
  assert.equal(supergroup.channelId.toString(), '2');
  assert.equal(supergroup.accessHash.toString(), '22');
  assert.ok(group instanceof Api.InputPeerChat);
  assert.equal(group.chatId.toString(), '3');
  assert.equal(client.iterDialogsCalls, 0);
  assert.equal(client.getInputEntityCalls, 0);
});

test('input peers need an access hash for users and channels but not basic groups', () => {
  assert.equal(inputPeerFromDialog({ ...ALICE, accessHash: undefined }), undefined);
  assert.equal(
    inputPeerFromDialog({
      peerKey: 'supergroup:2',
      kind: 'supergroup',
      title: 'Team',
      selected: true,
    }),
    undefined,
  );
  const negative = inputPeerFromDialog({ ...ALICE, accessHash: '-9223372036854775808' });
  assert.ok(negative instanceof Api.InputPeerUser);
  assert.equal(negative.accessHash.toString(), '-9223372036854775808');
  const group = inputPeerFromDialog({
    peerKey: 'group:3',
    kind: 'group',
    title: 'Basic',
    selected: true,
  });
  assert.ok(group instanceof Api.InputPeerChat);
});

test('downloadMedia waits for the output stream to close before reporting bytes', async () => {
  const payload = Buffer.alloc(512 * 1024, 7);
  const message = dmMessage(10, { media: documentMedia() });
  const { adapter } = stubAdapter({
    getMessages: async () => [message],
    // gramJS closes the writer in a `finally` that can settle after downloadMedia resolves.
    downloadMedia: async (_message, outputFile) => {
      outputFile.write(payload);
      setTimeout(() => outputFile.close(), 25);
    },
  });
  adapter.primePeers([ALICE]);
  const output = tempPath('report.pdf');

  const bytes = await adapter.downloadMedia('dm:1', 10, 'dm:1:10:document:4242', output);

  assert.equal(bytes, payload.length);
  assert.equal(statSync(output).size, payload.length);
});

test('downloadMedia deletes the partial file when the transfer fails', async () => {
  const message = dmMessage(10, { media: documentMedia() });
  const { adapter } = stubAdapter({
    getMessages: async () => [message],
    downloadMedia: async (_message, outputFile) => {
      outputFile.write(Buffer.alloc(4096, 1));
      throw new Error('file reference expired');
    },
  });
  adapter.primePeers([ALICE]);
  const output = tempPath('report.pdf');

  await assert.rejects(
    () => adapter.downloadMedia('dm:1', 10, 'dm:1:10:document:4242', output),
    /file reference expired/,
  );
  assert.equal(existsSync(output), false);
});

test('downloadMedia refuses descriptors that are not photos or documents', async () => {
  const geo = new Api.MessageMediaGeo({
    geo: new Api.GeoPoint({ long: 1, lat: 2, accessHash: bigInt(0) }),
  });
  const { adapter, client } = stubAdapter({
    getMessages: async () => [dmMessage(12, { media: geo })],
  });
  adapter.primePeers([ALICE]);
  const output = tempPath('geo.bin');

  await assert.rejects(
    () => adapter.downloadMedia('dm:1', 12, 'dm:1:12:geo', output),
    /not a downloadable file/,
  );
  assert.equal(client.downloaded.length, 0);
  assert.equal(existsSync(output), false);
});

test('channel difference gaps reseed the position instead of replaying the same pts', async () => {
  const { adapter, client } = stubAdapter({
    invoke: async (request) => {
      if (request instanceof Api.updates.GetChannelDifference) {
        return new Api.updates.ChannelDifferenceTooLong({
          // Telegram may omit the dialog pts, which previously left the caller stuck.
          dialog: new Api.Dialog({
            peer: new Api.PeerChannel({ channelId: bigInt(2) }),
            topMessage: 21,
            readInboxMaxId: 0,
            readOutboxMaxId: 0,
            unreadCount: 0,
            unreadMentionsCount: 0,
            unreadReactionsCount: 0,
            notifySettings: new Api.PeerNotifySettings({}),
          }),
          messages: [],
          chats: [],
          users: [],
        });
      }
      if (request instanceof Api.channels.GetFullChannel) return { fullChat: { pts: 500 } };
      throw new Error(`unexpected request: ${request.className}`);
    },
  });
  adapter.primePeers([
    { peerKey: 'supergroup:2', kind: 'supergroup', title: 'Team', accessHash: '22', selected: true },
  ]);

  const result = await adapter.getChannelDifference('supergroup:2', '{"pts":10}');

  assert.equal(result.gap, true);
  assert.equal(result.complete, true);
  assert.equal(result.channelState, '{"pts":500}');
  assert.equal(client.invoked.length, 2);
});

test('difference messages take sender names from the response users and chats', () => {
  const state = new Api.updates.State({ pts: 10, qts: 0, date: 5, seq: 1, unreadCount: 0 });
  const global = normalizeGlobalDifference(
    new Api.updates.Difference({
      newMessages: [
        dmMessage(30, { fromId: new Api.PeerUser({ userId: bigInt(42) }), message: 'hi' }),
      ],
      newEncryptedMessages: [],
      otherUpdates: [
        new Api.UpdateEditMessage({
          message: dmMessage(31, {
            fromId: new Api.PeerUser({ userId: bigInt(42) }),
            message: 'hi again',
          }),
          pts: 11,
          ptsCount: 1,
        }),
      ],
      chats: [],
      users: [new Api.User({ id: bigInt(42), firstName: 'Alice', lastName: 'Adams' })],
      state,
    }),
    { pts: 1, qts: 2, date: 3, seq: 4 },
    OBSERVED_AT,
  );
  const names = global.events.map((event) =>
    event.type === 'message' || event.type === 'edit' ? event.message.senderName : undefined,
  );
  assert.deepEqual(names, ['Alice Adams', 'Alice Adams']);

  const channelMessage = new Api.Message({
    id: 32,
    peerId: new Api.PeerChannel({ channelId: bigInt(2) }),
    fromId: new Api.PeerUser({ userId: bigInt(43) }),
    date: 1700000000,
    message: 'group hello',
  });
  const channel = normalizeChannelDifference(
    new Api.updates.ChannelDifference({
      pts: 42,
      newMessages: [channelMessage],
      otherUpdates: [],
      chats: [],
      users: [new Api.User({ id: bigInt(43), username: 'bob' })],
    }),
    OBSERVED_AT,
  );
  assert.equal(
    channel.events[0].type === 'message' ? channel.events[0].message.senderName : undefined,
    'bob',
  );
});
