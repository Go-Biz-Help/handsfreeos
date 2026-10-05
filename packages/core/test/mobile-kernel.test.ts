/**
 * M10 step 4, the command layer a phone that works offline needs, without the database:
 * - **Dispositions:** every refusal says final, retry or ask, from its status and rule.
 * - **The app's request details:** read from the headers, the phone's clock corrected (never later than now),
 *   malformed values refused, and app builds compared.
 * - **The moment rules:** a customer-facing command done too long ago waits for "Still send?"; an online-only one
 *   that waited is refused for good; a phone command always says which one it is and when.
 * - **Offline classes:** every command the phone uses has the class the plan gives it, nothing that moves money can
 *   wait on a phone, and everything else is online.
 * - **Stored answers keep no secret.**
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUILT_ADDONS } from '../src/addons/catalog';
import { dispositionOf, HfosError } from '../src/errors';
import {
  appVersionAtLeast,
  APP_HEADERS,
  CONFIRMED_MINUTES,
  FRESH_MINUTES,
  onServerClock,
} from '../src/mobile';
import {
  assertAppRequest,
  assertOnTime,
  readAppRequest,
  waitInWords,
} from '../src/kernel/app-request';
import { defineCommand } from '../src/kernel/define';
import { canonicalJson, inputHashOf, keepableAnswer } from '../src/kernel/receipts';
import type { CommandDef, OfflineClass, RequestMeta } from '../src/kernel/types';
import { registry } from '../src/server';

const MIN = 60_000;
const NOW = new Date('2026-09-21T15:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('dispositions', () => {
  it('says retry for server trouble, too many at once, a session to refresh and an app to update', () => {
    for (const status of [500, 502, 503, 429, 426, 401])
      expect(dispositionOf(status)).toBe('retry');
  });

  it('says final for validation, permission, not found, gone and every other rule', () => {
    for (const [status, rule] of [
      [400, undefined],
      [403, 'not_an_approver'],
      [404, undefined],
      [409, 'lead_archived'],
      [409, 'document_conflict'],
      [409, 'online_only'],
      [409, 'command_id_reused'],
      [410, 'offer_expired'],
      [422, 'workflow_issues'],
    ] as const)
      expect(dispositionOf(status, rule), rule ?? String(status)).toBe('final');
  });

  it('says ask for what a person can answer, and every body carries it', () => {
    for (const rule of [
      'stale_action',
      'quiet_hours',
      'needs_confirmation',
      'duplicate',
      'has_open_work',
      'payment_connection_has_plans',
    ])
      expect(dispositionOf(409, rule), rule).toBe('ask');
    expect(HfosError.validation([]).toBody().error.disposition).toBe('final');
    expect(HfosError.unauthenticated().toBody().error.disposition).toBe('retry');
    expect(HfosError.internal().toBody().error.disposition).toBe('retry');
    expect(HfosError.upgradeRequired('1.4.0').toBody()).toEqual({
      error: {
        code: 'upgrade_required',
        message: 'Update the HandsFreeOS app to keep going. Nothing you did is lost.',
        details: { minVersion: '1.4.0' },
        disposition: 'retry',
      },
    });
    expect(
      new HfosError('rule_violation', 409, 'Quiet.', undefined, 'quiet_hours').toBody().error,
    ).toMatchObject({ rule: 'quiet_hours', disposition: 'ask' });
  });
});

describe('the app’s request details', () => {
  const headers = (over: Record<string, string> = {}) => ({
    [APP_HEADERS.client]: 'mobile',
    [APP_HEADERS.commandId]: '0192A4B7-8C2E-4D31-9F60-4A1E2C9D7B10',
    [APP_HEADERS.occurredAt]: '2026-09-21T15:30:00.000Z',
    [APP_HEADERS.sentAt]: '2026-09-21T15:59:00.000Z',
    [APP_HEADERS.appVersion]: '1.4.2',
    ...over,
  });

  it('moves the phone’s times onto the server’s clock, never later than now', () => {
    // The phone's clock is an hour fast: it sent at 15:59 by its clock, which was 14:59 here.
    const read = readAppRequest(
      headers({ [APP_HEADERS.confirmedAt]: '2026-09-21T15:58:00Z' }),
      NOW,
    );
    expect(read).toEqual({
      channel: 'mobile',
      commandId: '0192a4b7-8c2e-4d31-9f60-4a1e2c9d7b10',
      occurredAt: new Date('2026-09-21T14:31:00.000Z'),
      sentAt: new Date('2026-09-21T15:59:00.000Z'),
      confirmedAt: new Date('2026-09-21T14:59:00.000Z'),
      appVersion: '1.4.2',
    });
    // A phone behind the server says a moment in the future: it stops at now.
    expect(
      onServerClock(new Date('2026-09-21T15:10:00Z'), new Date('2026-09-21T14:50:00Z'), NOW),
    ).toEqual(NOW);
    // Without the sending moment, the time is taken as it is (still never later than now).
    expect(onServerClock(ago(5 * MIN), null, NOW)).toEqual(ago(5 * MIN));
  });

  it('is nothing for another client, and refuses values the app never sends', () => {
    expect(readAppRequest({ 'user-agent': 'Chrome' }, NOW)).toBeNull();
    expect(readAppRequest(headers({ [APP_HEADERS.client]: 'web' }), NOW)).toBeNull();
    try {
      readAppRequest(
        headers({ [APP_HEADERS.commandId]: 'not-a-uuid', [APP_HEADERS.occurredAt]: 'yesterday' }),
        NOW,
      );
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(HfosError);
      expect((e as HfosError).code).toBe('validation');
      expect(((e as HfosError).details as { path: string }[]).map((d) => d.path)).toEqual([
        APP_HEADERS.commandId,
        APP_HEADERS.occurredAt,
      ]);
    }
  });

  it('compares app builds, treating one it can’t read as too old', () => {
    expect(appVersionAtLeast('1.4.2', '1.4.0')).toBe(true);
    expect(appVersionAtLeast('1.4.0', '1.4.0')).toBe(true);
    expect(appVersionAtLeast('1.10.0', '1.9.3')).toBe(true);
    expect(appVersionAtLeast('2.0.0-beta.1', '1.9')).toBe(true);
    expect(appVersionAtLeast('1.3.9', '1.4.0')).toBe(false);
    expect(appVersionAtLeast(null, '1.4.0')).toBe(false);
    expect(appVersionAtLeast('latest', '1.4.0')).toBe(false);
  });

  it('says how long something waited in words', () => {
    expect(waitInWords(45_000)).toBe('1 minute');
    expect(waitInWords(45 * MIN)).toBe('45 minutes');
    expect(waitInWords(3 * 60 * MIN)).toBe('3 hours');
    expect(waitInWords(50 * 60 * MIN)).toBe('2 days');
  });
});

describe('the moment rules', () => {
  const command = (offline: OfflineClass): CommandDef =>
    defineCommand({
      name: 'test.moment',
      description: 'A stand-in.',
      risk: 1,
      input: z.object({}),
      output: z.object({}),
      permission: null,
      scope: () => ({ kind: 'none' }),
      emits: [],
      offline,
      handler: async () => ({}),
    });
  const phone = (over: Partial<RequestMeta> = {}): RequestMeta => ({
    correlationId: '00000000-0000-4000-8000-000000000001',
    channel: 'mobile',
    commandId: '00000000-0000-4000-8000-000000000002',
    occurredAt: NOW,
    ...over,
  });
  const refusal = (fn: () => void): HfosError | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return e as HfosError;
    }
  };

  it('lets a customer-facing change go while fresh, and asks once it isn’t', () => {
    const fresh = command({ freshMinutes: FRESH_MINUTES });
    expect(
      refusal(() => assertOnTime(fresh, phone({ occurredAt: ago(29 * MIN) }), NOW)),
    ).toBeNull();
    const stale = refusal(() => assertOnTime(fresh, phone({ occurredAt: ago(45 * MIN) }), NOW))!;
    expect(stale).toMatchObject({ code: 'rule_violation', status: 409, rule: 'stale_action' });
    expect(stale.disposition).toBe('ask');
    expect(stale.message).toBe(
      'This was done 45 minutes ago, so it waits for your OK before it goes.',
    );
    expect(stale.details).toEqual({
      occurredAt: ago(45 * MIN).toISOString(),
      freshMinutes: FRESH_MINUTES,
    });
    // "Still send?" said yes just now: it goes. A yes from long ago is asked again.
    const yes = phone({ occurredAt: ago(45 * MIN), confirmedAt: ago(1 * MIN) });
    expect(refusal(() => assertOnTime(fresh, yes, NOW))).toBeNull();
    const oldYes = phone({
      occurredAt: ago(45 * MIN),
      confirmedAt: ago((CONFIRMED_MINUTES + 1) * MIN),
    });
    expect(refusal(() => assertOnTime(fresh, oldYes, NOW))?.rule).toBe('stale_action');
  });

  it('refuses an online-only change that waited more than two minutes, for good', () => {
    const online = command('online');
    expect(refusal(() => assertOnTime(online, phone({ occurredAt: ago(90_000) }), NOW))).toBeNull();
    const late = refusal(() => assertOnTime(online, phone({ occurredAt: ago(12 * MIN) }), NOW))!;
    expect(late).toMatchObject({ rule: 'online_only', status: 409 });
    expect(late.disposition).toBe('final');
    expect(late.message).toBe(
      'This has to be done with signal, and it waited 12 minutes to go, so it wasn’t done. Try it again.',
    );
    // A yes to "Still send?" doesn't make a payment late.
    expect(
      refusal(() =>
        assertOnTime(online, phone({ occurredAt: ago(12 * MIN), confirmedAt: NOW }), NOW),
      )?.rule,
    ).toBe('online_only');
  });

  it('lets an any-time change through however late, and leaves the web alone', () => {
    const days = phone({ occurredAt: ago(3 * 24 * 60 * MIN) });
    expect(refusal(() => assertOnTime(command('anytime'), days, NOW))).toBeNull();
    const web: RequestMeta = { correlationId: 'x', channel: 'web' };
    expect(refusal(() => assertOnTime(command('online'), web, NOW))).toBeNull();
    expect(refusal(() => assertAppRequest(web))).toBeNull();
  });

  it('refuses a phone command that doesn’t say which one it is or when it was done', () => {
    const missing = refusal(() => assertAppRequest(phone({ commandId: null, occurredAt: null })))!;
    expect(missing).toMatchObject({ code: 'validation', status: 400 });
    expect(missing.disposition).toBe('final');
    expect((missing.details as { path: string }[]).map((d) => d.path)).toEqual([
      APP_HEADERS.commandId,
      APP_HEADERS.occurredAt,
    ]);
  });

  it('makes a command online unless its definition says otherwise', () => {
    expect(command(undefined as unknown as OfflineClass).offline).toBe('online');
  });
});

describe('offline classes', () => {
  const FRESH = { freshMinutes: 30 };
  /** Every command the phone uses (the plan's Core list), and the class it has. */
  const PHONE: Record<string, OfflineClass> = {
    // Customers, companies, leads and tasks: any time.
    'person.create': 'anytime',
    'person.update': 'anytime',
    'person.archive': 'anytime',
    'person.restore': 'anytime',
    'company.create': 'anytime',
    'company.update': 'anytime',
    'company.archive': 'anytime',
    'company.restore': 'anytime',
    'lead.create': 'anytime',
    'lead.update': 'anytime',
    'lead.move_stage': 'anytime',
    'lead.set_next_action': 'anytime',
    'lead.archive': 'anytime',
    'lead.restore': 'anytime',
    'lead.record_answers': 'anytime',
    'task.create': 'anytime',
    'task.update': 'anytime',
    'task.complete': 'anytime',
    'task.reopen': 'anytime',
    'task.delete': 'anytime',
    // A form filled in on a job (M17): made and sent in one go, with an id the phone gave it, so the queue
    // retrying it is the same answer sheet rather than a second one. The visitor's own two-step
    // (form_response.start, then .submit) stays online, because it needs the key the server hands back.
    'form_response.record': 'anytime',
    // Notes, tags and photos.
    'activity.log': 'anytime',
    'record.add_tag': 'anytime',
    'record.remove_tag': 'anytime',
    'file.begin_upload': 'anytime',
    'file.confirm': 'anytime',
    // The inbox: any time, except what reaches the customer.
    'conversation.open': 'anytime',
    'conversation.mark_read': 'anytime',
    'conversation.mark_unread': 'anytime',
    'conversation.assign': 'anytime',
    'conversation.snooze': 'anytime',
    'conversation.close': 'anytime',
    'conversation.reopen': 'anytime',
    'conversation.link_person': 'anytime',
    'conversation.take_over': 'anytime',
    'conversation.hand_to_ai': FRESH,
    'message.send': FRESH,
    // Cancelling a text that waits for quiet hours to end only keeps it from going.
    'message.cancel_scheduled': 'anytime',
    // The Action Center and approvals.
    'attention.snooze': 'anytime',
    'attention.unsnooze': 'anytime',
    'attention.dismiss': 'anytime',
    'attention.restore': 'anytime',
    'attention.assign': 'anytime',
    'attention.cancel_auto': 'anytime',
    'attention.let_handle': FRESH,
    'ai_teammate.decide_draft': FRESH,
    'ai_teammate.send_draft': FRESH,
    'workflow.decide_approval': FRESH,
    // The calendar: bookings reach the customer; notes and done-or-no-show don't.
    'appointment.create': FRESH,
    'appointment.reschedule': FRESH,
    'appointment.cancel': FRESH,
    'appointment.update': 'anytime',
    'appointment.set_status': 'anytime',
    'appointment.still_going': 'anytime',
    'attendee.confirm': 'anytime',
    // A job's status texts the customer (On my way and the rest), so it waits for a fresh phone.
    'job.set_status': FRESH,
    // Putting a conversation away and bringing it back: nothing reaches a customer either way, and doing it
    // twice is doing it once. The phone's screen and sync rules come with the M16 mobile work; the class is
    // declared here because the kernel's answer does not depend on a screen existing yet.
    'conversation.archive': 'anytime',
    'conversation.restore': 'anytime',
    // Closing every lane a customer has (0089). Same reasoning: nothing reaches them, and closing what is
    // already closed is closing it once.
    'conversation.close_all': 'anytime',
    // Money: cash is recorded any time; sending a document or a link reaches the customer.
    'invoice.record_cash_payment': 'anytime',
    'invoice.send': FRESH,
    'estimate.send': FRESH,
    'subscription.request_card': FRESH,
    // Check-ins (round six): checking in, adding time and checking out, with no signal.
    'safety.check_in': 'anytime',
    'safety.check_out': 'anytime',
    'safety.extend': 'anytime',
    // Where the phone is, while a check-in shares it (round seven): only the latest waits.
    'safety.where': 'anytime',
  };
  /**
   * An add-on's commands that may wait are its own test's to hold, against the phone's list (Real Estate:
   * test/addons/realestate-offline.test.ts).
   */
  const ofAnAddon = (name: string) => BUILT_ADDONS.some((a) => name.startsWith(`${a.id}.`));

  it('gives every command the phone uses its class, and every other command online', () => {
    for (const [name, offline] of Object.entries(PHONE)) {
      const cmd = registry.command(name);
      expect(cmd, name).toBeDefined();
      expect(cmd!.offline, name).toEqual(offline);
    }
    const others = registry.commands.filter((c) => !(c.name in PHONE) && !ofAnAddon(c.name));
    expect(others.filter((c) => c.offline !== 'online').map((c) => c.name)).toEqual([]);
    // Among them: tags replaced wholesale, a customer's texting consent (a queued "yes" could undo a STOP that came
    // after it), calls, the Assistant, settings and team changes.
    for (const name of [
      'record.set_tags',
      'person.set_sms_consent',
      'call.start',
      'message.retry',
      'assistant_thread.rename',
      'attention.save_settings',
      'automations.save_settings',
      'money.save_settings',
      'workspace.update',
      'membership.invite',
      'membership.change_role',
      'membership.remove',
    ])
      expect(registry.command(name)!.offline, name).toBe('online');
  });

  it('never lets money move from a phone that waited', () => {
    const allowed = new Set([
      'invoice.record_cash_payment',
      'invoice.send',
      'estimate.send',
      'subscription.request_card',
    ]);
    const moneyMoves = registry.commands.filter(
      (c) =>
        c.permission === 'money.manage' ||
        /^(payment|refund|subscription|payment_connection|invoice|estimate|booking)\./.test(c.name),
    );
    expect(moneyMoves.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'payment.refund',
        'subscription.start',
        'payment_connection.connect',
      ]),
    );
    for (const c of moneyMoves) if (!allowed.has(c.name)) expect(c.offline, c.name).toBe('online');
    // Recording cash already in hand is the only money a phone writes on its own.
    expect(registry.command('payment.refund')!.offline).toBe('online');
    expect(registry.command('subscription.cancel')!.offline).toBe('online');
  });

  /**
   * A staff permission is checked against the staff role, and only a PLATFORM scope ever resolves one — so a
   * command or query asking for `platform.*` or `support.*` from inside a workspace can never pass, whoever
   * calls it. `wallet.adjust` shipped that way and was unreachable by anybody until this rule was written.
   */
  it('gives every staff permission a platform scope, or it is unreachable', () => {
    const staffy = (permission: string | null) =>
      permission !== null && /^(platform|support)\./.test(permission);
    const wrong: string[] = [];
    for (const d of [...registry.commands, ...registry.queries]) {
      if (!staffy(d.permission)) continue;
      // The scope function is called with a shape wide enough for either kind, and only its `kind` matters.
      const anyId = '11111111-1111-4111-8111-111111111111';
      const kind = d.scope({ workspaceId: anyId, organizationId: anyId } as never).kind;
      if (kind !== 'platform') wrong.push(`${d.name} (${d.permission} in a ${kind} scope)`);
    }
    expect(wrong).toEqual([]);
  });

  it('has a valid class on every command', () => {
    for (const c of registry.commands) {
      const ok =
        c.offline === 'anytime' ||
        c.offline === 'online' ||
        (typeof c.offline === 'object' &&
          Number.isInteger(c.offline.freshMinutes) &&
          c.offline.freshMinutes > 0);
      expect(ok, c.name).toBe(true);
    }
  });
});

describe('stored answers', () => {
  it('hash the same input the same however its keys were ordered', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"e":2,"f":1}]},"b":1}',
    );
    expect(inputHashOf({ workspaceId: 'w', body: 'Hi' })).toBe(
      inputHashOf({ body: 'Hi', workspaceId: 'w' }),
    );
    expect(inputHashOf({ body: 'Hi' })).not.toBe(inputHashOf({ body: 'Hi!' }));
    expect(inputHashOf({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keep no credential at any depth, nor a command’s one-time keys', () => {
    expect(
      keepableAnswer(
        {
          connectionId: 'c1',
          state: 'one-time',
          lines: [{ name: 'Labour', apiKey: 'x', accessToken: 'y' }],
          nested: { webhookSecret: 'z', label: 'kept' },
        },
        ['state'],
      ),
    ).toEqual({ connectionId: 'c1', lines: [{ name: 'Labour' }], nested: { label: 'kept' } });
    for (const name of [
      'mailbox.connect',
      'calendar_connection.connect',
      'payment_connection.connect',
    ])
      expect(registry.command(name)!.shownOnce, name).toEqual(['state']);
  });
});
