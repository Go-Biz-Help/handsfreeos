/**
 * Social Outreach: a step for someone skipped or moved on today's Plan (docs/outreach.md, decision 195, step 3). On
 * any network, whoever plans the runner's go: the person is left off the list the extension is given till they're
 * due again, while the web, the phone and the Assistant still see the whole list. The plan lists what was skipped or
 * moved, to put back. Putting a step first needs HandsFreeOS to decide the order there.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS, businessDay } from '../../src/addons/outreach/automation';
import { PLAN_CHANGE_UI } from '../../src/addons/outreach/plan-changes';
import { itemKey } from '../../src/addons/outreach/plan-rules';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { zonedParts } from '../../src/calendar/engine/zoned';
import {
  checkedAs,
  computerOn,
  outreachBusiness,
  refused,
  runAs,
  runWith,
} from './outreach-fixture';

const admin = () => testDbs().admin.db;
const MIN = 60_000;

/** Chicago, or Tokyo when it's within 3 hours of midnight there: the run stays on the business's today. */
const zone = (() => {
  const { hour } = zonedParts(Date.now(), 'America/Chicago');
  return hour >= 3 && hour < 21 ? 'America/Chicago' : 'Asia/Tokyo';
})();

afterAll(closeTestDbs);

describe('a step for someone, skipped or moved on today’s plan', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  let key: string;

  interface Item {
    kind: string;
    name: string;
    profileId: string | null;
    postId: string | null;
    retry?: { at: string };
  }
  /** Today's list as the extension is given it, and as the web is. */
  const forExtension = async (u = owner) =>
    ((await runAs(u, ws, 'outreach.today', {})).items as Item[]).map((i) => i.name);
  const forWeb = async (u = owner) =>
    ((await runWith(u, ws, 'outreach.today', {}, { channel: 'web' })).items as Item[]).map(
      (i) => i.name,
    );
  const plan = (u = owner) =>
    runWith(u, ws, 'outreach.plan', {}, { channel: 'web' }) as Promise<{
      coming: {
        who: string | null;
        key: string | null;
        can: string[];
        changed: string | null;
      }[];
      changes: { key: string; change: string; at: string | null; title: string }[];
    }>;
  const change = (what: 'now' | 'skip' | 'at' | 'back', time?: string, u = owner, k = key) =>
    runWith(
      u,
      ws,
      'outreach.plan.change',
      { key: k, change: what, ...(time ? { time } : {}) },
      { channel: 'web' },
    );
  /** The business's clock some minutes from now, as 15:30. */
  const clock = (minutes: number) => {
    const { hour, minute } = zonedParts(Date.now() + minutes * MIN, zone);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  beforeAll(async () => {
    owner = await createTestUser('outpc-owner', { fullName: 'Pat Owner' });
    riley = await createTestUser('outpc-riley', { fullName: 'Riley Member' });
    ws = await outreachBusiness(owner, 'Plan Changes Co', { timezone: zone });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    const playbookId = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: 'CRM demos',
        template: 'crm_demos',
        details: PLAYBOOK_TEMPLATES.crm_demos.details,
      })
    ).id as string;
    // Every hour of every day: the day is going whenever this runs.
    for (const u of [owner, riley])
      await runAs(u, ws, 'outreach.automation.save', {
        settings: {
          ...AUTOMATION_DEFAULTS,
          sending: 'steps',
          hours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] },
        },
      });
    // Someone who follows the owner, and a good fit: a like for them is on today's list.
    await runAs(owner, ws, 'outreach.followers.save', {
      people: [
        {
          profile: {
            id: null,
            username: 'dana.reyes.31',
            url: 'https://www.facebook.com/dana.reyes.31',
          },
          name: 'Dana Reyes',
        },
      ],
      done: true,
    });
    const [dana] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles
          where workspace_id = ${ws} and username = 'dana.reyes.31'`,
    );
    await checkedAs(owner, ws, dana!.id, {
      fit: 'good',
      why: ['Owns a roofing business'],
      playbookId,
    });
    // The owner's computer, on a build that says where its day is up to.
    const computer = await computerOn(owner, ws, '0.160.0');
    const items = (await runAs(owner, ws, 'outreach.today', {})).items as Item[];
    const item = items.find((i) => i.name === 'Dana Reyes')!;
    key = `work:${itemKey(item as Parameters<typeof itemKey>[0])}`;
    await runWith(
      owner,
      ws,
      'outreach.plan.note',
      {
        platform: 'facebook',
        computer,
        state: { day: businessDay(Date.now(), zone), started: false, stopped: null, tried: [] },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
  }, 90_000);

  it('offers their row Skip today and Move to a time, and no Do now while the runner sets its own order', async () => {
    const row = (await plan()).coming.find((r) => r.who === 'Dana Reyes');
    expect(row).toMatchObject({ key, can: ['skip', 'at'], changed: null });
    expect(await refused(change('now'))).toBe('outreach_plan_order_not_here');
    expect((await plan()).changes).toEqual([]);
  });

  it('leaves them off the list the extension is given once skipped, and on everyone else’s', async () => {
    expect(await forExtension()).toContain('Dana Reyes');
    expect(await change('skip')).toMatchObject({
      key,
      change: 'skip',
      at: null,
      words: PLAN_CHANGE_UI.done.skip,
    });
    expect(await forExtension()).not.toContain('Dana Reyes');
    expect(await forWeb()).toContain('Dana Reyes');
    const shown = await plan();
    expect(shown.coming.map((r) => r.who)).not.toContain('Dana Reyes');
    expect(shown.changes).toEqual([
      { key, change: 'skip', at: null, title: expect.stringContaining('Dana Reyes') },
    ]);
  });

  it('puts them back', async () => {
    expect(await change('back')).toMatchObject({ change: 'back', words: PLAN_CHANGE_UI.done.back });
    expect(await forExtension()).toContain('Dana Reyes');
    const shown = await plan();
    expect(shown.changes).toEqual([]);
    expect(shown.coming.map((r) => r.who)).toContain('Dana Reyes');
  });

  it('holds them till the time they were moved to, and says so on their row from then on', async () => {
    const moved = await change('at', clock(30));
    expect(moved).toMatchObject({ change: 'at' });
    expect(moved.words).toMatch(/^Moved to about \d{1,2}:\d{2} [AP]M\.$/);
    expect(await forExtension()).not.toContain('Dana Reyes');
    expect((await plan()).changes).toEqual([
      { key, change: 'at', at: moved.at, title: expect.stringContaining('Dana Reyes') },
    ]);
    // The time comes.
    await rows(
      admin(),
      sql`update addon_outreach.plan_changes set at = now() - interval '1 minute'
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    expect(await forExtension()).toContain('Dana Reyes');
    const shown = await plan();
    expect(shown.changes).toEqual([]);
    expect(shown.coming.find((r) => r.who === 'Dana Reyes')).toMatchObject({ changed: 'at' });
    await change('back');
  });

  it('refuses a time that has passed, and a row that isn’t theirs', async () => {
    expect(await refused(change('at', clock(-5)))).toBe('outreach_plan_time_past');
    // The owner's list is their own: a teammate has no such row, and sees none of the owner's changes.
    expect(await refused(change('skip', undefined, riley))).toBe('outreach_plan_row_gone');
    await change('skip');
    expect((await plan(riley)).changes).toEqual([]);
    expect(await forExtension(riley)).not.toContain('Dana Reyes');
    await change('back');
    expect(
      await rows(
        admin(),
        sql`select id from addon_outreach.plan_changes where workspace_id = ${ws}`,
      ),
    ).toEqual([]);
  });
});
