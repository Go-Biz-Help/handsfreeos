/**
 * Development seed. Builds the demo data the way production would: accounts through Supabase Auth,
 * every change through the command pipeline (events + outbox + audit), invitation emails through the
 * worker into Mailpit, and invitations accepted from the emailed links.
 *
 *   pnpm db:seed     seed a running local stack (does nothing when the data is already there)
 *   pnpm db:reset    `supabase db reset` followed by the seed
 *
 * Local only: reads the repo-root .env.local written by `pnpm env:local`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  executeCommand,
  invitationAccept,
  membershipChangeRole,
  membershipInvite,
  organizationCreate,
  workspaceCreate,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import pino from 'pino';
import { createBookingLinks } from '../src/booking/links';
import { createSealer } from '../src/crypto';
import { fakeCalendarServices } from '../src/calendar/index';
import { fakeReviewServices } from '../src/reviews/index';
import { fakeMailboxServices } from '../src/mailbox/index';
import { fakePaymentServices } from '../src/payments/index';
import { fakePushServices } from '../src/push/index';
import { createLocalEmail, LOCAL_WEBHOOK_PASSWORD } from '../src/email/local';
import { handlers } from '../src/handlers/index';
import { createSafeFetch } from '../src/http/safe-fetch';
import { createSmtpMailer } from '../src/mailer';
import { createUnsubscribeLinks } from '../src/email/unsubscribe';
import { createMoneyLinks } from '../src/money/links';
import { processOnce, type OutboxDeps } from '../src/outbox';
import { createSupabaseStore, unconfiguredStore } from '../src/storage';
import { createFakeTelephony } from '../src/telephony/fake';
import { createFakeHost } from '../src/hosting';
import { roughDriveTimer } from '../src/geo/driving';
import { createFakeSpeech } from '../src/voice-agent/fake-speech';
import { createFakeGeocoder } from '../src/geo/geocoder';
import { createFakeTranscriber } from '../src/telephony/fake-transcriber';
import { createWorkflowAi } from '../src/workflows/ai-runner';
import { seedAiTeam } from './seed-ai-team';
import { seedAssistant } from './seed-assistant';
import { seedAttention } from './seed-attention';
import { seedCalendar } from './seed-calendar';
import { seedCrm } from './seed-crm';
import { seedGlow } from './seed-glow';
import { seedIdeas } from './seed-ideas';
import { seedAi, seedKnowledge } from './seed-knowledge';
import { LONE_STAR_NUMBER, seedMessaging } from './seed-messaging';
import { seedMoney } from './seed-money';
import { seedWorkflows } from './seed-workflows';

export const SEED_PASSWORD = 'HandsFree-Demo-2026';

const PEOPLE = {
  chris: { email: 'chris@gobizhelp.test', name: 'Chris Demo' },
  dale: { email: 'dale@lonestarhvac.test', name: 'Dale Ramsey' },
  priya: { email: 'priya@lonestarhvac.test', name: 'Priya Natarajan' },
  marco: { email: 'marco@lonestarhvac.test', name: 'Marco Villanueva' },
  renee: { email: 'renee@bayouplumbing.test', name: 'Renée Fontenot' },
  tom: { email: 'tom@summitroofing.test', name: 'Tom Whitaker' },
  riley: { email: 'riley@northstarelectric.test', name: 'Riley Chen' },
} as const;
type PersonKey = keyof typeof PEOPLE;
const PENDING_INVITEE = 'jordan@lonestarhvac.test';

const actor = (user: TestUser): HumanActor => ({
  type: 'human',
  userId: user.id,
  email: user.email,
  claims: user.claims,
});
const meta = (): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'cli',
  reason: 'Development seed',
});
const step = (msg: string): void => console.log(`• ${msg}`);

/**
 * The dev worker's own encryption key (apps/worker/.env, written by `pnpm env:local`; only that line is read),
 * so the telephony secrets and booking links the seed seals open in `pnpm dev`. Without it the voice-token
 * route couldn't open the business's calling key after `pnpm db:reset`.
 */
function workerKey(): string {
  const set = process.env.WORKER_ENCRYPTION_KEY?.trim();
  if (set) return set;
  const path = resolve(import.meta.dirname, '../.env');
  const key = existsSync(path)
    ? parseEnv(readFileSync(path, 'utf8'))['WORKER_ENCRYPTION_KEY']?.trim()
    : undefined;
  if (key) return key;
  console.warn(
    'No WORKER_ENCRYPTION_KEY in apps/worker/.env (run `pnpm env:local`): calls and booking links from the seed won’t open in the dev worker.',
  );
  return randomBytes(32).toString('base64');
}

/**
 * Runs the worker's outbox loop until nothing is pending, so emails go out and system events land. Only work
 * the seed created is claimed: test suites that ran against the same database leave their own events behind.
 */
async function drainOutbox(deps: OutboxDeps, admin: Db, since: string): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    await rows(
      admin,
      sql`update app.outbox set locked_at = now(), locked_by = ${deps.workerId}
          where status = 'pending' and created_at >= ${since}::timestamptz`,
    );
    const stats = await processOnce(deps);
    if (stats.retried > 0 || stats.failed > 0) {
      throw new Error(
        `${stats.retried + stats.failed} outbox job(s) failed (see app.outbox.last_error). Is Mailpit's SMTP port reachable?`,
      );
    }
    if (stats.claimed === 0) return;
  }
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

/** Reads the single-use invitation token from the email the worker sent to Mailpit. */
async function invitationToken(mailpitUrl: string, to: string, after: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  const query = encodeURIComponent(`to:"${to}"`);
  while (Date.now() < deadline) {
    const res = await fetch(`${mailpitUrl}/api/v1/search?query=${query}&limit=20`);
    if (!res.ok) throw new Error(`Mailpit search failed with ${res.status} at ${mailpitUrl}`);
    const { messages } = (await res.json()) as { messages: MailpitSummary[] };
    const hit = messages.find(
      (m) => m.Subject.includes('invited you') && new Date(m.Created).getTime() >= after - 5_000,
    );
    if (hit) {
      const full = (await (await fetch(`${mailpitUrl}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      const match = /\/invite\/(inv_[A-Za-z0-9_-]+)/.exec(full.Text);
      if (match?.[1]) return match[1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `No invitation email for ${to} reached Mailpit (${mailpitUrl}) within 30s. Is the local Supabase stack running?`,
  );
}

async function main(): Promise<void> {
  const env = testEnv();
  const { api, worker, admin } = testDbs();
  const existing = await rows<{ id: string }>(
    admin.db,
    sql`select id from app.users where email = ${PEOPLE.chris.email}`,
  );
  if (existing.length > 0) {
    console.log(
      `Seed data is already present (${PEOPLE.chris.email} exists). Run \`pnpm db:reset\` to start from scratch.`,
    );
    return;
  }

  const started = Date.now();
  const since = (await rows<{ now: string }>(admin.db, sql`select now()::text as now`))[0]!.now;
  const log = pino({ level: 'warn' });
  const key = workerKey();
  const deps: OutboxDeps = {
    db: worker.db,
    // The demo data is not a billing exercise: seeding a business should not leave it owing money.
    wallet: { db: worker.db, log, mode: 'off' as const },
    support: {
      mailDomain: 'handsfreeos.local',
      addresses: ['support', 'help'],
      fromName: 'HandsFreeOS Support',
      ownerEmails: [],
    },
    mailer: createSmtpMailer(
      process.env.SMTP_URL ?? 'smtp://127.0.0.1:54425',
      process.env.MAIL_FROM ?? 'HandsFreeOS <hello@handsfreeos.local>',
    ),
    store:
      process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
        ? createSupabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
        : unconfiguredStore,
    log,
    handlers,
    webUrl: (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    publicUrl: (process.env.WORKER_PUBLIC_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, ''),
    // The seed never reaches a carrier: the fake stands in, and sealed tokens use the dev worker's key.
    telephony: createFakeTelephony({ approvalMs: 0, callbacks: false, log }),
    transcriber: createFakeTranscriber({ log }),
    geocoder: createFakeGeocoder(),
    driving: roughDriveTimer,
    speech: createFakeSpeech(),
    voiceAi: null,
    // The seed never touches a real host; a branded domain in it is the fake's (M17).
    siteHost: createFakeHost(),
    sealer: createSealer(key),
    reminderOverrideMs: null,
    registrationPollMs: 50,
    portPollMs: 2_000,
    email: {
      ...createLocalEmail({
        smtpUrl: process.env.SMTP_URL ?? 'smtp://127.0.0.1:54425',
        eventsUrl: null,
        webhookUser: 'postmark',
        webhookPassword: LOCAL_WEBHOOK_PASSWORD,
        log,
      }),
      mailDomain: 'mail.handsfreeos.com',
      webhookUser: 'postmark',
      webhookPassword: LOCAL_WEBHOOK_PASSWORD,
      bulkReady: true,
    },
    mailboxes: fakeMailboxServices(
      (process.env.WORKER_PUBLIC_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, ''),
      60_000,
    ),
    calendars: fakeCalendarServices(
      (process.env.WORKER_PUBLIC_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, ''),
      60_000,
    ),
    reviews: fakeReviewServices(
      (process.env.WORKER_PUBLIC_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, ''),
      60_000,
    ),
    // The stand-in provider, so the seed can connect a payment account and take a payment through it.
    payments: fakePaymentServices(
      (process.env.WORKER_PUBLIC_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, ''),
      { settleMs: 0 },
    ),
    bookingLinks: createBookingLinks({
      webUrl: (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
      key,
    }),
    moneyLinks: createMoneyLinks({
      webUrl: (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
      key,
    }),
    unsubscribeLinks: createUnsubscribeLinks({
      webUrl: (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
      publicUrl: process.env.WORKER_PUBLIC_URL ?? 'http://localhost:8788',
      key,
    }),
    fetchUrl: createSafeFetch(),
    ai: { provider: null, dailyTokens: 2_000_000 },
    // The seed registers no phones, so nothing is pushed; the stand-in keeps it that way.
    push: fakePushServices(),
    workerId: `seed:${hostname()}:${process.pid}`,
    batchSize: 50,
    reservedOnly: true,
  };

  step('Creating accounts (confirmed, one shared demo password)');
  const users = {} as Record<PersonKey, TestUser>;
  for (const key of Object.keys(PEOPLE) as PersonKey[]) {
    const person = PEOPLE[key];
    users[key] = await createTestUser(key, {
      email: person.email,
      password: SEED_PASSWORD,
      fullName: person.name,
    });
  }
  const { chris, dale, priya, marco, renee, tom, riley } = users;

  step('Go Biz Help (agency organization) with its first client workspace');
  const org = (
    await executeCommand(
      api.db,
      organizationCreate,
      {
        businessName: 'Lone Star HVAC & Roofing',
        organizationName: 'Go Biz Help',
        timezone: 'America/Chicago',
      },
      actor(chris),
      meta(),
    )
  ).output;
  const lonestar = org.workspaceId;

  step('Two more client workspaces');
  const bayou = (
    await executeCommand(
      api.db,
      workspaceCreate,
      {
        organizationId: org.organizationId,
        name: 'Bayou Plumbing Co.',
        timezone: 'America/Chicago',
      },
      actor(chris),
      meta(),
    )
  ).output.workspaceId;
  const summit = (
    await executeCommand(
      api.db,
      workspaceCreate,
      { organizationId: org.organizationId, name: 'Summit Roofing', timezone: 'America/Denver' },
      actor(chris),
      meta(),
    )
  ).output.workspaceId;

  step('Inviting client staff; the worker emails each single-use link to Mailpit');
  const invites: { workspaceId: string; user: TestUser; role: 'owner' | 'admin' | 'member' }[] = [
    { workspaceId: lonestar, user: dale, role: 'owner' },
    { workspaceId: lonestar, user: priya, role: 'admin' },
    { workspaceId: lonestar, user: marco, role: 'admin' },
    { workspaceId: bayou, user: renee, role: 'owner' },
    { workspaceId: summit, user: tom, role: 'owner' },
  ];
  for (const invite of invites) {
    await executeCommand(
      api.db,
      membershipInvite,
      { workspaceId: invite.workspaceId, email: invite.user.email, role: invite.role },
      actor(chris),
      meta(),
    );
  }
  await drainOutbox(deps, admin.db, since);

  step('Accepting the invitations from the emailed links');
  for (const invite of invites) {
    const token = await invitationToken(env.mailpitUrl, invite.user.email, started);
    await executeCommand(api.db, invitationAccept, { token }, actor(invite.user), meta());
  }

  step("Dale changes Marco's role from Admin to Member");
  await executeCommand(
    api.db,
    membershipChangeRole,
    { workspaceId: lonestar, userId: marco.id, role: 'member' },
    actor(dale),
    meta(),
  );

  step(`Priya invites ${PENDING_INVITEE}; it stays pending`);
  await executeCommand(
    api.db,
    membershipInvite,
    { workspaceId: lonestar, email: PENDING_INVITEE, role: 'member' },
    actor(priya),
    meta(),
  );
  await drainOutbox(deps, admin.db, since);

  await seedCrm(
    { api: api.db, admin: admin.db, store: deps.store, actor, meta, step },
    {
      lonestar: { id: lonestar, dale, priya, marco },
      bayou: { id: bayou, owner: renee },
      summit: { id: summit, owner: tom },
    },
  );
  await drainOutbox(deps, admin.db, since);

  const messaging = await seedMessaging(
    { api: api.db, admin: admin.db, worker: deps, actor, meta, step, since },
    { id: lonestar, organizationId: org.organizationId, dale, priya },
  );

  await seedAssistant(
    { worker: worker.db, admin: admin.db, actor, step, log },
    { id: lonestar, dale },
  );
  await drainOutbox(deps, admin.db, since);

  const calendar = await seedCalendar(
    { api: api.db, admin: admin.db, worker: deps, actor, meta, step, since },
    { id: lonestar, organizationId: org.organizationId, dale, priya, marco },
  );

  const glow = await seedGlow(
    { api: api.db, admin: admin.db, worker: deps, actor, meta, step, since },
    { organizationId: org.organizationId, chris },
  );

  // Milestone 6: the stand-in model (with the seed's own rules) answers AI steps, Try it and the website scan.
  const ai = { provider: seedAi(), dailyTokens: 2_000_000 };
  const flow = {
    ...deps,
    ai,
    workflowAi: createWorkflowAi({ db: worker.db, ai, log, wallet: deps.wallet }),
  };
  const knowledge = await seedKnowledge(
    { api: api.db, admin: admin.db, worker: flow, actor, meta, step, since },
    { id: lonestar, organizationId: org.organizationId, dale },
  );
  const flows = await seedWorkflows(
    { api: api.db, admin: admin.db, worker: flow, actor, meta, step, since },
    {
      organizationId: org.organizationId,
      chris,
      lonestar: { id: lonestar, dale, priya, marco },
      bayou: { id: bayou, owner: renee },
    },
  );

  // Milestone 7: Lone Star's AI teammate, run by the worker's own runtime with the seed's stand-in model.
  const ava = await seedAiTeam(
    { api: api.db, admin: admin.db, worker: flow, actor, meta, step, since },
    { id: lonestar, organizationId: org.organizationId, dale, priya },
  );

  // Milestone 9: what Lone Star sells, what it is owed and what it has been paid. Before the Action Center,
  // so its sweep finds the overdue invoice and the estimate nobody has answered along with everything else.
  const money = await seedMoney(
    { api: api.db, admin: admin.db, worker: flow, actor, meta, step, since },
    { id: lonestar, organizationId: org.organizationId, dale, priya, site: calendar.site },
  );

  // Milestone 8: what needs Dale's attention, as the Action Center lists it, and the sweep that opens it all.
  const attention = await seedAttention(
    { api: api.db, admin: admin.db, worker: flow, actor, meta, step, since },
    { id: lonestar, organizationId: org.organizationId, dale, priya },
  );

  // Milestone 13: HandsFreeOS's own support desk. Chris answers it, and two tickets are already waiting —
  // one that came in by email from a customer nobody has answered, and one he has already replied to.
  step('The support desk: Chris as its admin, two tickets and a saved reply');
  await rows(
    admin.db,
    sql`insert into platform.staff (user_id, role, display_name, signature)
        values (${chris.id}, 'admin', 'Chris', '— Chris at HandsFreeOS')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
  await rows(
    admin.db,
    sql`insert into platform.canned_replies (title, body_text, created_by) values
        ('Texts are not arriving',
         'Thanks for flagging this. I can see your number is registered and the last messages left us, so let me trace the exact one: what number did you text, and roughly when?',
         ${chris.id}),
        ('How billing works',
         'Your plan renews on the same day each month and the receipt goes to the address on the account. Nothing is charged for a business you have not switched on yet.',
         ${chris.id})
        on conflict do nothing`,
  );
  const [waiting] = await rows<{ id: string }>(
    admin.db,
    sql`insert into platform.tickets
          (subject, channel, status, requester_email, requester_name, requester_user_id,
           workspace_id, organization_id, last_customer_at)
        values ('Appointment reminders stopped going out', 'email', 'new', ${dale.email}, 'Dale Ramsey',
          ${dale.id}, ${lonestar}, ${org.organizationId}, now() - interval '35 minutes')
        returning id`,
  );
  await rows(
    admin.db,
    sql`insert into platform.ticket_messages (ticket_id, author, author_user_id, body_text, created_at)
        values (${waiting!.id}, 'customer', ${dale.id},
          'Morning — our reminders went out fine last week and nothing has gone out since Monday. Two customers missed their slots yesterday.',
          now() - interval '35 minutes')`,
  );
  const [answered] = await rows<{ id: string }>(
    admin.db,
    sql`insert into platform.tickets
          (subject, channel, status, requester_email, requester_name, requester_user_id, workspace_id,
           organization_id, assignee_user_id, last_customer_at, last_staff_at, first_response_at)
        values ('Can I add a second phone number?', 'in_app', 'waiting_on_customer', ${priya.email},
          'Priya Natarajan', ${priya.id}, ${lonestar}, ${org.organizationId}, ${chris.id},
          now() - interval '2 days', now() - interval '2 days', now() - interval '2 days')
        returning id`,
  );
  await rows(
    admin.db,
    sql`insert into platform.ticket_messages (ticket_id, author, author_user_id, body_text, created_at) values
        (${answered!.id}, 'customer', ${priya.id},
         'We want a separate number for the Dallas van. Can we add one without a second account?',
         now() - interval '2 days'),
        (${answered!.id}, 'staff', ${chris.id},
         'Yes — Settings, then Phone, then Add a number. It lands in the same inbox, and you choose which one each workflow texts from. Want me to walk through it on a call?',
         now() - interval '2 days' + interval '20 minutes')`,
  );

  step('Northstar Electric: a separate organization that sees none of the above');
  const northstar = (
    await executeCommand(
      api.db,
      organizationCreate,
      { businessName: 'Northstar Electric', timezone: 'America/Los_Angeles' },
      actor(riley),
      meta(),
    )
  ).output.workspaceId;

  // Ideas, the roadmap and What's new (0102): the one board every business shares, so it comes last, once
  // Northstar can take part too. Chris answers it as the team.
  const ideas = await seedIdeas(
    { api: api.db, actor, meta, step },
    {
      chris,
      dale: { user: dale, workspaceId: lonestar },
      priya: { user: priya, workspaceId: lonestar },
      marco: { user: marco, workspaceId: lonestar },
      renee: { user: renee, workspaceId: bayou },
      tom: { user: tom, workspaceId: summit },
      riley: { user: riley, workspaceId: northstar },
    },
  );
  await drainOutbox(deps, admin.db, since);

  console.log(`
Seeded in ${((Date.now() - started) / 1000).toFixed(1)}s. Sign in at ${deps.webUrl}/sign-in with password ${SEED_PASSWORD}:

  ${chris.email.padEnd(30)} Owner of Go Biz Help (agency); reaches every client workspace, and answers support at /admin
  ${dale.email.padEnd(30)} Owner, Lone Star HVAC & Roofing
  ${priya.email.padEnd(30)} Admin, Lone Star HVAC & Roofing
  ${marco.email.padEnd(30)} Member, Lone Star HVAC & Roofing
  ${renee.email.padEnd(30)} Owner, Bayou Plumbing Co.
  ${tom.email.padEnd(30)} Owner, Summit Roofing
  ${riley.email.padEnd(30)} Owner of Northstar Electric (separate organization)

Lone Star HVAC & Roofing has about thirty customers, two pipelines, twenty leads, tasks, notes and two photos,
the business number ${LONE_STAR_NUMBER} with texting approved, ${messaging.conversations} conversations (texts, email, an unknown
number, a STOP) and ${messaging.calls} calls including a voicemail with its transcript. Dale's Assistant
panel (Cmd+J) holds two earlier chats; answering new questions needs ANTHROPIC_API_KEY in apps/worker/.env.
Its calendar (${calendar.seconds.toFixed(1)}s of the seed) has ${calendar.appointments} appointments over about two weeks, three class sessions (one full,
${calendar.waiting} waiting) and Dale's stand-in Google calendar with ${calendar.busyTimes} busy times. Customers book at ${deps.webUrl}/book/${calendar.site}:
${calendar.calendars.map((c) => `  ${c.name.padEnd(22)} ${c.labels.padEnd(34)} ${deps.webUrl}/book/${calendar.site}/${c.slug}`).join('\n')}
Glow Red Light Studio (${glow.seconds.toFixed(1)}s of the seed) books its four red light beds with no staff: ${glow.bookings} bookings over
the next three weekdays, every bed taken at 5 PM once. Customers book at ${deps.webUrl}/book/${glow.site}:
  ${glow.calendar.name.padEnd(22)} ${glow.calendar.labels.padEnd(34)} ${deps.webUrl}/book/${glow.site}/${glow.calendar.slug}
Lone Star's knowledge base (${knowledge.seconds.toFixed(1)}s of the seed) has a filled-in profile, ${knowledge.published} published items and ${knowledge.drafts} draft, and
${knowledge.suggestions} suggestions waiting: from a scan of its stand-in website, and customers' question "Do you offer financing?".
Its workflows (${flows.seconds.toFixed(1)}s): "Speed to lead" and "Missed-call text back" are live, with a finished run, a waiting one, one
waiting for an OK of an AI-written text and one failed with Retry; "Appointment follow-up + review" is a draft.
Go Biz Help's template "${flows.template}" is on version ${flows.templateVersion}; Bayou has version ${flows.bayouVersion},
so it shows Update available, and the "HVAC FAQs" pack's ${flows.packItems} items wait there as suggestions.
Its AI teammate ${ava.name} (${ava.seconds.toFixed(1)}s) answers texts and the website chat in training wheels, at ${ava.approved} of ${ava.approvalsNeeded} approved · ${ava.edited} edited:
${ava.answered} conversations she answered, Tom Reyes waiting in Needs a person with her note, Kendra Lee's reply waiting for an OK
(it waits a day after the seed ran before a person gets it), and Angela Brooks's website chat, where her Attic insulation lead qualified. The
chat widget shows on ${ava.site}; try it at ${deps.webUrl}/chat-preview/${ava.widgetKey}?w=${lonestar}
Its money (${money.seconds.toFixed(1)}s) runs on ${money.accounts}, with ${money.products} things in the catalogue and the Comfort Club at $29 a month:
  Paid, by card, with a receipt      ${money.paid}
  Overdue, ten days past due         ${money.overdue}
  An estimate waiting on an answer   ${money.waiting}
  Out yesterday, not opened yet      ${money.fresh}
  Declined                           ${money.declined}
  A draft nobody has sent            ${money.draft}
  A deposit paid to hold a time      ${money.depositInvoice} · ${money.depositAmount}, credited on ${money.jobInvoice}
  A time held while ${money.heldFor} pays  (it goes back in 15 minutes if he doesn't)
  A plan billing monthly             ${money.planCycle}
  A plan waiting on a card           ${money.planWaiting}
Customers pay deposits at ${deps.webUrl}/book/${calendar.site}/${money.depositCalendar}.
Dale's Action Center (${attention.seconds.toFixed(1)}s) opens on ${attention.hotLead}: waiting about 11 minutes, ready to book, and
nobody has answered. Under it, an overdue invoice, an estimate nobody answered, a website lead from three days ago
nobody answered, leads gone quiet, leads with no next action, overdue tasks, customers waiting and Ava's reply to
approve. ${attention.unconfirmed} visits aren't confirmed (they fold into one card), ${attention.confirmed} customers have confirmed theirs, and ${attention.handled} are
under "Handled by HandsFreeOS".
Ideas (in the menu of every business) holds ${ideas.ideas} ideas from four businesses: one planned, one being built with a
duplicate merged into it, one shipped in What's new, one not planned and two under review. What's new has
${ideas.published} entries published and a draft; Chris runs the roadmap at ${deps.webUrl}/admin/ideas.
Emails the stack sent, including the pending invitation for ${PENDING_INVITEE}: ${env.mailpitUrl}
`);
}

main()
  .then(() => closeTestDbs())
  .catch(async (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    await closeTestDbs().catch(() => undefined);
    process.exit(1);
  });
