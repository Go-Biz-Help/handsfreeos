/**
 * Settings → Automations' leads and sales rows (stage 2a), on the real database with the fake carrier and the
 * scripted model:
 * - "New lead greeting" at night: a lead that came in on its own is texted within 15 minutes of arriving, even in
 *   quiet hours; one older than that, or one somebody typed in, waits for the morning.
 * - "Follow-ups when a lead never replied": the follow-up is written from what they sent when they came in.
 * - "Re-engage dead leads": off until an owner reads the message; then one text a day's cap at a time to open
 *   leads gone cold, with texting consent, never twice within the cooldown, never to someone being talked to.
 */
import { randomUUID } from 'node:crypto';
import {
  automationsSaveSettings,
  defaultAutomationSettings,
  executeCommand,
  leadCreate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followUpJobKey, outreachJobKey } from '../src/ai-team/index';
import { REENGAGE_JOB, reengageJobKey } from '../src/automations/index';
import { systemActor } from '../src/services';
import {
  admin,
  aiMessages,
  drain,
  hh,
  hourNow,
  jobRow,
  newCustomer,
  run,
  runDue,
  runNow,
  scopeOf,
  setQuietHours,
  teammateRequests,
  teammateWorld,
  textIn,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;

beforeAll(async () => {
  w = await teammateWorld('autolead', { status: 'automatic' });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

async function agreesToTexts(personId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${personId}`,
  );
}

/** A lead that came in on its own (a form, a website): nobody typed it in. */
async function arrivedLead(personId: string, title = 'AC install'): Promise<string> {
  const { output } = await executeCommand(
    testDbs().worker.db,
    leadCreate,
    { workspaceId: w.workspaceId, title, personId },
    systemActor(scopeOf(w)),
    { correlationId: randomUUID(), channel: 'worker' },
  );
  await drain(w);
  return output.leadId;
}

const runsFor = (personId: string) =>
  rows<{ conversation_id: string | null }>(
    admin(),
    sql`select conversation_id from app.ai_teammate_runs where person_id = ${personId}
        order by started_at`,
  );

describe('new lead greeting at night', () => {
  it('texts a lead that just came in, in quiet hours; an older or typed-in one waits for morning', async () => {
    const H = hourNow();
    await setQuietHours(w, { start: hh(H - 1), end: hh(H + 2) });
    try {
      // Just came in: greeted now.
      const fresh = await newCustomer(w, 'Nora');
      await agreesToTexts(fresh.id);
      const freshLead = await arrivedLead(fresh.id);
      await runNow(w, [outreachJobKey(freshLead)]);
      expect(textsTo(w, fresh.phone)).toHaveLength(1);

      // Came in 20 minutes ago: past the window, so it waits for quiet hours to end.
      const late = await newCustomer(w, 'Omar');
      await agreesToTexts(late.id);
      const lateLead = await arrivedLead(late.id);
      await rows(
        admin(),
        sql`update app.leads set created_at = now() - interval '20 minutes' where id = ${lateLead}`,
      );
      await runNow(w, [outreachJobKey(lateLead)]);
      expect(textsTo(w, late.phone)).toHaveLength(0);
      const waiting = await jobRow(outreachJobKey(lateLead));
      expect(waiting?.status).toBe('pending');
      expect(new Date(waiting!.run_at).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

      // Typed in by a person: waits too.
      const typed = await newCustomer(w, 'Pia');
      await agreesToTexts(typed.id);
      const { leadId } = await run(w, leadCreate, {
        workspaceId: w.workspaceId,
        title: 'AC install',
        personId: typed.id,
      });
      await drain(w);
      await runNow(w, [outreachJobKey(leadId)]);
      expect(textsTo(w, typed.phone)).toHaveLength(0);
    } finally {
      await setQuietHours(w, null);
    }
  });
});

describe('follow-ups when a lead never replied', () => {
  it('writes the follow-up from what they sent when they came in', async () => {
    const c = await newCustomer(w, 'Quinn');
    await agreesToTexts(c.id);
    const leadId = await arrivedLead(c.id, 'Website enquiry');
    const [source] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.intake_sources (workspace_id, kind, name)
          values (${w.workspaceId}, 'website_form', 'Website form') returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.intake_submissions (workspace_id, source_id, dedupe_key, person_id, lead_id, outcome, payload)
          values (${w.workspaceId}, ${source!.id}, ${randomUUID()}, ${c.id}, ${leadId}, 'opened',
            ${JSON.stringify({
              name: 'Quinn Customer',
              email: 'quinn@example.com',
              message: 'Our upstairs AC is blowing warm air, two-story house',
            })}::jsonb)`,
    );
    await runNow(w, [outreachJobKey(leadId)]);
    const [first] = await runsFor(c.id);
    const conversationId = first!.conversation_id!;
    const before = teammateRequests(w).length;
    await runNow(w, [followUpJobKey(conversationId)]);
    const asked = JSON.stringify(teammateRequests(w).slice(before));
    expect(asked).toContain('<what_they_sent>');
    expect(asked).toContain('upstairs AC is blowing warm air');
    expect(asked).toContain('never answered your first message');
    // Their contact details aren't what they need.
    expect(asked).not.toContain('quinn@example.com');
    expect(await aiMessages(conversationId)).toHaveLength(2);
  });
});

describe('re-engage dead leads', () => {
  const H = 3_600_000;
  // Whatever the hour the tests run at.
  beforeAll(() => setQuietHours(w, null));

  async function coldLead(first: string, opts: { consent?: boolean; daysCold?: number } = {}) {
    const c = await newCustomer(w, first);
    if (opts.consent !== false) await agreesToTexts(c.id);
    const leadId = await arrivedLead(c.id, `${first}'s water heater`);
    const days = opts.daysCold ?? 120;
    await rows(
      admin(),
      sql`update app.leads set created_at = now() - make_interval(days => ${days}),
            last_contact_at = now() - make_interval(days => ${days})
          where id = ${leadId}`,
    );
    // The greeting it was armed with isn't part of this story.
    await rows(
      admin(),
      sql`delete from app.scheduled_jobs where dedupe_key = ${outreachJobKey(leadId)}`,
    );
    return { ...c, leadId };
  }

  async function runReengage(): Promise<void> {
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, ${REENGAGE_JOB}, ${reengageJobKey(w.workspaceId)},
            now(), '{}'::jsonb)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
          do update set run_at = now()`,
    );
    await drain(w);
  }

  const save = (settings: ReturnType<typeof defaultAutomationSettings>) =>
    run(w, automationsSaveSettings, { workspaceId: w.workspaceId, settings });

  it('sends nothing until an owner reads the message and turns it on', async () => {
    const off = await coldLead('Ravi');
    await runReengage();
    expect(textsTo(w, off.phone)).toHaveLength(0);
    // The switch alone is refused.
    const s = defaultAutomationSettings();
    const refused: unknown = await save({ ...s, switches: { ...s.switches, reengage: true } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(JSON.stringify((refused as { details?: unknown } | null)?.details)).toContain(
      'Looks good, turn on',
    );
    // Out of the next test's way: warm again.
    await rows(admin(), sql`update app.leads set last_contact_at = now() where id = ${off.leadId}`);
  });

  it('texts cold leads that agreed to texts, in the business’s words, once, up to the day’s cap', async () => {
    // Nobody else's leads in the way: the earlier tests' leads are warm.
    const s = defaultAutomationSettings();
    await save({
      ...s,
      switches: { ...s.switches, reengage: true },
      reengage: { ...s.reengage, reviewedAt: new Date().toISOString(), maxPerDay: 2 },
    });
    try {
      const a = await coldLead('Sana', { daysCold: 100 });
      const b = await coldLead('Theo', { daysCold: 110 });
      const c = await coldLead('Uma', { daysCold: 130 });
      const noConsent = await coldLead('Vik', { consent: false });
      const warm = await coldLead('Wes', { daysCold: 10 });
      await runReengage();
      // The cap: two today, the most recently cold first.
      expect([a, b, c].map((x) => textsTo(w, x.phone).length)).toEqual([1, 1, 0]);
      const body = textsTo(w, a.phone)[0]!.body;
      expect(body).toContain("It's been a while since we talked about Sana's water heater");
      // Its first text to that number carries the STOP wording.
      expect(body).toContain('Reply STOP to opt out.');
      expect(textsTo(w, noConsent.phone)).toHaveLength(0);
      expect(textsTo(w, warm.phone)).toHaveLength(0);
      // Each one is recorded on its lead, and the job waits for tomorrow's 10 AM.
      const [n] = await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events
            where workspace_id = ${w.workspaceId} and event_type = 'lead.reengaged'`,
      );
      expect(n!.n).toBe(2);
      const next = await jobRow(reengageJobKey(w.workspaceId));
      expect(new Date(next!.run_at).getTime()).toBeGreaterThan(Date.now() + H);

      // Again: the cap is spent for the day, and nobody gets a second.
      await runReengage();
      for (const x of [a, b, c]) expect(textsTo(w, x.phone).length).toBeLessThanOrEqual(1);

      // A day on (the job run as of tomorrow), the third gets theirs; the first two are within their cooldown.
      await rows(
        admin(),
        sql`update app.scheduled_jobs set run_at = now() + interval '1 day'
            where dedupe_key = ${reengageJobKey(w.workspaceId)} and status = 'pending'`,
      );
      await runDue(w, [reengageJobKey(w.workspaceId)]);
      for (const x of [a, b, c]) expect(textsTo(w, x.phone)).toHaveLength(1);
    } finally {
      await save(defaultAutomationSettings());
    }
  });

  it('leaves alone a cold lead someone has messaged since', async () => {
    const s = defaultAutomationSettings();
    await save({
      ...s,
      switches: { ...s.switches, reengage: true },
      reengage: { ...s.reengage, reviewedAt: new Date().toISOString() },
    });
    try {
      const x = await coldLead('Xena');
      // A text from them: they're not cold, whatever the lead's last contact says.
      await textIn(w, x.phone, 'Hi, just wondering about my quote');
      await runReengage();
      expect(textsTo(w, x.phone).filter((t) => t.body.includes('been a while'))).toHaveLength(0);
    } finally {
      await save(defaultAutomationSettings());
    }
  });
});
