import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { classify, linksToHost, toPost, type BlueskyPost, type FeedItem } from '../src/bluesky.ts';
import { buildContent, escapeMarkdown, textToMarkdown } from '../src/render.ts';
import { runSync, type Env } from '../src/sync.ts';

const DID = 'did:plc:me';

function post(partial: Partial<BlueskyPost>): BlueskyPost {
  return {
    kind: 'plain',
    uri: `at://${DID}/app.bsky.feed.post/abc`,
    cid: 'cid1',
    text: 'Hello',
    facets: [],
    createdAt: '2026-10-01T12:00:00.000Z',
    embed: {},
    ...partial
  };
}

const noUpload = async () => null;

test('plain post ends with the comment block', async () => {
  const content = await buildContent(post({}), 'me.bsky.social', noUpload);
  assert.equal(content, [
    'Hello',
    '```pikahtml\n<div class="bluesky-conversation" data-at-uri="at://did:plc:me/app.bsky.feed.post/abc" data-cid="cid1"></div>\n```'
  ].join('\n\n'));
});

test('shortened links are restored from facets, including after emoji', () => {
  const text = '🙂 see example.com/long…';
  const prefix = new TextEncoder().encode('🙂 see ').length;
  const label = new TextEncoder().encode('example.com/long…').length;
  const markdown = textToMarkdown(text, [
    { index: { byteStart: prefix, byteEnd: prefix + label }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/long/path' }] }
  ]);
  assert.equal(markdown, '🙂 see [example.com/long…](https://example.com/long/path)');
});

test('a leading hashtag line is not turned into a title', () => {
  assert.equal(escapeMarkdown('#photography today'), '\\#photography today');
});

test('photos are uploaded and placed after the text', async () => {
  const uploads: string[] = [];
  const content = await buildContent(
    post({ kind: 'image', embed: { images: [{ fullsize: 'https://cdn/a.jpg', alt: 'A tree' }] } }),
    'me',
    async (source) => {
      uploads.push(source);
      return 'https://pika.page/micropub/media/1';
    }
  );
  assert.deepEqual(uploads, ['https://cdn/a.jpg']);
  assert.match(content, /!\[A tree\]\(https:\/\/pika\.page\/micropub\/media\/1\)/);
});

test('quote posts get a quote card and the quoted photos after it', async () => {
  const embed = {
    record: {
      uri: 'at://did:plc:other/app.bsky.feed.post/q1',
      author: { handle: 'friend.bsky.social', displayName: 'Friend' },
      value: { text: 'Quoted words' },
      embeds: [{ images: [{ fullsize: 'https://cdn/q.jpg' }] }]
    }
  };
  const item = post({ kind: classify(embed), embed });
  assert.equal(item.kind, 'quote');
  const content = await buildContent(item, 'me', async () => 'https://pika/q');
  assert.match(content, /data-quote-images="1"/);
  assert.match(content, /<strong>Friend<\/strong>/);
  assert.ok(content.indexOf('bluesky-import-card--quote') < content.indexOf('![](https://pika/q)'));
  assert.ok(content.trimEnd().endsWith('</div>\n```'));
});

test('quote with your own photos keeps both', async () => {
  const embed = {
    $type: 'app.bsky.embed.recordWithMedia#view',
    record: { record: { uri: 'at://did:plc:other/app.bsky.feed.post/q2', author: { handle: 'x' } } },
    media: { images: [{ fullsize: 'https://cdn/mine.jpg' }] }
  };
  const item = post({ kind: classify(embed), embed });
  assert.equal(item.kind, 'quote');
  const content = await buildContent(item, 'me', async (source) => (source.includes('mine') ? 'https://pika/mine' : null));
  assert.match(content, /!\[\]\(https:\/\/pika\/mine\)/);
  assert.match(content, /data-quote-images="0"/);
});

test('reposts, replies and other people are skipped', () => {
  const base: FeedItem = { post: { uri: 'at://x/app.bsky.feed.post/1', cid: 'c', author: { did: DID }, record: { text: 'hi', createdAt: '2026-10-01T00:00:00Z' } } };
  assert.ok(toPost(base, DID));
  assert.equal(toPost({ ...base, reason: { $type: 'repost' } }, DID), null);
  assert.equal(toPost({ post: { ...base.post!, record: { ...base.post!.record!, reply: {} } } }, DID), null);
  assert.equal(toPost({ post: { ...base.post!, author: { did: 'did:plc:someone' } } }, DID), null);
});

test('posts linking to the Pika site are detected', () => {
  assert.ok(linksToHost(post({ embed: { external: { uri: 'https://bryan.pika.page/posts/x' } } }), ['bryan.pika.page']));
  assert.ok(!linksToHost(post({ text: 'nothing here' }), ['bryan.pika.page']));
});

// --- Full run with fake storage and fake network ---

function fakeKv() {
  const data = new Map<string, string>();
  return {
    data,
    kv: {
      get: async (key: string) => data.get(key) ?? null,
      put: async (key: string, value: string) => void data.set(key, value),
      delete: async (key: string) => void data.delete(key)
    } as unknown as KVNamespace
  };
}

function feedItem(rkey: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { post: { uri: `at://${DID}/app.bsky.feed.post/${rkey}`, cid: `cid-${rkey}`, author: { did: DID, handle: 'me' }, record: { text: `post ${rkey}`, createdAt }, ...extra } };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function env(kv: KVNamespace, extra: Partial<Env> = {}): Env {
  return { STATE: kv, PIKA_MICROPUB_TOKEN: 't', BLUESKY_DID: DID, BLUESKY_HANDLE: 'me', START_AFTER: '2026-10-01T00:00:00Z', SKIP_LINK_HOSTS: 'bryan.pika.page', MAX_POSTS_PER_RUN: '2', ...extra };
}

test('publishes oldest first, respects the per-run limit, and remembers progress', async () => {
  const { kv, data } = fakeKv();
  const published: Array<{ published: string; status: string; tags: string[] }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('getAuthorFeed')) {
      return Response.json({
        feed: [
          feedItem('c', '2026-10-03T00:00:00Z'),
          feedItem('b', '2026-10-02T00:00:00Z'),
          feedItem('a', '2026-10-01T06:00:00Z'),
          feedItem('old', '2026-09-30T00:00:00Z')
        ]
      });
    }
    if (url === 'https://pika.page/micropub') {
      const body = JSON.parse(String(init?.body));
      published.push({ published: body.properties.published[0], status: body.properties['post-status'][0], tags: body.properties.category });
      return new Response(null, { status: 201, headers: { location: `https://bryan.pika.page/posts/${published.length}` } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const first = await runSync(env(kv));
  assert.deepEqual(published.map((p) => p.published), ['2026-10-01T06:00:00Z', '2026-10-02T00:00:00Z']);
  assert.ok(published.every((p) => p.status === 'published' && p.tags[0] === 'bluesky'));
  assert.equal(first.cursorAfter, '2026-10-02T00:00:00Z');
  assert.equal(data.get('cursor'), '2026-10-02T00:00:00Z');

  await runSync(env(kv));
  assert.equal(published.length, 3);
  assert.equal(published[2].published, '2026-10-03T00:00:00Z');

  await runSync(env(kv));
  assert.equal(published.length, 3, 'nothing is posted twice');
});

test('dry run posts nothing and saves nothing', async () => {
  const { kv, data } = fakeKv();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('getAuthorFeed')) return Response.json({ feed: [feedItem('a', '2026-10-02T00:00:00Z')] });
    throw new Error('should not post');
  }) as typeof fetch;
  const report = await runSync(env(kv), { dryRun: true });
  assert.deepEqual(report.results.map((r) => r.outcome), ['would-publish']);
  assert.equal(data.size, 0);
});

test('rate limiting stops the run without losing the post', async () => {
  const { kv, data } = fakeKv();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('getAuthorFeed')) return Response.json({ feed: [feedItem('a', '2026-10-02T00:00:00Z')] });
    return new Response('slow down', { status: 429 });
  }) as typeof fetch;
  const report = await runSync(env(kv));
  assert.equal(report.results[0].outcome, 'rate-limited');
  assert.equal(data.get('cursor'), undefined);
  assert.equal(data.get(`sent:at://${DID}/app.bsky.feed.post/a`), undefined);
});

test('a post that keeps failing is skipped after three tries', async () => {
  const { kv } = fakeKv();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('getAuthorFeed')) return Response.json({ feed: [feedItem('b', '2026-10-03T00:00:00Z'), feedItem('a', '2026-10-02T00:00:00Z')] });
    return new Response('{"error":"invalid_request"}', { status: 422 });
  }) as typeof fetch;
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) outcomes.push((await runSync(env(kv, { MAX_POSTS_PER_RUN: '1' }))).results.map((r) => r.outcome).join(','));
  assert.deepEqual(outcomes, ['failed', 'failed', 'skipped-after-failures']);
});

test('posts linking back to Pika are skipped and not counted', async () => {
  const { kv } = fakeKv();
  let posted = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('getAuthorFeed')) {
      return Response.json({ feed: [feedItem('a', '2026-10-02T00:00:00Z', { embed: { external: { uri: 'https://bryan.pika.page/posts/hi' } } })] });
    }
    posted += 1;
    return new Response(null, { status: 201, headers: { location: 'x' } });
  }) as typeof fetch;
  const report = await runSync(env(kv));
  assert.equal(report.results[0].outcome, 'skipped-own-site-link');
  assert.equal(posted, 0);
});
