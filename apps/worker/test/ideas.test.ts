import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  ideaComment,
  ideaFollow,
  ideaMerge,
  ideaSetStatus,
  ideaShare,
  ideaVote,
  organizationCreate,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { handlers } from '../src/handlers/index';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

/**
 * Ideas (0102), the worker's half: the people following an idea hear when the team moves it, once each, and
 * whoever shared it hears when the team answers it. Nothing here belongs to a business: the events have no
 * tenant, and the worker tells people with none in scope.
 */
const env = testEnv();
const WORKER_ID = `vitest-ideas-${process.pid}`;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, actor(u), meta()).then((r) => r.output);

/** The database keeps rows between runs, so this run's ideas have titles only this run uses. */
const mark = randomUUID().slice(0, 8);
let s: TestServices;
let dale: TestUser;
let renee: TestUser;
let quiet: TestUser;
let lead: TestUser;
let daleWs: string;
let reneeWs: string;
const ideaIds: string[] = [];

/** Runs the outbox over this test's own ideas and nothing else: other suites' events are not ours to fail on. */
async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and event_type like 'platform.idea%'
            and event_id in (select e.id from app.events e
              where e.entity_id = any(${`{${ideaIds.join(',')}}`}::uuid[]))`,
    );
    const pass = await processOnce({
      ...s,
      workerId: WORKER_ID,
      batchSize: 200,
      reservedOnly: true,
      handlers,
    });
    if (pass.retried + pass.failed > 0) {
      const errors = await rows(
        admin(),
        sql`select event_type, last_error from app.outbox
            where locked_by = ${WORKER_ID} and last_error is not null`,
      );
      throw new Error(`idea work failed: ${JSON.stringify(errors)}`);
    }
    if (pass.claimed === 0) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

interface MailpitMessage {
  Subject: string;
  Text: string;
}
async function mailsTo(
  to: string,
  subjectPart: string,
): Promise<{ ID: string; Subject: string }[]> {
  const res = await fetch(
    `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  const found = (await res.json()) as { messages: { ID: string; Subject: string }[] };
  return found.messages.filter((m) => m.Subject.includes(subjectPart));
}
async function mailTo(to: string, subjectPart: string): Promise<MailpitMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [hit] = await mailsTo(to, subjectPart);
    if (hit)
      return (await (
        await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)
      ).json()) as MailpitMessage;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email about "${subjectPart}" reached ${to}`);
}

beforeAll(async () => {
  [dale, renee, quiet, lead] = await Promise.all([
    createTestUser('ideas-mail-dale', { fullName: 'Dale Ramsey' }),
    createTestUser('ideas-mail-renee', { fullName: 'Renee Broussard' }),
    createTestUser('ideas-mail-quiet', { fullName: 'Quinn Quiet' }),
    createTestUser('ideas-mail-lead', { fullName: 'Samantha Lead' }),
  ]);
  daleWs = (await run(organizationCreate, { businessName: 'Mail HVAC' }, dale)).workspaceId;
  reneeWs = (await run(organizationCreate, { businessName: 'Mail Plumbing' }, renee)).workspaceId;
  await run(organizationCreate, { businessName: 'Mail Quiet Co' }, quiet);
  await admin().execute(
    sql`insert into platform.staff (user_id, role, display_name) values (${lead.id}, 'lead', 'Sam')
        on conflict (user_id) do update set role = 'lead', status = 'active', display_name = 'Sam'`,
  );
  s = testServices();
});
afterAll(closeTestDbs);

describe('moving an idea along the roadmap', () => {
  let ideaId: string;
  const title = `Text the customer when the tech is on the way ${mark}`;

  it('emails everybody following it, once each, with what the team said', async () => {
    ({ ideaId } = await run(ideaShare, { workspaceId: daleWs, title, areaId: 'calendar' }, dale));
    ideaIds.push(ideaId);
    await run(ideaVote, { ideaId, workspaceId: reneeWs }, renee);
    await run(ideaVote, { ideaId }, quiet);
    await run(ideaFollow, { ideaId, following: false }, quiet);
    const { updateId } = await run(
      ideaSetStatus,
      { ideaId, status: 'planned', note: 'Building it with the new dispatch board.' },
      lead,
    );
    await drain();

    const toDale = await mailTo(dale.email, title);
    expect(toDale.Subject).toBe(`“${title}” is planned`);
    expect(toDale.Text).toContain('The idea you shared');
    expect(toDale.Text).toContain('Sam wrote: “Building it with the new dispatch board.”');
    expect(toDale.Text).toContain(`/app/ideas/${ideaId}`);
    const toRenee = await mailTo(renee.email, title);
    expect(toRenee.Text).toContain('An idea you follow');
    // Somebody who said "stop telling me" is not told, and neither is whoever made the change.
    expect(await mailsTo(quiet.email, title)).toEqual([]);
    expect(await mailsTo(lead.email, title)).toEqual([]);

    const told = await rows<{ user_id: string }>(
      admin(),
      sql`select user_id from platform.idea_update_deliveries where update_id = ${updateId}`,
    );
    expect(told.map((t) => t.user_id).sort()).toEqual([dale.id, renee.id].sort());
    const [update] = await rows<{ notified: boolean }>(
      admin(),
      sql`select notified_at is not null as notified from platform.idea_updates where id = ${updateId}`,
    );
    expect(update?.notified).toBe(true);
  });

  it('a retry tells nobody twice', async () => {
    await rows(
      admin(),
      sql`update app.outbox set status = 'pending', attempts = 0, next_attempt_at = now()
          where event_type = 'platform.idea_status_changed'
            and event_id in (select id from app.events where entity_id = ${ideaId})`,
    );
    await rows(
      admin(),
      sql`update platform.idea_updates set notified_at = null where idea_id = ${ideaId}`,
    );
    await drain();
    expect(await mailsTo(renee.email, title)).toHaveLength(1);
  });

  it('a move nobody is to hear about stays quiet', async () => {
    await run(ideaSetStatus, { ideaId, status: 'in_progress', notify: false }, lead);
    await drain();
    expect(await mailsTo(renee.email, `“${title}” is being built`)).toEqual([]);
  });
});

describe('the team answering an idea', () => {
  it('tells whoever shared it, once', async () => {
    const title = `Photos on estimates ${mark}`;
    const { ideaId } = await run(ideaShare, { workspaceId: daleWs, title, areaId: 'money' }, dale);
    ideaIds.push(ideaId);
    const { commentId } = await run(
      ideaComment,
      { ideaId, body: 'Would two photos per line be enough?' },
      lead,
    );
    // A customer's own comment is not the team's answer.
    await run(ideaComment, { ideaId, body: 'I would love this too.' }, renee);
    await drain();
    const answer = await mailTo(dale.email, 'answered your idea');
    expect(answer.Subject).toBe(`Sam from the HandsFreeOS team answered your idea “${title}”`);
    expect(answer.Text).toContain('Would two photos per line be enough?');
    const [comment] = await rows<{ told: boolean }>(
      admin(),
      sql`select author_told_at is not null as told from platform.idea_comments where id = ${commentId}`,
    );
    expect(comment?.told).toBe(true);
    expect(await mailsTo(dale.email, `answered your idea “${title}”`)).toHaveLength(1);
  });
});

describe('merging a duplicate', () => {
  it('tells the duplicate’s followers where it went', async () => {
    const original = await run(
      ideaShare,
      { workspaceId: daleWs, title: `Payroll export ${mark}`, areaId: 'money' },
      dale,
    );
    const duplicate = await run(
      ideaShare,
      { workspaceId: reneeWs, title: `Export hours to payroll ${mark}`, areaId: 'money' },
      renee,
    );
    ideaIds.push(original.ideaId, duplicate.ideaId);
    await run(ideaMerge, { ideaId: duplicate.ideaId, intoIdeaId: original.ideaId }, lead);
    await drain();
    const moved = await mailTo(renee.email, 'joined a matching idea');
    expect(moved.Text).toContain(`#${original.number}`);
    expect(moved.Text).toContain('The idea you shared');
  });
});
