/**
 * The AI teammate and a calendar that takes a deposit (M9 step 10).
 *
 * A deposit is paid on the customer's own booking page, where their card is **held** rather than charged and
 * the time goes back if they never pay. A teammate booking on someone's behalf can do none of that — so it
 * books nothing at all, says what the visit takes, and sends them the page. The guard sits beside the one that
 * keeps it to the calendars its settings list, so a model naming a calendar it shouldn't gets the same answer.
 */
import { randomUUID } from 'node:crypto';
import {
  appointmentBookForCustomer,
  attendeeRescheduleForCustomer,
  calendarGet,
  calendarSave,
  executeCommandIn,
  executeQuery,
  HfosError,
  serviceCreate,
  type AiEmployeeActor,
  type CalendarConfig,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  drain,
  makeCalendar,
  newCustomer,
  run,
  saveTeammate,
  scopeOf,
  teammateWorld,
  textIn,
  type TeammateWorld,
} from './ai-team-world';
import { at } from './booking-world';
import { connect, patchMoneySettings, type MoneyWorld } from './money-world';

const PRICE = 40_000;
let w: TeammateWorld;

const aiActor = (world: TeammateWorld, conversationId: string): AiEmployeeActor => ({
  type: 'ai_employee',
  workspaceId: world.workspaceId,
  organizationId: world.organizationId,
  teammateId: world.teammateId,
  teammateName: 'Ava',
  runId: null,
  conversationId,
  approvedBy: null,
  origin: null,
  test: false,
});

/** As the teammate itself, through the worker's own connection — the way its run executes a held action. */
const asAi = (world: TeammateWorld, conversationId: string, cmd: never, input: unknown) =>
  asWorker(testDbs().worker.db, scopeOf(world), (tx) =>
    executeCommandIn(tx, cmd, input, aiActor(world, conversationId), {
      correlationId: randomUUID(),
      channel: 'test' as const,
    }),
  );

/** The teammate is the one answering this conversation, which is what lets it act in it. */
async function aiHandles(world: TeammateWorld, conversationId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.conversations set handled_by = 'ai', ai_teammate_id = ${world.teammateId}
        where id = ${conversationId}`,
  );
}

/** Turns payment on for a calendar, with a priced service to be a percentage of. */
async function takesADeposit(world: TeammateWorld, calendarId: string): Promise<void> {
  const service = await run(world, serviceCreate, {
    workspaceId: world.workspaceId,
    name: `Priced ${randomUUID().slice(0, 6)}`,
    durations: [60],
    priceCents: PRICE,
  });
  const { calendar } = await executeQuery(
    testDbs().api.db,
    calendarGet,
    { workspaceId: world.workspaceId, calendarId },
    {
      type: 'human' as const,
      userId: world.owner.id,
      email: world.owner.email,
      claims: world.owner.claims,
    },
    { correlationId: randomUUID(), channel: 'test' as const },
  );
  const draft = calendar.config as CalendarConfig;
  await run(world, calendarSave, {
    workspaceId: world.workspaceId,
    calendarId,
    baseRevision: calendar.revision,
    draft: {
      ...draft,
      services: {
        ...draft.services,
        mode: 'one',
        items: [{ serviceId: (service as { serviceId: string }).serviceId }],
      },
      payments: { ...draft.payments, mode: 'deposit' },
    },
  });
}

beforeAll(async () => {
  w = await teammateWorld('ai-deposit', {
    preset: 'appointment_coordinator',
    calendar: 'Duct cleaning',
    status: 'automatic',
  });
  await saveTeammate(w, { book: { enabled: true, calendarIds: [w.calendar!.id] } });
  const money = w as unknown as MoneyWorld;
  await connect(money, 'stripe', `acct_${randomUUID().slice(0, 8)}`);
  await patchMoneySettings(money, { deposit: { kind: 'percent', percentBp: 2_500 } });
  await takesADeposit(w, w.calendar!.id);
  await drain(w);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
});

describe('a calendar that takes a deposit', () => {
  it('is never the teammate’s to book: it says what the visit takes and sends the page', async () => {
    const customer = await newCustomer(w, 'Nadia');
    const m = await textIn(w, customer.phone, 'Can you book me in for Thursday?');
    const failed = await asAi(w, m.conversationId, appointmentBookForCustomer as never, {
      workspaceId: w.workspaceId,
      calendarId: w.calendar!.id,
      startsAt: new Date(at(3, '09:00')).toISOString(),
      clientId: randomUUID(),
    }).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(HfosError);
    const err = failed as HfosError;
    expect(err.rule).toBe('deposit_required');
    // The words are the model's to repeat: what it takes, and where to pay it.
    expect(err.message).toContain('$100');
    expect(err.message).toContain('as a deposit');
    expect(err.message).toContain('booking page');
    expect(err.message).toContain(`/book/${w.site}/`);
    expect((err.details as { amountCents: number }).amountCents).toBe(PRICE / 4);

    // Nothing was booked, and nothing was said to the customer by this.
    const booked = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.appointment_attendees a
          where a.workspace_id = ${w.workspaceId} and a.person_id = ${customer.id}`,
    );
    expect(booked[0]!.n).toBe(0);
  });

  it('stops moving a booking the day its calendar starts asking for one', async () => {
    // A second calendar, free to book, so the teammate really books on it first.
    const free = await makeCalendar(w, 'Filter change');
    await saveTeammate(w, {
      book: { enabled: true, calendarIds: [w.calendar!.id, free.id] },
    });
    const customer = await newCustomer(w, 'Omar');
    const m = await textIn(w, customer.phone, 'Book me in please');
    await aiHandles(w, m.conversationId);
    const booked = await asAi(w, m.conversationId, appointmentBookForCustomer as never, {
      workspaceId: w.workspaceId,
      calendarId: free.id,
      startsAt: new Date(at(4, '09:00')).toISOString(),
      clientId: randomUUID(),
    });
    const appointmentId = (booked as { output: { appointmentId: string } }).output.appointmentId;
    await drain(w);

    // The business turns a deposit on for it. Moving a visit onto it is a booking like any other.
    await takesADeposit(w, free.id);
    const failed = await asAi(w, m.conversationId, attendeeRescheduleForCustomer as never, {
      workspaceId: w.workspaceId,
      appointmentId,
      startsAt: new Date(at(5, '09:00')).toISOString(),
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(HfosError);
    expect((failed as HfosError).rule).toBe('deposit_required');
  });
});
