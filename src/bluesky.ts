// Reads your own Bluesky posts from the public API. No login needed.

export interface ImageView {
  fullsize?: string;
  thumb?: string;
  thumbnail?: string;
  alt?: string;
}

export interface ExternalView {
  uri?: string;
  title?: string;
  description?: string;
  thumb?: string;
}

export interface QuoteView {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string; displayName?: string };
  value?: { text?: string };
  embeds?: EmbedView[];
}

export interface EmbedView {
  $type?: string;
  images?: ImageView[];
  items?: ImageView[];
  external?: ExternalView;
  // In a plain quote this is the quoted post. In a quote-with-media it wraps it one level deeper.
  record?: QuoteView & { record?: QuoteView };
  media?: EmbedView;
  playlist?: string;
  thumbnail?: string;
}

export interface Facet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: Array<{ $type?: string; uri?: string; did?: string; tag?: string }>;
}

export interface FeedItem {
  reason?: unknown;
  post?: {
    uri?: string;
    cid?: string;
    author?: { did?: string; handle?: string };
    record?: { text?: string; createdAt?: string; reply?: unknown; facets?: Facet[] };
    embed?: EmbedView;
  };
}

export type PostKind = 'plain' | 'external' | 'quote' | 'image' | 'video';

export interface BlueskyPost {
  kind: PostKind;
  uri: string;
  cid: string;
  text: string;
  facets: Facet[];
  createdAt: string;
  embed: EmbedView;
}

export function postUrl(uri: string, handle: string): string {
  const rkey = uri.split('/').at(-1) ?? '';
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`;
}

export function quotedPost(embed: EmbedView): QuoteView | undefined {
  const record = embed.record;
  if (!record) return undefined;
  if (record.uri) return record;
  if (record.record?.uri) return record.record;
  return undefined;
}

export function ownImages(embed: EmbedView): ImageView[] {
  return embed.images ?? embed.items ?? embed.media?.images ?? embed.media?.items ?? [];
}

export function classify(embed: EmbedView | undefined): PostKind {
  if (!embed) return 'plain';
  const type = embed.$type ?? '';
  if (type.includes('video#view') || embed.playlist || embed.media?.playlist) return 'video';
  if (quotedPost(embed)) return 'quote';
  if (embed.external?.uri || embed.media?.external?.uri) return 'external';
  if (ownImages(embed).length > 0) return 'image';
  return 'plain';
}

// Every link a post makes, from its facets, its link card and the post it quotes.
export function linkedUrls(post: BlueskyPost): string[] {
  const urls: string[] = [];
  for (const facet of post.facets) {
    for (const feature of facet.features ?? []) if (feature.uri) urls.push(feature.uri);
  }
  const external = post.embed.external ?? post.embed.media?.external;
  if (external?.uri) urls.push(external.uri);
  urls.push(...(post.text.match(/https?:\/\/\S+/g) ?? []));
  return urls;
}

export function linksToHost(post: BlueskyPost, hosts: string[]): boolean {
  if (hosts.length === 0) return false;
  return linkedUrls(post).some((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
      return hosts.some((skip) => host === skip || host.endsWith(`.${skip}`));
    } catch {
      return hosts.some((skip) => value.toLowerCase().includes(skip));
    }
  });
}

export function toPost(item: FeedItem, did: string): BlueskyPost | null {
  const post = item.post;
  const record = post?.record;
  if (!post?.uri || !post.cid || !record?.createdAt) return null;
  // Only your own top-level posts: no reposts, no replies.
  if (post.author?.did !== did || item.reason || record.reply) return null;
  return {
    kind: classify(post.embed),
    uri: post.uri,
    cid: post.cid,
    text: record.text ?? '',
    facets: record.facets ?? [],
    createdAt: record.createdAt,
    embed: post.embed ?? {}
  };
}

// Newest posts first, stopping once posts are older than `after`.
export async function postsSince(did: string, after: number, maxPages = 5): Promise<BlueskyPost[]> {
  const posts: BlueskyPost[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL('/xrpc/app.bsky.feed.getAuthorFeed', 'https://public.api.bsky.app');
    url.searchParams.set('actor', did);
    url.searchParams.set('filter', 'posts_with_replies');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bluesky feed request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { feed?: FeedItem[]; cursor?: string };
    let reachedOlder = false;
    for (const item of body.feed ?? []) {
      const created = Date.parse(item.post?.record?.createdAt ?? '');
      // Pinned posts can appear out of order, so keep scanning the page.
      if (Number.isFinite(created) && created <= after) {
        if (!item.reason) reachedOlder = true;
        continue;
      }
      const post = toPost(item, did);
      if (post) posts.push(post);
    }
    cursor = body.cursor;
    if (reachedOlder || !cursor) break;
  }
  return posts;
}

// Image fallback: when Bluesky's image CDN fails, fetch the original from the author's server.
export async function fetchBlobFromPds(cdnUrl: string): Promise<Blob | null> {
  const match = cdnUrl.match(/\/plain\/([^/]+)\/([^/@?]+)/);
  if (!match) return null;
  const did = decodeURIComponent(match[1]);
  const cid = match[2];
  const didResponse = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
  if (!didResponse.ok) return null;
  const doc = (await didResponse.json()) as { service?: Array<{ type?: string; serviceEndpoint?: string }> };
  const pds = doc.service?.find((service) => service.type === 'AtprotoPersonalDataServer')?.serviceEndpoint;
  if (!pds) return null;
  const blobUrl = new URL('/xrpc/com.atproto.sync.getBlob', pds);
  blobUrl.searchParams.set('did', did);
  blobUrl.searchParams.set('cid', cid);
  const blobResponse = await fetch(blobUrl);
  return blobResponse.ok ? blobResponse.blob() : null;
}
