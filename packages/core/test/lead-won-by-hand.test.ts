/**
 * A deal a person marks won or lost themselves (`lead.wait_for_outcome`, 20261027015700): Automations' "Move deals
 * along for you" takes a done visit for a win, but not on such a deal. Social Outreach's leads from a demo ask for it.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { dealFacts } from '../src/automations/pipeline-load';
import { appointmentSetStatus, leadCreate, leadWaitForOutcome } from '../src/server';
import {
  admin,
  bookOnline,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
} from './calendar-helpers';

afterAll(closeTestDbs);

describe('a deal a person marks won or lost themselves', () => {
  it('isn’t won by its done visit', async () => {
    const t = await setupTeam('won-by-hand');
    const demos = await makeCalendar(t, 'Demos', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    const booked = await bookOnline(t, demos.id, isoAt(nextWeekday(2), '10:00'));
    const [had] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.leads where person_id = ${booked.personId} and status = 'open'`,
    );
    const leadId =
      had?.id ??
      (
        await run(
          leadCreate,
          { workspaceId: t.wsId, title: 'Online Guest', personId: booked.personId },
          t.owner,
        )
      ).leadId;
    await run(
      appointmentSetStatus,
      { workspaceId: t.wsId, appointmentId: booked.appointmentId, status: 'completed' },
      t.owner,
    );
    const steps = async () =>
      (
        await admin().transaction((tx) => dealFacts(tx, t.wsId, { leadIds: [leadId] }))
      )[0]!.evidence.map((e) => e.step);
    expect(await steps()).toContain('won');

    expect(await runSystem(leadWaitForOutcome, { workspaceId: t.wsId, leadId }, t.scope)).toEqual({
      leadId,
      waits: true,
    });
    expect(await steps()).not.toContain('won');
  });
});
