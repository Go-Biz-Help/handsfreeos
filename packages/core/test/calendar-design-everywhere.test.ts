/**
 * Booking pages in design tools, part 3, on the local database: Use on all my calendars puts one calendar's saved
 * design on the others as a new revision each, and each person's photo stays with its own calendar and shows in
 * History.
 */
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  calendarGet,
  calendarRestoreRevision,
  calendarSave,
  calendarSetStatus,
  calendarUseDesignEverywhere,
} from '../src/server';
import {
  ask,
  expectHfos,
  makeCalendar,
  run,
  saveCalendar,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
beforeAll(async () => {
  t = await setupTeam('caldesign');
});
afterAll(closeTestDbs);

const PIC = (n: number) => ({
  path: `${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}/${n}${'2'.repeat(7)}-2222-4222-8222-${'2'.repeat(12)}.webp`,
  width: 1200,
  height: 800,
});
const get = (calendarId: string) => ask(calendarGet, { workspaceId: t.wsId, calendarId }, t.owner);

describe('Use on all my calendars', () => {
  it('puts the saved design on every other calendar not archived, each as a revision that Restore undoes', async () => {
    const team = { members: [{ userId: t.owner.id }, { userId: t.priya.id }] };
    const main = await makeCalendar(t, 'Estimates', { team });
    const other = await makeCalendar(t, 'Repairs', { team });
    const archived = await makeCalendar(t, 'Old', {});
    await run(
      calendarSetStatus,
      { workspaceId: t.wsId, calendarId: archived.id, status: 'archived' },
      t.owner,
    );
    const design = {
      scheme: 'dark' as const,
      spacing: 'roomy' as const,
      width: 'wide' as const,
      cover: PIC(3),
    };
    const saved = await saveCalendar(t, main.id, {
      design,
      team: { members: [{ userId: t.owner.id, picture: PIC(4) }, { userId: t.priya.id }] },
    });
    expect(saved.diff).toEqual(
      expect.arrayContaining(['Design: your brand kit → its own look', 'Added Dale Owner’s photo']),
    );

    const out = await run(
      calendarUseDesignEverywhere,
      { workspaceId: t.wsId, calendarId: main.id },
      t.owner,
    );
    expect(out.calendarIds).toContain(other.id);
    expect(out.calendarIds).not.toContain(main.id);
    expect(out.calendarIds).not.toContain(archived.id);

    const { calendar, revisions } = await get(other.id);
    expect(calendar.config.design).toMatchObject({ scheme: 'dark', width: 'wide', cover: PIC(3) });
    // The photo is the calendar's own team's, so it stays where it was put.
    expect(calendar.config.team.members.map((m) => m.picture)).toEqual([null, null]);
    expect(revisions[0]).toMatchObject({
      revision: other.revision + 1,
      diff: ['Took the design from “Estimates”'],
    });
    expect((await get(archived.id)).calendar.config.design).toBeNull();

    // Again: nothing left to change.
    const again = await run(
      calendarUseDesignEverywhere,
      { workspaceId: t.wsId, calendarId: main.id },
      t.owner,
    );
    expect(again.calendarIds).not.toContain(other.id);

    // History puts the old look back.
    await run(
      calendarRestoreRevision,
      {
        workspaceId: t.wsId,
        calendarId: other.id,
        revision: other.revision,
        baseRevision: other.revision + 1,
        impactDecisions: {},
      },
      t.owner,
    );
    expect((await get(other.id)).calendar.config.design).toBeNull();
  });

  it('is for whoever may change calendars', async () => {
    const cal = await makeCalendar(t, 'Members can’t', {});
    await expectHfos(
      () => run(calendarUseDesignEverywhere, { workspaceId: t.wsId, calendarId: cal.id }, t.member),
      'forbidden',
    );
  });

  it('refuses a photo that isn’t from Your pictures', async () => {
    const cal = await makeCalendar(t, 'Bad photo', { team: { members: [{ userId: t.owner.id }] } });
    const { calendar } = await get(cal.id);
    const member = calendar.config.team.members[0]!;
    // Sent as a client could, past the screen's own checks.
    const draft = {
      ...calendar.config,
      team: {
        ...calendar.config.team,
        members: [
          { ...member, picture: { path: 'https://evil.example/me.jpg', width: 1, height: 1 } },
        ],
      },
    };
    await expectHfos(
      () =>
        run(
          calendarSave,
          { workspaceId: t.wsId, calendarId: cal.id, baseRevision: calendar.revision, draft },
          t.owner,
        ),
      'validation',
    );
  });
});
