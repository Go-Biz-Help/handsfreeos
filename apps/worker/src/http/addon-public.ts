/**
 * Add-ons' public pages (Real Estate round three, core): what anyone with the link sees, signed in to nothing. The
 * web's `/a/<site>/<addon>/…` pages call this from their server; a page's form posts here from the visitor's browser.
 *
 * - `POST /public/addon/:site/query/:name` and `…/command/:name`: the two doors, for a look-up and for a change. Any
 *   operation that lists 'public' (`<addon>.public.*`), run by the kernel as a visitor in the business whose booking
 *   site is `:site`. The body's `input` is its input; the business comes from the site, never from the body. Nothing
 *   here is in the API or its OpenAPI.
 *
 * As the form pages do (http/forms.ts): every look-up and every change has its own per-address limit, a change is
 * refused when the field people can't see is filled in or the bot check fails, and every answer is `no-store`. A
 * file an operation names (`publicFileId`) comes back with a link that works for an hour, once it's checked to be the
 * business's own.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  executeCommand,
  executeQuery,
  HfosError,
  registry,
  type PublicActor,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { passThroughBotCheck } from '../booking/bot-check';
import { ipHmacOf } from '../chat/store';
import { parseBody, type HttpDeps } from './common';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;
/** How long a photo's link works. */
export const PUBLIC_FILE_SECONDS = 3600;

interface SiteRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly timezone: string;
  readonly site_slug: string;
  readonly site_name: string;
}

const Body = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  /** Hidden on the page. Anything in it is a robot. */
  website: z.string().max(200).optional(),
  turnstileToken: z.string().max(2048).optional(),
});

const noPage = () =>
  HfosError.notFound(
    'There’s no page at this address. Check the link, or contact the business if you still need it.',
  );

/** Every `{ publicFileId }` in an answer, wherever it sits. */
function filesIn(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) filesIn(v, found);
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['publicFileId'] === 'string') found.push(obj);
    for (const v of Object.values(obj)) filesIn(v, found);
  }
  return found;
}

export async function registerAddonPublicRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  // The same limits and bot check as the form pages: an add-on's public page is one of the business's pages too.
  const factor = deps.forms?.limitFactor ?? 1;
  const botCheck = deps.forms?.botCheck ?? passThroughBotCheck;
  const ipKey = deps.chat?.ipKey ?? randomBytes(32).toString('base64');
  const limits = {
    read: { max: Math.ceil(120 * factor), timeWindow: '1 minute' },
    write: { max: Math.ceil(10 * factor), timeWindow: '1 minute' },
  };
  const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'booking_page' });

  async function siteOf(site: string): Promise<SiteRow> {
    if (!SLUG_RE.test(site)) throw noPage();
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<SiteRow>(
        tx,
        sql`select workspace_id, organization_id, timezone, site_slug, site_name
            from private.booking_route(${site}::text, null)`,
      ),
    );
    if (!row) throw noPage();
    return row;
  }

  /** Each file the answer names, with an hour's link, or the answer is refused: never a file that isn't theirs. */
  async function signFiles(row: SiteRow, answer: unknown): Promise<void> {
    const named = filesIn(answer);
    if (named.length === 0) return;
    const ids = [...new Set(named.map((f) => String(f['publicFileId'])))];
    const found = await asWorker(
      deps.httpDb,
      { workspaceId: row.workspace_id, organizationId: row.organization_id },
      (tx) =>
        rows<{ id: string; bucket: string; object_path: string }>(
          tx,
          sql`select id, bucket, object_path from app.files
              where workspace_id = ${row.workspace_id}::uuid and status = 'ready' and deleted_at is null
                and id = any(array[${sql.join(
                  ids.map((id) => sql`${id}`),
                  sql`, `,
                )}]::uuid[])`,
        ),
    );
    const byId = new Map(found.map((f) => [f.id, f]));
    for (const f of named) {
      const file = byId.get(String(f['publicFileId']));
      f['url'] = file
        ? await deps.store.signedUrl(file.bucket, file.object_path, PUBLIC_FILE_SECONDS)
        : null;
    }
  }

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });
    pub.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      return payload;
    });

    /** The visitor, and the business whose page it is, for the operation `name` of the given kind. */
    async function visit(site: string, name: string, kind: 'command' | 'query', ip: string) {
      const op = kind === 'command' ? registry.command(name) : registry.query(name);
      if (!op?.addon || !op.actors?.includes('public')) throw noPage();
      const row = await siteOf(site);
      const actor: PublicActor = {
        type: 'public',
        workspaceId: row.workspace_id,
        organizationId: row.organization_id,
        site: row.site_slug,
        visitor: ipHmacOf(ipKey, ip),
      };
      return { row, actor, business: { name: row.site_name, timeZone: row.timezone } };
    }

    pub.post<{ Params: { site: string; name: string } }>(
      '/public/addon/:site/query/:name',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const body = parseBody(Body, req.body ?? {});
        const { row, actor, business } = await visit(
          req.params.site,
          req.params.name,
          'query',
          req.ip,
        );
        const result = await executeQuery(
          deps.httpDb,
          registry.query(req.params.name)!,
          { ...body.input, workspaceId: row.workspace_id },
          actor,
          meta(),
        );
        await signFiles(row, result);
        return {
          result,
          business,
          botCheck: botCheck.enabled ? { siteKey: botCheck.siteKey } : null,
        };
      },
    );

    pub.post<{ Params: { site: string; name: string } }>(
      '/public/addon/:site/command/:name',
      { config: { rateLimit: limits.write } },
      async (req) => {
        const body = parseBody(Body, req.body ?? {});
        const { row, actor, business } = await visit(
          req.params.site,
          req.params.name,
          'command',
          req.ip,
        );
        if (body.website?.trim())
          throw HfosError.validation([], 'That didn’t go through. Refresh the page and try again.');
        const verdict = await botCheck.verify(body.turnstileToken, req.ip);
        if (verdict === 'unavailable')
          throw HfosError.rule(
            'bot_check_unavailable',
            503,
            'We couldn’t check this just now. Try again in a minute.',
          );
        if (verdict !== 'pass')
          throw HfosError.rule(
            'bot_check_failed',
            400,
            'We couldn’t confirm you’re a person. Finish the check on this page, then try again.',
          );
        const { output } = await executeCommand(
          deps.httpDb,
          registry.command(req.params.name)!,
          { ...body.input, workspaceId: row.workspace_id },
          actor,
          meta(),
        );
        await signFiles(row, output);
        return { result: output, business };
      },
    );
  });
}
