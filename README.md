# pika-sync

A small Cloudflare Worker that copies new Bluesky posts to Pika (bryan.pika.page) as published posts.

Every 5 minutes it:

1. Reads your newest Bluesky posts from Bluesky's public API (no login needed). Replies and reposts are left out.
2. Copies any photos, link-card thumbnails and video posters into Pika.
3. Publishes each post on Pika with its original date and the `bluesky` tag.
4. Adds the comment block (`bluesky-conversation`) at the end, so the site script loads Bluesky likes, reposts and replies under the post. Link cards and quote cards use the same markup as the August backfill.
5. Remembers what it sent, so nothing is posted twice.

It skips any Bluesky post that links to bryan.pika.page, so Pika never re-imports its own posts.

## Settings

In `wrangler.jsonc`:

| Setting | What it does |
| --- | --- |
| `START_AFTER` | On the very first run, only posts newer than this are sent. Set to the August 23 backfill. |
| `SKIP_LINK_HOSTS` | Posts linking to these sites are skipped. |
| `PIKA_TAG` | Tag added to every post. Your homepage Status section reads `bluesky`. |
| `MAX_POSTS_PER_RUN` | How many posts per 5-minute run. Kept low to stay under Pika's rate limit. |

Secrets, set with `npx wrangler secret put NAME`:

| Secret | What it is |
| --- | --- |
| `PIKA_MICROPUB_TOKEN` | A Pika app token (Pika > Settings > App tokens). |
| `ADMIN_TOKEN` | Any long random string. Protects the manual run address. |

The Worker keeps its memory in the KV namespace `pika-sync-state`.

## First deploy

```sh
npm install
npx wrangler secret put PIKA_MICROPUB_TOKEN
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Then, before the first scheduled run (or right after deploying), check what it plans to send:

```sh
curl -X POST "https://pika-sync.<your-subdomain>.workers.dev/run?dry=1" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Each entry shows `would-publish`, `skipped-own-site-link`, and so on. If something listed is already on Pika from the backfill, raise `START_AFTER` past it, or add its address to storage as sent.

Other checks:

- `GET /status` shows how far along it is and the last run's results.
- `POST /run?check=1` (with the admin token) confirms the Pika token works.
- `POST /run` (with the admin token) runs a real sync right away.

## Behaviour when things go wrong

- **Pika rate limit:** the run stops and picks up on the next one. Nothing is lost.
- **A post Pika rejects:** retried on the next two runs, then skipped so it does not block newer posts.
- **A photo that will not copy:** the post still goes up without it, and the problem is logged.

## Development

```sh
npm test       # unit tests
npm run check  # type check
npm run dev    # local Worker; visit /__scheduled to trigger a run
```

## Related

The comment block depends on `https://sync.lowvelocity.org/updates/bluesky/thread`, which still lives in the `lowvelocity-sync` Worker.
