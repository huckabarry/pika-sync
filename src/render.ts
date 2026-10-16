// Turns a Bluesky post into Pika post content (Markdown with pikahtml blocks).
// The card and comment markup matches what the August backfill produced and
// what the custom script on bryan.pika.page expects.

import { ownImages, postUrl, quotedPost, type BlueskyPost, type ExternalView, type Facet, type ImageView, type QuoteView } from './bluesky.ts';

// Uploads an image to Pika and returns its Pika URL, or null if it could not be copied.
export type Uploader = (source: string, index: number) => Promise<string | null>;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeMarkdown(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replace(/([\[\]_*`])/g, '\\$1')
    // A line starting with # would turn into a heading, and Pika uses a leading heading as the title.
    .replace(/^(\s*)#/gm, '$1\\#');
}

// Bluesky shortens long links in the visible text and keeps the full address in "facets".
// This restores them as real Markdown links. Facet positions are counted in UTF-8 bytes.
export function textToMarkdown(text: string, facets: Facet[]): string {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const links = facets
    .map((facet) => {
      const start = facet.index?.byteStart;
      const end = facet.index?.byteEnd;
      const feature = facet.features?.find((f) => f.uri || f.did);
      if (start === undefined || end === undefined || !feature || start < 0 || end > bytes.length || start >= end) return null;
      const href = feature.uri ?? `https://bsky.app/profile/${feature.did}`;
      return { start, end, href };
    })
    .filter((link): link is { start: number; end: number; href: string } => link !== null)
    .sort((a, b) => a.start - b.start);

  let out = '';
  let position = 0;
  for (const link of links) {
    if (link.start < position) continue;
    out += escapeMarkdown(decoder.decode(bytes.slice(position, link.start)));
    const label = decoder.decode(bytes.slice(link.start, link.end));
    out += `[${escapeMarkdown(label)}](${link.href.replace(/\)/g, '%29')})`;
    position = link.end;
  }
  out += escapeMarkdown(decoder.decode(bytes.slice(position)));
  return out;
}

export function externalCard(external: ExternalView, localThumb?: string | null): string {
  if (!external.uri) return '';
  let domain = external.uri;
  try {
    domain = new URL(external.uri).hostname.replace(/^www\./, '');
  } catch {
    // keep the raw value
  }
  return [
    '<article class="bluesky-import-card bluesky-import-card--external">',
    `  <a href="${escapeHtml(external.uri)}" rel="noopener noreferrer">`,
    localThumb ? `    <img src="${escapeHtml(localThumb)}" alt="">` : '',
    `    <small>${escapeHtml(domain)}</small>`,
    external.title ? `    <strong>${escapeHtml(external.title)}</strong>` : '',
    external.description ? `    <span>${escapeHtml(external.description)}</span>` : '',
    '  </a>',
    '</article>'
  ].filter(Boolean).join('\n');
}

export function quoteCard(quote: QuoteView, imageCount: number, fallbackHandle: string): string {
  if (!quote.uri) return '';
  const handle = quote.author?.handle ?? '';
  const label = quote.author?.displayName || (handle ? `@${handle}` : 'Quoted post');
  return [
    `<blockquote class="bluesky-import-card bluesky-import-card--quote" data-quote-images="${imageCount}">`,
    `  <a href="${escapeHtml(postUrl(quote.uri, handle || fallbackHandle))}" rel="noopener noreferrer"><strong>${escapeHtml(label)}</strong></a>`,
    quote.value?.text ? `  <p>${escapeHtml(quote.value.text)}</p>` : '',
    '</blockquote>'
  ].filter(Boolean).join('\n');
}

export function conversationMarker(post: BlueskyPost): string {
  return `<div class="bluesky-conversation" data-at-uri="${escapeHtml(post.uri)}" data-cid="${escapeHtml(post.cid)}"></div>`;
}

function pikaHtml(html: string): string {
  return `\`\`\`pikahtml\n${html}\n\`\`\``;
}

function imageSource(image: ImageView): string | undefined {
  return image.fullsize ?? image.thumb ?? image.thumbnail;
}

async function uploadAll(images: ImageView[], upload: Uploader): Promise<string[]> {
  const parts: string[] = [];
  for (const [index, image] of images.entries()) {
    const source = imageSource(image);
    if (!source) continue;
    const url = await upload(source, index);
    if (url) parts.push(`![${escapeMarkdown(image.alt ?? '')}](${url})`);
  }
  return parts;
}

export async function buildContent(post: BlueskyPost, handle: string, upload: Uploader): Promise<string> {
  const parts: string[] = [textToMarkdown(post.text, post.facets)];

  // Your own photos, including the photos on a quote-with-photos post.
  const images = ownImages(post.embed);
  if (images.length > 0) {
    const uploaded = await uploadAll(images, upload);
    parts.push(...uploaded);
    if (uploaded.length === 0) parts.push(`[View the original image post on Bluesky](${postUrl(post.uri, handle)})`);
  }

  let card = '';
  const trailing: string[] = [];
  if (post.kind === 'external') {
    const external = post.embed.external ?? post.embed.media?.external ?? {};
    const thumb = external.thumb ? await upload(external.thumb, 0) : null;
    card = externalCard(external, thumb);
  }
  if (post.kind === 'quote') {
    const quote = quotedPost(post.embed) ?? {};
    const quoteImages = await uploadAll(ownImages(quote.embeds?.[0] ?? {}), upload);
    card = quoteCard(quote, quoteImages.length, handle);
    // Your site script moves these photos inside the quote card.
    trailing.push(...quoteImages);
  }
  if (post.kind === 'video') {
    const thumbnail = post.embed.thumbnail ?? post.embed.media?.thumbnail;
    const poster = thumbnail ? await upload(thumbnail, 0) : null;
    card = [
      '<p class="bluesky-import-video">',
      `  <a href="${escapeHtml(postUrl(post.uri, handle))}" rel="noopener noreferrer">`,
      poster ? `    <img src="${escapeHtml(poster)}" alt="">` : '',
      '    <span>Watch this video on Bluesky</span>',
      '  </a>',
      '</p>'
    ].filter(Boolean).join('\n');
  }

  if (card) parts.push(pikaHtml(card));
  parts.push(...trailing);
  parts.push(pikaHtml(conversationMarker(post)));
  return parts.filter(Boolean).join('\n\n');
}
