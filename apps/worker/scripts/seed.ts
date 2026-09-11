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
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
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
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import pino from 'pino';
import { handlers } from '../src/handlers/index';
import { createSmtpMailer } from '../src/mailer';
import { processOnce, type OutboxDeps } from '../src/outbox';

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

/** Runs the worker's outbox loop until nothing is pending, so emails go out and system events land. */
async function drainOutbox(deps: OutboxDeps): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
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
  const deps: OutboxDeps = {
    db: worker.db,
    mailer: createSmtpMailer(
      process.env.SMTP_URL ?? 'smtp://127.0.0.1:54425',
      process.env.MAIL_FROM ?? 'HandsFreeOS <hello@handsfreeos.local>',
    ),
    log: pino({ level: 'warn' }),
    handlers,
    webUrl: (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    workerId: `seed:${hostname()}:${process.pid}`,
    batchSize: 50,
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
  await drainOutbox(deps);

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
  await drainOutbox(deps);

  step('Northstar Electric: a separate organization that sees none of the above');
  await executeCommand(
    api.db,
    organizationCreate,
    { businessName: 'Northstar Electric', timezone: 'America/Los_Angeles' },
    actor(riley),
    meta(),
  );

  console.log(`
Seeded in ${((Date.now() - started) / 1000).toFixed(1)}s. Sign in at ${deps.webUrl}/sign-in with password ${SEED_PASSWORD}:

  ${chris.email.padEnd(30)} Owner of Go Biz Help (agency); reaches every client workspace
  ${dale.email.padEnd(30)} Owner, Lone Star HVAC & Roofing
  ${priya.email.padEnd(30)} Admin, Lone Star HVAC & Roofing
  ${marco.email.padEnd(30)} Member, Lone Star HVAC & Roofing
  ${renee.email.padEnd(30)} Owner, Bayou Plumbing Co.
  ${tom.email.padEnd(30)} Owner, Summit Roofing
  ${riley.email.padEnd(30)} Owner of Northstar Electric (separate organization)

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
