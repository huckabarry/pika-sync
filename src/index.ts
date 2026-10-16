import { checkToken } from './pika.ts';
import { runSync, type Env } from './sync.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function authorized(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN?.trim();
  const given = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return Boolean(expected && given && given === expected);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const report = await runSync(env);
      const counts: Record<string, number> = {};
      for (const result of report.results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
      console.log(JSON.stringify({ message: 'pika sync run', cursor: report.cursorAfter, found: report.found, ...counts }));
    } catch (error) {
      console.error(JSON.stringify({ message: 'pika sync failed', error: error instanceof Error ? error.message : String(error) }));
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public: when the last run happened and how far along it is. No secrets.
    if (url.pathname === '/' || url.pathname === '/status') {
      const lastRun = await env.STATE.get('lastRun');
      const parsed = lastRun ? (JSON.parse(lastRun) as { startedAt?: string; results?: Array<{ outcome: string }> }) : null;
      return json({
        service: 'pika-sync',
        cursor: (await env.STATE.get('cursor')) ?? env.START_AFTER,
        tokenSet: Boolean(env.PIKA_MICROPUB_TOKEN),
        lastRunAt: parsed?.startedAt ?? null,
        lastRunOutcomes: parsed?.results?.map((result) => result.outcome) ?? []
      });
    }

    // Protected: run now. Add ?dry=1 to see what would be published without posting.
    if (url.pathname === '/run' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
      try {
        const dryRun = url.searchParams.get('dry') === '1';
        if (url.searchParams.get('check') === '1') {
          return json({ tokenWorks: env.PIKA_MICROPUB_TOKEN ? await checkToken(env.PIKA_MICROPUB_TOKEN) : false });
        }
        return json(await runSync(env, { dryRun }));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  }
} satisfies ExportedHandler<Env>;
