/**
 * Autopilot's day's list (../autopilot.ts, docs/outreach.md decision 149): who it plans to reach that the person hasn't
 * OK'd yet, made once a day, and their answers.
 *
 * - `outreach.autopilot.plan`: the worker makes the day's list an hour before the person's working hours, and as they
 *   turn Autopilot on: each network they work, as Today works it out without the hold and with a few spares past each
 *   limit (./today.ts `todayFor`). Once a day: made already today, it's left as it is.
 * - `outreach.autopilot`: today's list, for Needs you on the web and the phone.
 * - `outreach.autopilot.answer`: OK (everyone still waiting, or those named), Not today, or Put back.
 *
 * Today's list holds back anyone not OK'd while Autopilot is on (./today.ts `reach`), and a message drafted for one
 * waits (./sends.ts).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { businessDay } from '../automation';
import {
  AutopilotAnswerInput,
  AutopilotAnswerOutput,
  autopilotDayDue,
  AutopilotInput,
  AutopilotOutput,
  AutopilotPlanInput,
  AutopilotPlanOutput,
  autopilotStepOf,
  nextAutopilotList,
  waitsForPeopleOk,
  type AutopilotPerson,
} from '../autopilot';
import { DAILY_STEPS, type DailyStep } from '../limits';
import { outreachAddon } from '../manifest';
import { networksShown } from '../network-words';
import { automation, autopilotPeople } from '../tables';
import type { TodayKind } from '../today';
import type { Platform } from '../networks';
import { automationOf } from './automation';
import { inWorkspace, type Ctx } from './common';
import { todayFor } from './today';

/** How many on a day's list still wait for the OK. */
async function waitingOn(ctx: Ctx, me: string, day: string): Promise<number> {
  const [n] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_outreach.autopilot_people
        where workspace_id = ${ctx.scope.workspaceId!} and user_id = ${me} and day = ${day}::date
          and state = 'waiting'`,
  );
  return n?.n ?? 0;
}

/** The business's day at `now`, and its time zone. */
async function dayOf(ctx: Ctx, now: number) {
  const timeZone = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
  return { timeZone, day: businessDay(now, timeZone) };
}

export const autopilotPlan = defineAddonCommand(outreachAddon, {
  name: 'outreach.autopilot.plan',
  description:
    'Make today’s Autopilot list for the person: everyone it plans to reach today on the networks they work whom they haven’t OK’d yet, with a few spares past each daily limit. Once a day: made already today, it stays as it is, and anyone found later waits for tomorrow’s.',
  risk: 0,
  input: AutopilotPlanInput,
  output: AutopilotPlanOutput,
  permission: 'outreach.use',
  // The worker makes it, on the person's behalf, an hour before their hours and as they turn Autopilot on
  // (apps/worker/src/addons/outreach/autopilot.ts).
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.autopilot.listed'],
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has an Autopilot list.');
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { settings, rules } = await automationOf(ctx, me, now);
    if (!settings.autopilot) return { day: null, made: false, waiting: 0 };
    const { day } = await dayOf(ctx, now);
    // Their settings row, held while the list is made: two at once make it once.
    const [row] = await ctx.tx
      .select({ id: automation.id, listedOn: automation.autopilotListedOn })
      .from(automation)
      .where(and(eq(automation.workspaceId, ws), eq(automation.userId, me)))
      .for('update');
    if (!row) return { day: null, made: false, waiting: 0 };
    if (row.listedOn === day) return { day, made: false, waiting: await waitingOn(ctx, me, day) };
    // Each network they work, as Today works it out without the hold: the first step it plans for each person, and
    // whether they're past the day's limit for it (answer 5a).
    const planned = new Map<
      string,
      { platform: Platform; kind: TodayKind; why: string[]; spare: boolean }
    >();
    for (const platform of networksShown(settings, rules.networksAllowed)) {
      const { list, most } = await todayFor(ctx, { workspaceId: input.workspaceId, platform }, true);
      const used = Object.fromEntries(DAILY_STEPS.map((s) => [s, 0])) as Record<DailyStep, number>;
      for (const i of [...list.items, ...(list.partners ?? [])]) {
        const step = autopilotStepOf(i.kind);
        if (step) used[step] += 1;
        if (!i.profileId || !waitsForPeopleOk(i.kind) || planned.has(i.profileId)) continue;
        const left = step ? Math.max(0, most[step] - list.limits[step].done) : Infinity;
        planned.set(i.profileId, {
          platform,
          kind: i.kind,
          why: (i.why ?? []).slice(0, 3),
          spare: step !== null && used[step] > left,
        });
      }
    }
    const at = changeMoment(ctx.meta);
    // Anyone OK'd already isn't asked about again; whoever waited, or was left out another day, is on today's.
    const okd = planned.size
      ? await ctx.tx
          .select({ profileId: autopilotPeople.profileId })
          .from(autopilotPeople)
          .where(
            and(
              eq(autopilotPeople.workspaceId, ws),
              eq(autopilotPeople.userId, me),
              eq(autopilotPeople.state, 'ok'),
              inArray(autopilotPeople.profileId, [...planned.keys()]),
            ),
          )
      : [];
    for (const o of okd) planned.delete(o.profileId);
    if (planned.size)
      await ctx.tx
        .insert(autopilotPeople)
        .values(
          [...planned].map(([profileId, p]) => ({
            workspaceId: ws,
            userId: me,
            profileId,
            platform: p.platform,
            day,
            state: 'waiting' as const,
            kind: p.kind,
            why: p.why,
            spare: p.spare,
            createdAt: at,
            updatedAt: at,
          })),
        )
        .onConflictDoUpdate({
          target: [autopilotPeople.workspaceId, autopilotPeople.userId, autopilotPeople.profileId],
          set: {
            platform: sql`excluded.platform`,
            day: sql`excluded.day`,
            state: 'waiting',
            kind: sql`excluded.kind`,
            why: sql`excluded.why`,
            spare: sql`excluded.spare`,
            updatedAt: at,
          },
          setWhere: sql`${autopilotPeople.state} <> 'ok'`,
        });
    await ctx.tx
      .update(automation)
      .set({ autopilotListedOn: day })
      .where(eq(automation.id, row.id));
    const waiting = await waitingOn(ctx, me, day);
    await ctx.emit({
      type: 'outreach.autopilot.listed',
      entityType: 'outreach_automation',
      entityId: row.id,
      payload: { userId: me, day, waiting },
    });
    return { day, made: true, waiting };
  },
});

export const autopilotList = defineAddonQuery(outreachAddon, {
  name: 'outreach.autopilot',
  description:
    'Today’s Autopilot list for the person: the people it plans to reach today whom they haven’t OK’d, with what it plans for each and why, the spares last, and whether the list is made yet or when it comes.',
  input: AutopilotInput,
  output: AutopilotOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_autopilot_list',
    keywords: ['autopilot', 'people to ok', 'who it will reach today'],
  },
  scope: inWorkspace,
  async handler(ctx) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has an Autopilot list.');
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { settings, rules, saved } = await automationOf(ctx, me, now);
    const { day, timeZone } = await dayOf(ctx, now);
    const [row] = saved
      ? await ctx.tx
          .select({ listedOn: automation.autopilotListedOn })
          .from(automation)
          .where(and(eq(automation.workspaceId, ws), eq(automation.userId, me)))
      : [];
    const made = row?.listedOn === day;
    // Before it's made: when it comes today, or on the next day it works. Due now, it's being made.
    const comes =
      made || !settings.autopilot || autopilotDayDue(settings.hours, timeZone, now) === day
        ? null
        : nextAutopilotList(settings.hours, timeZone, now).getTime();
    const listed = made
      ? await rows<{
          profile_id: string;
          name: string;
          url: string;
          platform: Platform;
          kind: TodayKind;
          why: string[];
          spare: boolean;
          state: AutopilotPerson['state'];
          dont_pitch: boolean;
          never_contact: boolean;
          person_id: string | null;
        }>(
          ctx.tx,
          sql`select ap.profile_id, p.name, p.url, ap.platform, ap.kind, ap.why, ap.spare, ap.state,
                p.dont_pitch, p.never_contact, p.person_id
              from addon_outreach.autopilot_people ap
              join addon_outreach.profiles p on p.workspace_id = ap.workspace_id and p.id = ap.profile_id
              where ap.workspace_id = ${ws} and ap.user_id = ${me} and ap.day = ${day}::date
              order by ap.spare, ap.platform, ap.created_at, p.name`,
        )
      : [];
    const people = listed.map((p) => ({
      profileId: p.profile_id,
      name: p.name,
      url: p.url,
      platform: p.platform,
      kind: p.kind,
      why: p.why,
      spare: p.spare,
      state: p.state,
      dontPitch: p.dont_pitch,
      neverContact: p.never_contact,
      personId: p.person_id,
    }));
    return {
      on: settings.autopilot,
      allowed: rules.autopilotAllowed,
      day,
      timezone: timeZone,
      made,
      listAt: comes === null ? null : new Date(comes).toISOString(),
      people,
      waiting: people.filter((p) => p.state === 'waiting').length,
    };
  },
});

export const autopilotAnswer = defineAddonCommand(outreachAddon, {
  name: 'outreach.autopilot.answer',
  description:
    'The person answers today’s Autopilot list: OK everyone still waiting (or those named), so Autopilot reaches them and the steps after go without asking again; Not today for those named, who are on tomorrow’s list again; or Put back those left out today.',
  risk: 1,
  input: AutopilotAnswerInput,
  output: AutopilotAnswerOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_autopilot_answer',
    autonomy: 'confirm',
    keywords: ['ok the people', 'approve todays people', 'autopilot list'],
  },
  scope: inWorkspace,
  emits: ['outreach.autopilot.answered'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const { day } = await dayOf(ctx, Date.now());
    const named = input.profileIds?.length ? input.profileIds : null;
    if (!named && input.answer !== 'ok')
      throw HfosError.rule(
        'outreach_autopilot_who',
        422,
        input.answer === 'not_today'
          ? 'Pick who to leave out today, then press Not today again.'
          : 'Pick who to put back on today’s list, then press Put back again.',
      );
    const mine = and(eq(autopilotPeople.workspaceId, ws), eq(autopilotPeople.userId, me));
    const changed =
      input.answer === 'ok'
        ? await ctx.tx
            .update(autopilotPeople)
            .set({ state: 'ok', okdAt: at, updatedAt: at })
            .where(
              and(
                mine,
                named
                  ? and(
                      inArray(autopilotPeople.profileId, named),
                      sql`${autopilotPeople.state} <> 'ok'`,
                    )
                  : and(
                      eq(autopilotPeople.day, day),
                      eq(autopilotPeople.state, 'waiting'),
                    ),
              ),
            )
            .returning({ id: autopilotPeople.id })
        : input.answer === 'not_today'
          ? // Today's only: an OK given today can be taken back too, and they're on tomorrow's list again.
            await ctx.tx
              .update(autopilotPeople)
              .set({ state: 'not_today', okdAt: null, updatedAt: at })
              .where(
                and(
                  mine,
                  inArray(autopilotPeople.profileId, named!),
                  eq(autopilotPeople.day, day),
                  sql`${autopilotPeople.state} <> 'not_today'`,
                ),
              )
              .returning({ id: autopilotPeople.id })
          : await ctx.tx
              .update(autopilotPeople)
              .set({ state: 'waiting', updatedAt: at })
              .where(
                and(
                  mine,
                  inArray(autopilotPeople.profileId, named!),
                  eq(autopilotPeople.state, 'not_today'),
                ),
              )
              .returning({ id: autopilotPeople.id });
    if (changed.length)
      await ctx.emit({
        type: 'outreach.autopilot.answered',
        entityType: 'workspace',
        entityId: ws,
        payload: { userId: me, answer: input.answer, changed: changed.length },
      });
    return { changed: changed.length, waiting: await waitingOn(ctx, me, day) };
  },
});

export const autopilotCommands = [autopilotPlan, autopilotAnswer] as const;
export const autopilotQueries = [autopilotList] as const;
