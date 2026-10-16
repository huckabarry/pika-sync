// One sync pass: find Bluesky posts not yet on Pika and publish them, oldest first.

import { fetchBlobFromPds, linksToHost, postsSince, type BlueskyPost } from './bluesky.ts';
import { publishPost, RateLimited, uploadImage } from './pika.ts';
import { buildContent, type Uploader } from './render.ts';

export interface Env {
  STATE: KVNamespace;
  PIKA_MICROPUB_TOKEN?: string;
  ADMIN_TOKEN?: string;
  BLUESKY_DID: string;
  BLUESKY_HANDLE: string;
  START_AFTER: string;
  SKIP_LINK_HOSTS?: string;
  PIKA_TAG?: string;
  MAX_POSTS_PER_RUN?: string;
}

export type Outcome = 'published' | 'would-publish' | 'already-sent' | 'skipped-own-site-link' | 'skipped-after-failures' | 'failed' | 'rate-limited';

export interface ResultEntry {
  uri: string;
  createdAt: string;
  kind: string;
  outcome: Outcome;
  url?: string;
  error?: string;
}

export interface RunReport {
  dryRun: boolean;
  startedAt: string;
  cursorBefore: string;
  cursorAfter: string;
  found: number;
  results: ResultEntry[];
}

const MAX_FAILURES = 3;

function hosts(env: Env): string[] {
  return (env.SKIP_LINK_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
}

function makeUploader(token: string, uri: string): Uploader {
  return async (source, index) => {
    try {
      let response = await fetch(source);
      let blob = response.ok ? await response.blob() : null;
      if (!blob) blob = await fetchBlobFromPds(source);
      if (!blob) throw new Error(`image download failed: HTTP ${response.status}`);
      return await uploadImage(token, blob, index);
    } catch (error) {
      if (error instanceof RateLimited) throw error;
      console.warn(JSON.stringify({ imageSkipped: true, uri, index, error: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  };
}

async function markSent(env: Env, post: BlueskyPost, value: Record<string, string>): Promise<void> {
  await env.STATE.put(`sent:${post.uri}`, JSON.stringify({ ...value, at: new Date().toISOString() }));
  await env.STATE.delete(`fail:${post.uri}`);
}

export async function runSync(env: Env, options: { dryRun?: boolean } = {}): Promise<RunReport> {
  const dryRun = options.dryRun ?? false;
  const token = env.PIKA_MICROPUB_TOKEN?.trim();
  if (!token && !dryRun) throw new Error('PIKA_MICROPUB_TOKEN is not set');

  const cursorBefore = (await env.STATE.get('cursor')) ?? env.START_AFTER;
  const after = Date.parse(cursorBefore);
  if (!Number.isFinite(after)) throw new Error(`Invalid starting point: ${cursorBefore}`);

  const limit = Math.max(1, Math.min(10, Number(env.MAX_POSTS_PER_RUN ?? 3) || 3));
  const tag = env.PIKA_TAG?.trim() || 'bluesky';
  const posts = (await postsSince(env.BLUESKY_DID, after)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const report: RunReport = { dryRun, startedAt: new Date().toISOString(), cursorBefore, cursorAfter: cursorBefore, found: posts.length, results: [] };
  let cursor = cursorBefore;
  let attempted = 0;

  for (const post of posts) {
    const entry: ResultEntry = { uri: post.uri, createdAt: post.createdAt, kind: post.kind, outcome: 'failed' };
    report.results.push(entry);

    if (await env.STATE.get(`sent:${post.uri}`)) {
      entry.outcome = 'already-sent';
      cursor = post.createdAt;
      continue;
    }
    if (linksToHost(post, hosts(env))) {
      entry.outcome = 'skipped-own-site-link';
      if (!dryRun) await markSent(env, post, { skipped: 'own-site-link' });
      cursor = post.createdAt;
      continue;
    }
    // A dry run lists everything waiting. A real run sends a few at a time.
    if (!dryRun && attempted >= limit) {
      report.results.pop();
      break;
    }
    attempted += 1;

    if (dryRun) {
      entry.outcome = 'would-publish';
      continue;
    }

    try {
      const content = await buildContent(post, env.BLUESKY_HANDLE, makeUploader(token!, post.uri));
      // Check again right before posting in case an overlapping run got here first.
      if (await env.STATE.get(`sent:${post.uri}`)) {
        entry.outcome = 'already-sent';
      } else {
        entry.url = await publishPost(token!, { content, tags: [tag], published: post.createdAt });
        entry.outcome = 'published';
        await markSent(env, post, { url: entry.url });
      }
      cursor = post.createdAt;
    } catch (error) {
      if (error instanceof RateLimited) {
        entry.outcome = 'rate-limited';
        break;
      }
      entry.error = error instanceof Error ? error.message : String(error);
      const failures = Number((await env.STATE.get(`fail:${post.uri}`)) ?? 0) + 1;
      if (failures >= MAX_FAILURES) {
        // Give up on this one so it does not block everything after it.
        entry.outcome = 'skipped-after-failures';
        await markSent(env, post, { skipped: 'failures', error: entry.error });
        cursor = post.createdAt;
        continue;
      }
      await env.STATE.put(`fail:${post.uri}`, String(failures));
      // Stop here and retry this post on the next run, so posts stay in order.
      break;
    }
  }

  report.cursorAfter = cursor;
  if (!dryRun) {
    if (cursor !== cursorBefore) await env.STATE.put('cursor', cursor);
    await env.STATE.put('lastRun', JSON.stringify(report));
  }
  return report;
}
