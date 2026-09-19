/**
 * The public form page's routes. Signed-out people open a business's form at /f/<site>/<slug>, answer it,
 * and send it. Everything runs as the system actor, scoped by `private.form_route`, exactly as the booking
 * page is (http/booking.ts).
 *
 * What stops abuse: per-address rate limits, a honeypot field the page hides and a person never fills in,
 * the key handed back when the sheet was started (knowing a response's id is not enough to write to it),
 * and the form's own closing rules, which the commands check again inside the transaction.
 */
import { createHash, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  executeCommand,
  formResponseSave,
  formResponseStart,
  formResponseSubmit,
  HfosError,
  parseStoredForm,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpDeps } from './common';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

interface FormRouteRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly timezone: string;
  readonly site_name: string | null;
  readonly form_id: string;
  readonly form_slug: string;
  readonly form_name: string;
  readonly mode: 'form' | 'survey' | 'quiz';
  readonly status: 'draft' | 'live' | 'closed' | 'archived';
  readonly version_id: string | null;
  readonly definition: unknown;
  readonly response_count: number;
  readonly redirected: boolean;
  readonly embed_origins: string[] | null;
}

const pageNotFound = () => HfosError.notFound('There’s no form at that address.');

/**
 * What a robot is handed instead of a real answer sheet. It looks like a key, is accepted everywhere a key
 * is, and writes nothing anywhere — so a robot gets a page that behaves exactly as it does for a person.
 */
const DECOY_TOKEN = 'nothing-was-written-for-this-one';

/** The answers a page posts. What each one may be is the question's own business, checked in core. */
const Answers = z.record(z.string(), z.unknown());

const StartBody = z.object({
  /** Hidden on the page. Anything in it is a robot, and the answer is a polite nothing. */
  website: z.string().max(200).optional(),
  source: z.enum(['link', 'embed', 'qr']).default('link'),
});

const SaveBody = z.object({
  token: z.string().min(10).max(200),
  answers: Answers,
});

const SubmitBody = z.object({
  token: z.string().min(10).max(200),
  answers: Answers,
  smsConsent: z.boolean().default(false),
  website: z.string().max(200).optional(),
});

export interface FormsHttpOptions {
  /** Playwright turns the limits down; production leaves them alone. */
  readonly limitFactor?: number;
}

export async function registerFormRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const factor = deps.forms?.limitFactor ?? 1;
  const limits = {
    read: { max: Math.ceil(120 * factor), timeWindow: '1 minute' },
    write: { max: Math.ceil(20 * factor), timeWindow: '1 minute' },
  };
  const worker = <T>(
    scope: { workspaceId: string; organizationId: string },
    fn: Parameters<typeof asWorker<T>>[2],
  ) => asWorker(deps.httpDb, scope, fn);

  const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'booking_page' });

  async function findForm(site: string, slug: string): Promise<FormRouteRow> {
    if (!SLUG_RE.test(site) || !SLUG_RE.test(slug)) throw pageNotFound();
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<FormRouteRow>(tx, sql`select * from private.form_route(${site}::text, ${slug}::text)`),
    );
    // A draft, an archived form or one that was never published is exactly like a form that isn't there.
    if (!row || !row.version_id || row.status === 'draft' || row.status === 'archived')
      throw pageNotFound();
    return row;
  }

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    /** The form itself, and enough about the business to put a name at the top. */
    pub.get<{ Params: { site: string; slug: string } }>(
      '/public/form/:site/:slug',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const row = await findForm(req.params.site, req.params.slug);
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        const definition = parseStoredForm(row.definition);
        // Somebody looked: the day's tally, with nothing in it that says who.
        await worker(scope, (tx) =>
          tx.execute(
            sql`insert into app.form_days (workspace_id, form_id, day, views)
                values (${row.workspace_id}, ${row.form_id}, current_date, 1)
                on conflict (form_id, day) do update set views = app.form_days.views + 1`,
          ),
        );
        const closed =
          row.status !== 'live' ||
          (definition.settings.closesAt !== null &&
            new Date(definition.settings.closesAt).getTime() <= Date.now()) ||
          (definition.settings.closesAfter !== null &&
            row.response_count >= definition.settings.closesAfter);
        return {
          business: { name: row.site_name ?? row.form_name, timeZone: row.timezone },
          form: {
            formId: row.form_id,
            slug: row.form_slug,
            name: row.form_name,
            mode: row.mode,
            versionId: row.version_id,
          },
          definition,
          closed,
          closedMessage: definition.settings.closedMessage,
          redirected: row.redirected ? row.form_slug : null,
          // The sites the business allowed to embed it, for the page's frame rule.
          embedOrigins: row.embed_origins ?? [],
        };
      },
    );

    /** Somebody started filling it in. Hands back the key that lets that page write to its own sheet. */
    pub.post<{ Params: { site: string; slug: string }; Body: unknown }>(
      '/public/form/:site/:slug/start',
      { config: { rateLimit: limits.write } },
      async (req) => {
        const body = StartBody.parse(req.body ?? {});
        const row = await findForm(req.params.site, req.params.slug);
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        // The honeypot: a robot filled in the field people can't see. It gets a sheet that goes nowhere.
        if (body.website?.trim())
          return { responseId: randomUUID(), token: DECOY_TOKEN, canResume: false };
        const { output } = await executeCommand(
          deps.httpDb,
          formResponseStart,
          {
            workspaceId: row.workspace_id,
            formId: row.form_id,
            source: body.source,
            visitorHash: null,
          },
          { type: 'system', ...scope },
          meta(),
        );
        return output;
      },
    );

    /** The answers so far, so a long form survives a closed tab. */
    pub.post<{ Params: { site: string; slug: string; responseId: string }; Body: unknown }>(
      '/public/form/:site/:slug/:responseId/save',
      { config: { rateLimit: limits.write } },
      async (req) => {
        const body = SaveBody.parse(req.body ?? {});
        if (body.token === DECOY_TOKEN) return { responseId: req.params.responseId, saved: true };
        const row = await findForm(req.params.site, req.params.slug);
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        const { output } = await executeCommand(
          deps.httpDb,
          formResponseSave,
          {
            workspaceId: row.workspace_id,
            responseId: req.params.responseId,
            token: body.token,
            answers: body.answers,
          },
          { type: 'system', ...scope },
          meta(),
        );
        return output;
      },
    );

    /** Sent. This is where the customer, the lead and the workflows happen. */
    pub.post<{ Params: { site: string; slug: string; responseId: string }; Body: unknown }>(
      '/public/form/:site/:slug/:responseId/submit',
      { config: { rateLimit: limits.write } },
      async (req) => {
        const body = SubmitBody.parse(req.body ?? {});
        const row = await findForm(req.params.site, req.params.slug);
        const definition = parseStoredForm(row.definition);
        // A robot, again: it is told the same thing a person is told, and nothing is written.
        if (body.website?.trim() || body.token === DECOY_TOKEN)
          return {
            responseId: req.params.responseId,
            resultId: definition.results[definition.results.length - 1]?.id ?? null,
            headline: definition.results[definition.results.length - 1]?.headline ?? 'Thank you.',
            body: '',
            dueCents: 0,
          };
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        const { output } = await executeCommand(
          deps.httpDb,
          formResponseSubmit,
          {
            workspaceId: row.workspace_id,
            responseId: req.params.responseId,
            token: body.token,
            answers: body.answers,
            smsConsent: body.smsConsent,
          },
          { type: 'system', ...scope },
          meta(),
        );
        const landed = definition.results.find((r) => r.id === output.resultId) ?? null;
        return {
          responseId: output.responseId,
          resultId: output.resultId,
          headline: landed?.headline ?? 'Thank you.',
          body: landed?.body ?? '',
          buttonLabel: landed?.buttonLabel ?? '',
          buttonUrl: landed?.buttonUrl ?? null,
          redirectUrl: landed?.redirectUrl ?? null,
          score: output.score,
          scorePercent: output.scorePercent,
          passed: output.passed,
          showScore: definition.scoring.enabled && definition.scoring.showScore,
          calculations: output.calculations,
          dueCents: output.dueCents,
        };
      },
    );

    /** Carrying on from a "finish it later" link. */
    pub.get<{ Params: { site: string; slug: string; token: string } }>(
      '/public/form/:site/:slug/resume/:token',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const row = await findForm(req.params.site, req.params.slug);
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        // The hash is made here rather than in SQL: the same sha256 the command wrote, and no dependency
        // on which schema pgcrypto happens to live in.
        const hash = createHash('sha256').update(req.params.token).digest();
        const found = await worker(scope, (tx) =>
          rows<{ id: string; answers: Record<string, unknown> }>(
            tx,
            sql`select id, answers from app.form_responses
                where form_id = ${row.form_id} and status = 'in_progress'
                  and resume_token_hash = ${hash}
                  and (resume_expires_at is null or resume_expires_at > now())`,
          ),
        );
        if (!found[0]) throw HfosError.notFound('That link has run out.');
        return { responseId: found[0].id, answers: found[0].answers ?? {} };
      },
    );
  });
}
