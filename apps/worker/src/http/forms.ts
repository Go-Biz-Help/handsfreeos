/**
 * The public form page's routes. Signed-out people open a business's form at /f/<site>/<slug>, answer it,
 * and send it. Everything runs as the system actor, scoped by `private.form_route`, exactly as the booking
 * page is (http/booking.ts).
 *
 * What stops abuse: per-address rate limits, a honeypot field the page hides and a person never fills in,
 * the bot check (Cloudflare Turnstile, as on the booking page) before anything is sent, the key handed back when the sheet was started (knowing a response's id is not enough to write to it),
 * and the form's own closing rules, which the commands check again inside the transaction.
 */
import { createHash, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  allQuestions,
  executeCommand,
  findQuestion,
  formResponseSave,
  formResponseSaveContact,
  formResponseStart,
  formResponseSubmit,
  HfosError,
  knownTargetsOf,
  linkRefOf,
  loadCalendar,
  openTimes,
  parseStoredForm,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { passThroughBotCheck, type BotCheck } from '../booking/bot-check';
import { callBoxFor, offersBoxFor, type HttpDeps } from './common';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

interface FormRouteRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly timezone: string;
  readonly site_name: string | null;
  readonly form_id: string;
  readonly form_slug: string;
  readonly form_name: string;
  readonly mode: 'form' | 'survey' | 'quiz' | 'poll';
  readonly status: 'draft' | 'live' | 'closed' | 'archived';
  readonly version_id: string | null;
  readonly definition: unknown;
  readonly response_count: number;
  readonly redirected: boolean;
  readonly embed_origins: string[] | null;
}

const pageNotFound = () =>
  HfosError.notFound(
    'There’s no form at this address. Check the link, or contact the business if you still need it.',
  );

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
  /** A personal link's key (`?k=`), which says who the sheet is for. */
  key: z.string().min(20).max(200).optional(),
  /** The `ref` the page was opened with (`?ref=`): a time booked on it keeps it, as a booking page's does. */
  ref: z.string().max(200).nullable().optional(),
});

const SaveBody = z.object({
  token: z.string().min(10).max(200),
  answers: Answers,
  askAgain: z.boolean().default(false),
  /** The page they're on, shown one page at a time (stopped partway). */
  pageId: z
    .string()
    .regex(/^p_[a-z0-9]{8}$/)
    .optional(),
});

const SubmitBody = z.object({
  token: z.string().min(10).max(200),
  answers: Answers,
  smsConsent: z.boolean().default(false),
  offersConsent: z.boolean().default(false),
  callConsent: z.boolean().default(false),
  askAgain: z.boolean().default(false),
  website: z.string().max(200).optional(),
  turnstileToken: z.string().max(2048).optional(),
});

const KEY_RE = /^[A-Za-z0-9_-]{20,200}$/;
const keyHash = (key: string): Buffer => createHash('sha256').update(key).digest();

export interface FormsHttpOptions {
  /** Playwright turns the limits down; production leaves them alone. */
  readonly limitFactor?: number;
  /** Cloudflare Turnstile, shared with the booking page: sending a form opens a lead, and a lead can be texted. */
  readonly botCheck?: BotCheck;
}

export async function registerFormRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const factor = deps.forms?.limitFactor ?? 1;
  const botCheck = deps.forms?.botCheck ?? passThroughBotCheck;
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

  /**
   * The live personal link a key is for, on this form: whose it is. Holding one is what lets a page we texted
   * skip the "are you a person" check, the way a customer's own booking link does.
   */
  async function personalLink(
    row: FormRouteRow,
    key: string,
  ): Promise<{ personId: string; firstName: string; known: string[] } | null> {
    if (!KEY_RE.test(key)) return null;
    const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
    const [found] = await worker(scope, (tx) =>
      rows<{
        person_id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone_e164: string | null;
      }>(
        tx,
        sql`select l.person_id, p.first_name, p.last_name, p.email::text as email, p.phone_e164
            from app.form_links l join app.people p on p.id = l.person_id
            where l.key_hash = ${keyHash(key)} and l.form_id = ${row.form_id}
              and l.expires_at > now()`,
      ),
    );
    if (!found) return null;
    return {
      personId: found.person_id,
      firstName: found.first_name ?? '',
      known: [
        ...knownTargetsOf({
          firstName: found.first_name,
          lastName: found.last_name,
          email: found.email,
          phone: found.phone_e164,
        }),
      ],
    };
  }

  /** Cloudflare's check, unless the page holds a personal link's key: we texted that link to them ourselves. */
  async function checkPerson(
    row: FormRouteRow,
    token: string,
    turnstileToken: string | undefined,
    ip: string,
  ) {
    if (await personalLink(row, token)) return;
    const verdict = await botCheck.verify(turnstileToken, ip);
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
  }

  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    /** The form itself, and enough about the business to put a name at the top. */
    pub.get<{ Params: { site: string; slug: string } }>(
      '/public/form/:site/:slug',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const row = await findForm(req.params.site, req.params.slug);
        // A live poll has no page: its questions pop up in a video call.
        if (row.mode === 'poll') throw pageNotFound();
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
        const name = row.site_name ?? row.form_name;
        const offers = await worker(scope, (tx) => offersBoxFor(tx, row.workspace_id, name));
        const calls = await worker(scope, (tx) => callBoxFor(tx, row.workspace_id, name));
        return {
          business: { name, timeZone: row.timezone },
          // The separate box for offers, under the first, for a business that sends them.
          offersConsent: offers,
          // The "OK to call" box under those, for a business that asks for one.
          callConsent: calls,
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
          botCheck: botCheck.enabled ? { siteKey: botCheck.siteKey } : null,
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
            ...(body.key ? { personalKey: body.key } : {}),
            ...(linkRefOf(body.ref) ? { linkRef: linkRefOf(body.ref)! } : {}),
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
            askAgain: body.askAgain,
            ...(body.pageId ? { pageId: body.pageId } : {}),
          },
          { type: 'system', ...scope },
          meta(),
        );
        return output;
      },
    );

    /**
     * Leaving the page that saves their details, part way through (funnels). It makes a customer and a lead, so
     * it takes the same check sending does.
     */
    pub.post<{ Params: { site: string; slug: string; responseId: string }; Body: unknown }>(
      '/public/form/:site/:slug/:responseId/contact',
      { config: { rateLimit: limits.write } },
      async (req) => {
        const body = SubmitBody.parse(req.body ?? {});
        if (body.website?.trim() || body.token === DECOY_TOKEN)
          return { responseId: req.params.responseId, saved: true };
        const row = await findForm(req.params.site, req.params.slug);
        await checkPerson(row, body.token, body.turnstileToken, req.ip);
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        await executeCommand(
          deps.httpDb,
          formResponseSaveContact,
          {
            workspaceId: row.workspace_id,
            responseId: req.params.responseId,
            token: body.token,
            answers: body.answers,
            smsConsent: body.smsConsent,
            offersConsent: body.offersConsent,
            callConsent: body.callConsent,
            askAgain: body.askAgain,
          },
          { type: 'system', ...scope },
          meta(),
        );
        // Who they are stays with the business: the page only needs to know it worked.
        return { responseId: req.params.responseId, saved: true };
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
        await checkPerson(row, body.token, body.turnstileToken, req.ip);
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
            offersConsent: body.offersConsent,
            callConsent: body.callConsent,
            askAgain: body.askAgain,
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

    /**
     * Opening a personal link (`?k=`): their first name for the greeting, which contact details we already have
     * (so the page skips those questions), and their unfinished sheet from a link, if there is one. Nothing else
     * on file comes back: no email, no phone, not even what they typed into those questions before.
     */
    pub.get<{ Params: { site: string; slug: string; key: string } }>(
      '/public/form/:site/:slug/personal/:key',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const row = await findForm(req.params.site, req.params.slug);
        const link = await personalLink(row, req.params.key);
        if (!link)
          throw HfosError.rule(
            'form_link_gone',
            404,
            'This link has run out. Open the form from the business’s website, or ask them to send it again.',
          );
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        const [sheet] = await worker(scope, (tx) =>
          rows<{ id: string; answers: Record<string, unknown> }>(
            tx,
            sql`select id, answers from app.form_responses
                where form_id = ${row.form_id} and person_id = ${link.personId}
                  and status = 'in_progress' and form_link_id is not null
                order by started_at desc limit 1`,
          ),
        );
        const definition = parseStoredForm(row.definition);
        const reaching = new Set(
          allQuestions(definition)
            .filter(
              (q) =>
                q.type === 'email' ||
                q.type === 'phone' ||
                q.mapTo === 'person.email' ||
                q.mapTo === 'person.phone',
            )
            .map((q) => q.id),
        );
        const answers = Object.fromEntries(
          Object.entries(sheet?.answers ?? {}).filter(([id]) => !reaching.has(id)),
        );
        return {
          firstName: link.firstName,
          known: link.known,
          sheet: sheet ? { responseId: sheet.id, answers } : null,
        };
      },
    );

    /**
     * The open times for a form's "Book a time" question (funnels), from its calendar, as far ahead as the question
     * says. A calendar that isn't taking bookings, or takes a payment, has none: the page says so.
     */
    pub.get<{ Params: { site: string; slug: string; questionId: string } }>(
      '/public/form/:site/:slug/times/:questionId',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const row = await findForm(req.params.site, req.params.slug);
        const definition = parseStoredForm(row.definition);
        const question = findQuestion(definition, req.params.questionId)?.question;
        if (!question || question.type !== 'booking')
          throw HfosError.notFound('That question isn’t on this form. Refresh the page.');
        const { calendarId, serviceId, days } = question.config;
        const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
        return worker(scope, async (tx) => {
          const calendar = calendarId
            ? await loadCalendar(tx, row.workspace_id, calendarId).catch(() => null)
            : null;
          if (!calendar || calendar.status !== 'active' || calendar.config.payments.mode !== 'none')
            return { open: false, timezone: row.timezone, slots: [] };
          const from = Date.now();
          const out = await openTimes(tx, calendar, {
            from,
            to: from + days * 86_400_000,
            serviceId,
            partySize: 1,
          });
          const seats = calendar.config.capacity.showSeatsLeft;
          return {
            open: true,
            timezone: calendar.timeZone,
            slots: out.slots.slice(0, 60).map((x) => ({
              startsAt: x.startsAt,
              sessionId: x.sessionId,
              seatsLeft:
                seats && (calendar.config.capacity.seats > 1 || x.sessionId) ? x.seatsLeft : null,
            })),
          };
        });
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
        if (!found[0])
          throw HfosError.notFound(
            'That link to finish the form has run out, or the form was already sent with it. Start the form again from the top.',
          );
        return { responseId: found[0].id, answers: found[0].answers ?? {} };
      },
    );
  });
}
