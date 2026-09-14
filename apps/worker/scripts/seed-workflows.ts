/**
 * Milestone 6 demo data, part two: workflows, built through the commands and run by the real engine.
 * - Go Biz Help (chris, the agency's owner) starts the template "Missed-call text back (home services)" from
 *   scratch in the agency area with the built-in recipe's steps, publishes it and pushes version 1 to Bayou
 *   Plumbing Co. Version 2 answers questions from each business's knowledge base, with an OK before the text
 *   goes, and is pushed to Lone Star. Bayou stays on version 1, so it sees "Update available". A knowledge pack,
 *   "HVAC FAQs", reaches Bayou as suggestions.
 * - Lone Star: its website and Google review link in Settings. "Speed to lead" from the recipe with one change
 *   of Dale's (after the first five minutes the lead moves to Contacted), and its copy of the template renamed
 *   "Missed-call text back": each tested with Simulate and published. "Appointment follow-up + review" from
 *   the recipe, for the AC tune-up calendar, stays a draft.
 * - Runs, started by real triggers, with their jobs run as of when they were due:
 *   - Linda Okafor's missed call gets a text back; she asks for a visit and gets the booking link (finished).
 *   - Tina Morales's missed call gets a text back; she asks about financing, and the AI-written answer waits for
 *     an OK (her question joins Dale's Try it question as one gap).
 *   - Sam Patel agreed to texts; his new lead gets a text right away and waits five minutes for a reply.
 *   - Denise Walker's lead gets its first message; Priya archives the lead by mistake, and five minutes later the
 *     run stops at "Move the lead to Contacted" (failed, with Retry once the lead is restored).
 *   Texts never go out in quiet hours, so when the seed runs during Lone Star's, their texting hours open while
 *   the runs are made and close again after (two changes in Settings → Texting & calls).
 */
import { randomUUID } from 'node:crypto';
import {
  blankDefinition,
  callRecord,
  callUpdateStatus,
  diffWorkflows,
  executeCommand,
  knowledgePackCreate,
  knowledgePackPush,
  leadArchive,
  leadCreate,
  messageReceive,
  personSetSmsConsent,
  phoneUpdateSettings,
  quietHoursState,
  recipeDefinition,
  workflowCreate,
  workflowPublish,
  workflowRename,
  workflowSaveDraft,
  workflowTemplateCreate,
  workflowTemplatePublish,
  workflowTemplatePush,
  workflowTemplateSaveDraft,
  workflowTest,
  workspaceUpdate,
  type CommandDef,
  type HumanActor,
  type QuietHoursWindow,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { processJobs } from '../src/jobs';
import type { OutboxDeps } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { systemActor, workerMeta } from '../src/services';
import { runJobKey, type AiStepRunner } from '../src/workflows/index';
import { LONE_STAR_WEBSITE } from './seed-knowledge';
import { LONE_STAR_NUMBER, settle } from './seed-messaging';

export interface SeedWorkflowsDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services with the seed's stand-in model and the AI step runner on it. */
  readonly worker: OutboxDeps & { readonly workflowAi: AiStepRunner };
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeedWorkflowsOrg {
  readonly organizationId: string;
  readonly chris: TestUser;
  readonly lonestar: {
    readonly id: string;
    readonly dale: TestUser;
    readonly priya: TestUser;
    readonly marco: TestUser;
  };
  readonly bayou: { readonly id: string; readonly owner: TestUser };
}

export interface SeededWorkflows {
  readonly template: string;
  readonly templateVersion: number;
  readonly bayouVersion: number;
  readonly packItems: number;
  readonly seconds: number;
}

export const TEMPLATE_NAME = 'Missed-call text back (home services)';
/** A stand-in Google Business Profile review link. */
export const LONE_STAR_REVIEW_LINK = 'https://g.page/r/lone-star-hvac-roofing/review';

const LINDA_PHONE = '+18325550177';
const TINA_PHONE = '+17135550176';

/** Version 2 of the template: questions get an answer from the knowledge base, checked before it goes. */
const ANSWER_STEPS = [
  {
    id: 's_mctansw1',
    type: 'ai',
    task: 'write',
    prompt:
      "Answer the customer's question from what you know about the business, in one or two short sentences. If something isn't covered, say someone from the office will follow up.",
    fallback: 'Thanks for your question! Someone from our office will get back to you shortly.',
  },
  {
    id: 's_mctappr1',
    type: 'approval',
    message: 'Check this answer before it goes to the customer.',
    previewStepId: 's_mctansw1',
  },
  {
    id: 's_mctansr1',
    type: 'action',
    action: 'send_text',
    config: { body: '{{ai.message}}', bookingCalendarId: null },
  },
] as const;

const PACK_ITEMS = [
  {
    kind: 'faq',
    title: 'How often should I change my air filter?',
    body: 'Every one to three months. Homes with pets or allergies should change it every month.',
    tags: ['hvac'],
  },
  {
    kind: 'faq',
    title: 'Why is my AC running but not cooling?',
    body: 'A dirty filter, a frozen coil or low refrigerant are the usual causes. Turn the system off and call a technician if it keeps happening.',
    tags: ['hvac'],
  },
  {
    kind: 'faq',
    title: 'What should I set my thermostat to in summer?',
    body: '78 degrees while you are home, and higher while you are away, saves the most without losing comfort.',
    tags: ['hvac'],
  },
  {
    kind: 'faq',
    title: 'How long does an air conditioner last?',
    body: 'Most systems last 12 to 15 years with a tune-up every year.',
    tags: ['hvac'],
  },
  {
    kind: 'faq',
    title: 'Is it normal for the furnace to smell when it first turns on?',
    body: 'A light burning smell for the first few minutes of the season is dust burning off. A gas smell is not normal: leave the house and call the gas company.',
    tags: ['hvac', 'safety'],
  },
  {
    kind: 'fact',
    title: 'Refrigerant',
    body: 'New systems use R-454B or R-32 refrigerant. R-22 is no longer made, so older systems cost more to recharge.',
    tags: ['hvac'],
  },
] as const;

export async function seedWorkflows(
  d: SeedWorkflowsDeps,
  org: SeedWorkflowsOrg,
): Promise<SeededWorkflows> {
  const started = Date.now();
  const { organizationId, lonestar: ls, bayou } = org;
  const as = <I extends z.ZodType, O extends z.ZodType>(
    u: TestUser,
    command: CommandDef<I, O>,
    input: z.input<I>,
  ) => executeCommand(d.api, command, input, d.actor(u), d.meta()).then((r) => r.output);
  const system = <I extends z.ZodType, O extends z.ZodType>(
    command: CommandDef<I, O>,
    input: z.input<I>,
  ) =>
    executeCommand(
      d.worker.db,
      command,
      input,
      systemActor({ workspaceId: ls.id, organizationId }),
      workerMeta(),
    ).then((r) => r.output);
  const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await rows<T>(d.admin, query))[0];

  const person = async (email: string) => {
    const p = await one<{ id: string }>(
      sql`select id from app.people where workspace_id = ${ls.id} and lower(email) = ${email}`,
    );
    if (!p) throw new Error(`The CRM seed has no customer ${email}.`);
    return p.id;
  };
  const calendar = await one<{ id: string }>(
    sql`select id from app.calendars where workspace_id = ${ls.id} and name = 'AC tune-up'`,
  );
  const contacted = await one<{ pipeline_id: string; id: string }>(
    sql`select pipeline_id, id from app.pipeline_stages
        where workspace_id = ${ls.id} and name = 'Contacted' order by position limit 1`,
  );
  if (!calendar || !contacted)
    throw new Error('The calendar and CRM seeds should have made AC tune-up and Contacted.');

  /** Runs the named jobs now, as of the moment each was due, then what they queued. */
  async function runAsDue(dedupeKey: string): Promise<void> {
    const moved = await rows<{ id: string; due_at: Date | string }>(
      d.admin,
      sql`with picked as (
            select id, run_at from app.scheduled_jobs
            where status = 'pending' and dedupe_key = ${dedupeKey} for update)
          update app.scheduled_jobs j set run_at = now(), locked_at = now(), locked_by = ${d.worker.workerId}
          from picked where j.id = picked.id
          returning j.id, picked.run_at as due_at`,
    );
    if (!moved.length) throw new Error(`No pending job ${dedupeKey} to run.`);
    const dueAt = new Map(moved.map((m) => [m.id, new Date(m.due_at).getTime()]));
    const ran = await processJobs({
      ...d.worker,
      jobs,
      clock: (job) => dueAt.get(job.id) ?? Date.now(),
    });
    if (ran.retried + ran.failed > 0)
      throw new Error(`Running ${dedupeKey} failed (see last_error in app.scheduled_jobs).`);
    await settle(d);
  }

  /** A Simulate test of the draft as it is, then Publish once it passes. */
  async function testAndPublish(workflowId: string): Promise<void> {
    const { revision, eventId } = await as(ls.dale, workflowTest, {
      workspaceId: ls.id,
      workflowId,
      mode: 'simulate' as const,
    });
    const test = () =>
      one<{ status: string; end_reason: string | null; passed: boolean }>(
        sql`select r.status::text as status, r.end_reason, w.tested_revision = w.revision as passed
            from app.workflow_runs r join app.workflows w on w.id = r.workflow_id
            where r.trigger_event_id = ${eventId}`,
      );
    await settle(d, async () => {
      const t = await test();
      return !!t && (t.passed || ['stopped', 'failed'].includes(t.status));
    });
    const t = await test();
    if (!t?.passed)
      throw new Error(
        `The test of workflow ${workflowId} didn't pass: ${t ? `${t.status} (${t.end_reason ?? ''})` : 'no run'}.`,
      );
    await as(ls.dale, workflowPublish, { workspaceId: ls.id, workflowId, baseRevision: revision });
    await settle(d);
  }

  const runOf = (workflowId: string, personId: string) =>
    one<{ id: string; status: string; end_reason: string | null }>(
      sql`select id, status::text as status, end_reason from app.workflow_runs
          where workflow_id = ${workflowId} and person_id = ${personId} and not is_test
          order by created_at desc limit 1`,
    );
  async function expectRun(label: string, workflowId: string, personId: string, status: string) {
    const r = await runOf(workflowId, personId);
    if (r?.status !== status)
      throw new Error(
        `${label}: the run should be ${status}, but it is ${r ? `${r.status} (${r.end_reason ?? ''})` : 'missing'}.`,
      );
    return r;
  }

  d.step('Lone Star: the website and Google review link that workflows put in texts (Settings)');
  await as(ls.dale, workspaceUpdate, {
    workspaceId: ls.id,
    settings: { website: LONE_STAR_WEBSITE, links: { review: LONE_STAR_REVIEW_LINK } },
  });

  d.step(`Go Biz Help: the template "${TEMPLATE_NAME}", version 1 pushed to Bayou Plumbing Co.`);
  const recipe = recipeDefinition('missed_call_text_back');
  const { templateId } = await as(org.chris, workflowTemplateCreate, {
    organizationId,
    name: TEMPLATE_NAME,
    description:
      'Text back every missed call right away, then let AI sort the reply: an emergency, a booking, a question or anything else.',
    trigger: recipe.trigger,
  });
  const revision = (
    await as(org.chris, workflowTemplateSaveDraft, {
      organizationId,
      templateId,
      baseRevision: 1,
      ops: diffWorkflows(blankDefinition(recipe.trigger), recipe) as never,
    })
  ).revision;
  await as(org.chris, workflowTemplatePublish, { organizationId, templateId });
  await as(org.chris, workflowTemplatePush, {
    organizationId,
    templateId,
    workspaceIds: [bayou.id],
    // Bayou has no calendar yet: its copy asks for one.
    mappings: { [bayou.id]: { on_call_user: bayou.owner.id, office_user: bayou.owner.id } },
  });
  await settle(d);

  d.step(
    'Go Biz Help: version 2 answers questions from the knowledge base, with an OK first; pushed to Lone Star',
  );
  await as(org.chris, workflowTemplateSaveDraft, {
    organizationId,
    templateId,
    baseRevision: revision,
    ops: ANSWER_STEPS.map((step, i) => ({
      op: 'add_step' as const,
      parentId: 's_mctsort1',
      branchId: 'b_mctquest',
      index: i + 1,
      step,
    })) as never,
  });
  const v2 = await as(org.chris, workflowTemplatePublish, { organizationId, templateId });
  await as(org.chris, workflowTemplatePush, {
    organizationId,
    templateId,
    workspaceIds: [ls.id],
    mappings: {
      [ls.id]: {
        on_call_user: ls.marco.id,
        office_user: ls.priya.id,
        booking_calendar: calendar.id,
      },
    },
  });
  await settle(d);
  const install = async (workspaceId: string) =>
    one<{ workflow_id: string | null; installed_version: number | null; status: string }>(
      sql`select workflow_id, installed_version, status::text as status from app.workflow_template_installs
          where template_id = ${templateId} and workspace_id = ${workspaceId}`,
    );
  const [lsInstall, bayouInstall] = [await install(ls.id), await install(bayou.id)];
  if (!lsInstall?.workflow_id || !bayouInstall?.workflow_id)
    throw new Error(
      `The template didn't install: Lone Star ${lsInstall?.status}, Bayou ${bayouInstall?.status}.`,
    );

  d.step('Go Biz Help: the knowledge pack "HVAC FAQs", pushed to Bayou as suggestions');
  const { packId } = await as(org.chris, knowledgePackCreate, {
    organizationId,
    name: 'HVAC FAQs',
    description: 'Starter answers any heating and cooling business can adapt.',
    items: PACK_ITEMS.map((item) => ({ ...item, tags: [...item.tags] })),
  });
  await as(org.chris, knowledgePackPush, { organizationId, packId, workspaceIds: [bayou.id] });
  await settle(d);

  d.step(
    'Lone Star: "Speed to lead" from the recipe; Dale adds "move the lead to Contacted"; tested, published',
  );
  const speed = (
    await as(ls.dale, workflowCreate, {
      workspaceId: ls.id,
      name: 'Speed to lead',
      from: 'recipe' as const,
      recipeKey: 'speed_to_lead' as const,
    })
  ).workflowId;
  await as(ls.dale, workflowSaveDraft, {
    workspaceId: ls.id,
    workflowId: speed,
    baseRevision: 1,
    ops: [
      {
        op: 'add_step' as const,
        parentId: null,
        branchId: null,
        // After the first text and its five-minute wait, before the call task.
        index: 2,
        step: {
          id: 's_stlmove1',
          type: 'action' as const,
          action: 'move_lead_stage' as const,
          config: { pipelineId: contacted.pipeline_id, stageId: contacted.id, lostReason: null },
        },
      },
    ],
  });
  await testAndPublish(speed);

  d.step(
    'Lone Star: its copy of the Go Biz Help template, renamed "Missed-call text back", tested, published',
  );
  const missed = lsInstall.workflow_id;
  await as(ls.dale, workflowRename, {
    workspaceId: ls.id,
    workflowId: missed,
    name: 'Missed-call text back',
  });
  await testAndPublish(missed);

  d.step(
    'Lone Star: "Appointment follow-up + review" for the AC tune-up calendar, left as a draft',
  );
  await as(ls.dale, workflowCreate, {
    workspaceId: ls.id,
    name: 'Appointment follow-up + review',
    from: 'recipe' as const,
    recipeKey: 'appointment_follow_up_review' as const,
    mapping: { calendar: calendar.id },
  });

  // Runs. Texts never go out in quiet hours: at night the seed opens texting hours for a moment.
  const settings = await one<{ timezone: string; quiet: QuietHoursWindow | null }>(
    sql`select timezone, settings -> 'telephony' -> 'quietHours' as quiet from app.workspaces where id = ${ls.id}`,
  );
  const window: QuietHoursWindow = settings?.quiet ?? {
    enabled: true,
    start: '20:00',
    end: '08:00',
  };
  const quiet = quietHoursState(window, settings?.timezone ?? 'America/Chicago');
  if (quiet.quiet) {
    d.step(
      `It's ${quiet.localTime} in Houston, in Lone Star's quiet hours: texting hours open while the runs are made`,
    );
    await as(ls.dale, phoneUpdateSettings, {
      workspaceId: ls.id,
      quietHours: { ...window, enabled: false },
    });
  }
  try {
    const missedCall = async (from: string) => {
      const providerSid = `CAseed${randomUUID().replace(/-/g, '')}`;
      const at = Date.now() - 3 * 60_000;
      await system(callRecord, {
        workspaceId: ls.id,
        providerSid,
        direction: 'inbound' as const,
        from,
        to: LONE_STAR_NUMBER,
        status: 'ringing' as const,
        startedAt: new Date(at).toISOString(),
      });
      await system(callUpdateStatus, {
        workspaceId: ls.id,
        providerSid,
        status: 'completed' as const,
        durationSeconds: 22,
        at: new Date(at + 22_000).toISOString(),
      });
      await settle(d);
    };
    const text = async (from: string, body: string) => {
      await system(messageReceive, {
        workspaceId: ls.id,
        provider: 'fake' as const,
        providerMessageId: `SMseed${randomUUID().replace(/-/g, '')}`,
        from,
        to: LONE_STAR_NUMBER,
        body,
        occurredAt: new Date().toISOString(),
      });
      await settle(d);
    };

    d.step(
      'Lone Star: Linda Okafor’s missed call gets a text back; she asks for a visit and gets the booking link',
    );
    const linda = await person('linda.okafor@example.com');
    await missedCall(LINDA_PHONE);
    await expectRun('Linda’s missed call', missed, linda, 'waiting');
    await text(
      LINDA_PHONE,
      'Can someone come look at the AC this week? It’s making a rattling noise.',
    );
    await expectRun('Linda’s missed call', missed, linda, 'completed');

    d.step(
      'Lone Star: Tina Morales asks about financing after a missed call; the AI’s answer waits for an OK',
    );
    const tina = await person('tmorales@example.com');
    await missedCall(TINA_PHONE);
    await text(
      TINA_PHONE,
      'Do you offer financing? Our AC is 15 years old and we’re thinking about replacing it.',
    );
    await expectRun('Tina’s question', missed, tina, 'awaiting_approval');

    d.step(
      'Lone Star: Sam Patel agreed to texts; his new lead gets one at once and waits five minutes',
    );
    const sam = await person('sam.patel@example.com');
    await as(ls.priya, personSetSmsConsent, {
      workspaceId: ls.id,
      personId: sam,
      consent: 'opted_in' as const,
    });
    await as(ls.priya, leadCreate, {
      workspaceId: ls.id,
      personId: sam,
      title: 'Heat pump estimate',
      valueCents: 1_250_000,
      assigneeUserId: ls.marco.id,
    });
    await settle(d);
    await expectRun('Sam’s new lead', speed, sam, 'waiting');

    d.step(
      'Lone Star: Priya archives Denise Walker’s new lead by mistake; its run stops at the move, with Retry',
    );
    const denise = await person('dwalker@example.com');
    const { leadId } = await as(ls.priya, leadCreate, {
      workspaceId: ls.id,
      personId: denise,
      title: 'Furnace tune-up',
      valueCents: 18_900,
      assigneeUserId: ls.priya.id,
    });
    await settle(d);
    const deniseRun = await expectRun('Denise’s new lead', speed, denise, 'waiting');
    await as(ls.priya, leadArchive, { workspaceId: ls.id, leadId });
    await runAsDue(runJobKey(deniseRun.id));
    await expectRun('Denise’s archived lead', speed, denise, 'failed');
  } finally {
    if (quiet.quiet) {
      await as(ls.dale, phoneUpdateSettings, { workspaceId: ls.id, quietHours: window });
      d.step('Lone Star: quiet hours back on');
    }
  }

  return {
    template: TEMPLATE_NAME,
    templateVersion: v2.version,
    bayouVersion: bayouInstall.installed_version ?? 1,
    packItems: PACK_ITEMS.length,
    seconds: (Date.now() - started) / 1000,
  };
}
