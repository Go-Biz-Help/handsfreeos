/**
 * Texts and emails a workflow sends a customer.
 *
 * Before every text: may this customer be texted (they opted in, or texted or called the business in the last
 * 24 hours; a STOP always wins; texting must be set up), and is it quiet hours where the business is. Each
 * decision is logged on the step. A text that can't go follows the workflow's settings (email instead, or
 * skip); in quiet hours it waits for the end of them plus a few minutes, emails instead, or skips.
 *
 * Messages go through message.send as the workflow, inside the step's transaction, with a clientId fixed by
 * the run and step so a retry never sends twice. message.send refuses a workflow in quiet hours no matter
 * what, so a refusal there also becomes a wait. Test runs never reach a customer: Simulate logs what would
 * happen, and "Send to me" emails the person testing (people have no mobile number on file yet).
 */
import { executeCommandIn, formatPhone, messageSend, workspaceMessaging } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { clientIdFor, quietEndAt, reachOf } from '../booking/deliver';
import { plainSms, STOP_WORDING } from '../booking/messages';
import { jitter, QUIET_JITTER_MS, RECENT_CONTACT_MS } from './constants';
import { testMessageEmail } from './emails';
import {
  isRefusal,
  refusedFrom,
  type Decision,
  type ExecCtx,
  type Json,
  type Outcome,
} from './types';

const iso = (ms: number) => new Date(ms).toISOString();
/** A text that can't go for these reasons follows the "no consent" setting. */
const CANT_TEXT = new Set([
  'opted_out',
  'no_phone',
  'no_consent',
  'texting_not_ready',
  'messaging_not_ready',
  'no_number',
]);
/** An email that can't go for these reasons is skipped (logged), not a failure. */
const CANT_EMAIL = new Set(['no_email', 'recipient_suppressed', 'person_archived']);

/** They texted or called this business themselves within the last 24 hours (a direct reply is expected). */
async function recentContact(ec: ExecCtx, phone: string): Promise<boolean> {
  const since = iso(ec.now - RECENT_CONTACT_MS);
  const ws = ec.scope.workspaceId;
  const [r] = await rows<{ yes: boolean }>(
    ec.tx,
    sql`select exists (
          select 1 from app.conversations c
          where c.workspace_id = ${ws} and c.channel = 'sms' and c.counterpart = ${phone}
            and c.last_inbound_at > ${since}::timestamptz)
        or exists (
          select 1 from app.calls k
          where k.workspace_id = ${ws} and k.direction = 'inbound' and k.from_e164 = ${phone}
            and k.started_at > ${since}::timestamptz) as yes`,
  );
  return !!r?.yes;
}

async function businessName(ec: ExecCtx): Promise<string> {
  await ec.data.need(['business.name']);
  return String(ec.data.value('business.name') ?? 'us');
}

function simulated(input: Json, output: Json): Outcome {
  return { kind: 'done', input, output: { simulated: true, ...output } };
}

/** "Send to me": the message goes by email to the person who started the test. */
async function toTester(
  ec: ExecCtx,
  channel: 'sms' | 'email',
  subject: string | null,
  body: string,
  input: Json,
): Promise<Outcome> {
  const [tester] = ec.run.startedBy
    ? await rows<{ email: string }>(
        ec.tx,
        sql`select email::text as email from app.users where id = ${ec.run.startedBy}`,
      )
    : [];
  if (!tester) return { kind: 'skipped', reason: 'no_tester', input };
  const mail = testMessageEmail({ workflow: ec.workflow.name, channel, subject, body });
  return {
    kind: 'slow',
    input,
    work: {
      kind: 'mail',
      messages: [{ to: tester.email, ...mail }],
      output: { sentToTester: tester.email, via: 'email', channel, subject, body },
    },
  };
}

/** The text becomes an email (their consent, quiet hours), or is skipped when they have no address. */
async function emailInstead(
  ec: ExecCtx,
  body: string,
  decisions: Decision[],
  why: string,
  input: Json,
): Promise<Outcome> {
  const p = await ec.data.person();
  if (!p?.email) {
    decisions.push({ check: 'email', result: 'blocked', reason: 'no_email' });
    return { kind: 'skipped', reason: why, input, output: { decisions } };
  }
  decisions.push({ check: 'email', result: 'ok' });
  const subject = `A message from ${await businessName(ec)}`;
  if (ec.testMode === 'simulate')
    return simulated(input, {
      would: 'email',
      instead: why,
      to: p.email,
      subject,
      body,
      decisions,
    });
  try {
    const r = await executeCommandIn(
      ec.tx,
      messageSend,
      {
        workspaceId: ec.scope.workspaceId,
        personId: p.id,
        channel: 'email',
        subject,
        body,
        clientId: clientIdFor('wf', ec.run.id, ec.stepKey, 'email'),
        keepConversationStatus: true,
      },
      ec.actor,
      ec.meta,
    );
    return {
      kind: 'done',
      input,
      eventIds: r.eventIds,
      output: {
        channel: 'email',
        instead: why,
        to: p.email,
        messageId: r.output.messageId,
        conversationId: r.output.conversationId,
        decisions,
      },
    };
  } catch (e) {
    if (!isRefusal(e)) throw e;
    if (e.rule && CANT_EMAIL.has(e.rule)) {
      decisions.push({ check: 'email', result: 'blocked', reason: e.rule });
      return { kind: 'skipped', reason: why, input, output: { decisions } };
    }
    return refusedFrom(e, input);
  }
}

/** Can't text them: the workflow's "no consent" setting decides (email them instead, or skip). */
function noText(
  ec: ExecCtx,
  why: string,
  decisions: Decision[],
  body: string,
  input: Json,
): Promise<Outcome> | Outcome {
  if (ec.def.settings.noConsent === 'skip') {
    decisions.push({ check: 'consent', result: 'skip', reason: why });
    if (ec.testMode === 'simulate')
      return simulated(input, { would: 'skip', reason: why, decisions });
    return { kind: 'skipped', reason: why, input, output: { decisions } };
  }
  decisions.push({ check: 'consent', result: 'email_instead', reason: why });
  return emailInstead(ec, body, decisions, why, input);
}

/** Quiet hours now (ending at `end`): wait for the end plus a few minutes, email instead, or skip. */
function quiet(
  ec: ExecCtx,
  end: number,
  decisions: Decision[],
  body: string,
  input: Json,
): Promise<Outcome> | Outcome {
  const setting = ec.def.settings.quietHours;
  if (setting === 'wait') {
    const until = end + jitter(QUIET_JITTER_MS);
    decisions.push({ check: 'quiet_hours', result: 'wait', until: iso(until) });
    if (ec.testMode === 'simulate')
      return simulated(input, { would: 'wait', until: iso(until), decisions });
    return {
      kind: 'wait',
      until,
      runStatus: 'waiting',
      input,
      output: { held: 'quiet_hours', until: iso(until), decisions },
    };
  }
  if (setting === 'skip') {
    decisions.push({ check: 'quiet_hours', result: 'skip' });
    if (ec.testMode === 'simulate')
      return simulated(input, { would: 'skip', reason: 'quiet_hours', decisions });
    return { kind: 'skipped', reason: 'quiet_hours', input, output: { decisions } };
  }
  decisions.push({ check: 'quiet_hours', result: 'email_instead' });
  return emailInstead(ec, body, decisions, 'quiet_hours', input);
}

/**
 * A send_text step, its body already rendered. Its reply buttons (0101) go with it: over RCS as buttons to tap,
 * and to a phone without RCS as the same text with the choices numbered.
 */
export async function sendTextAction(
  ec: ExecCtx,
  body: string,
  replyButtons: readonly string[] = [],
): Promise<Outcome> {
  const input: Json = { channel: 'sms', body, ...(replyButtons.length ? { replyButtons } : {}) };
  if (ec.testMode === 'send_to_me') return toTester(ec, 'sms', null, body, input);
  const p = await ec.data.person();
  if (!p) return { kind: 'skipped', reason: 'no_person', input };
  if (p.archived_at) return { kind: 'skipped', reason: 'person_archived', input };
  const ws = ec.scope.workspaceId;
  const decisions: Decision[] = [];
  const recent = p.phone_e164 ? await recentContact(ec, p.phone_e164) : false;
  const reach = await reachOf(
    ec.tx,
    ws,
    { phone: p.phone_e164, email: p.email, smsOk: recent, personConsent: p.sms_consent },
    { text: true, email: true },
  );
  if (reach.text !== null) {
    decisions.push({ check: 'consent', result: 'blocked', reason: reach.text });
    return noText(ec, reach.text, decisions, body, input);
  }
  decisions.push({
    check: 'consent',
    result: 'ok',
    reason: p.sms_consent === 'opted_in' ? 'opted_in' : 'recent_contact',
  });
  const m = await workspaceMessaging(ec.tx, ws);
  const end = quietEndAt(m.settings.quietHours, m.timezone, ec.now);
  if (end !== null) return quiet(ec, end, decisions, body, input);
  decisions.push({ check: 'quiet_hours', result: 'ok' });
  const text = plainSms(reach.firstText ? `${body} ${STOP_WORDING}` : body);
  const to = formatPhone(p.phone_e164);
  const rich = replyButtons.length
    ? {
        kind: 'buttons' as const,
        buttons: replyButtons.map((title) => ({ type: 'reply' as const, title })),
      }
    : undefined;
  if (ec.testMode === 'simulate')
    return simulated(input, {
      would: 'text',
      to,
      body: text,
      ...(replyButtons.length ? { replyButtons } : {}),
      decisions,
    });
  try {
    const r = await executeCommandIn(
      ec.tx,
      messageSend,
      {
        workspaceId: ws,
        personId: p.id,
        channel: 'sms',
        body: text,
        clientId: clientIdFor('wf', ec.run.id, ec.stepKey),
        keepConversationStatus: true,
        ...(rich ? { rich } : {}),
      },
      ec.actor,
      ec.meta,
    );
    return {
      kind: 'done',
      input,
      eventIds: r.eventIds,
      output: {
        channel: 'sms',
        to,
        messageId: r.output.messageId,
        conversationId: r.output.conversationId,
        duplicate: r.output.duplicate,
        decisions,
      },
      ...(ec.run.conversationId ? {} : { refs: { conversationId: r.output.conversationId } }),
    };
  } catch (e) {
    if (!isRefusal(e)) throw e;
    if (e.rule === 'quiet_hours') {
      // Its clock said quiet hours even though ours didn't: wait for them the same way.
      const until =
        quietEndAt(m.settings.quietHours, m.timezone, Date.now()) ?? Date.now() + 5 * 60_000;
      decisions.pop();
      return quiet(ec, until, decisions, body, input);
    }
    if (e.rule && CANT_TEXT.has(e.rule)) return noText(ec, e.rule, decisions, body, input);
    if (e.rule === 'person_archived') return { kind: 'skipped', reason: e.rule, input };
    return refusedFrom(e, input);
  }
}

/** A send_email step, its subject and body already rendered. */
export async function sendEmailAction(
  ec: ExecCtx,
  subject: string,
  body: string,
): Promise<Outcome> {
  const input: Json = { channel: 'email', subject, body };
  if (ec.testMode === 'send_to_me') return toTester(ec, 'email', subject, body, input);
  const p = await ec.data.person();
  if (!p) return { kind: 'skipped', reason: 'no_person', input };
  if (!p.email) return { kind: 'skipped', reason: 'no_email', input };
  if (ec.testMode === 'simulate')
    return simulated(input, { would: 'email', to: p.email, subject, body });
  try {
    const r = await executeCommandIn(
      ec.tx,
      messageSend,
      {
        workspaceId: ec.scope.workspaceId,
        personId: p.id,
        channel: 'email',
        subject: subject.slice(0, 200),
        body,
        clientId: clientIdFor('wf', ec.run.id, ec.stepKey),
        keepConversationStatus: true,
      },
      ec.actor,
      ec.meta,
    );
    return {
      kind: 'done',
      input,
      eventIds: r.eventIds,
      output: {
        channel: 'email',
        to: p.email,
        messageId: r.output.messageId,
        conversationId: r.output.conversationId,
        duplicate: r.output.duplicate,
      },
    };
  } catch (e) {
    if (!isRefusal(e)) throw e;
    if (e.rule && CANT_EMAIL.has(e.rule)) return { kind: 'skipped', reason: e.rule, input };
    return refusedFrom(e, input);
  }
}
