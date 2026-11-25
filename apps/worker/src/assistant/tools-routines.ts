/**
 * What a person asks the Assistant to do on its own (the owner, 25 Nov 2026): a question on a schedule
 * (schedule_question), or an alert (set_alert). Changing, pausing and deleting one are the screens' own commands
 * (coverage.ts: do_assistant_routine_update, _delete). Every card says it in words — the question and when it's
 * asked, or what the alert watches for — never as ids or JSON.
 */
import {
  assistantRoutineDelete,
  assistantRoutineUpdate,
  cadenceWords,
  dayTime,
  defaultOnce,
  nextRoutineRun,
  RoutineCadence,
  RoutineWatch,
  watchWords,
  HfosError,
  type AssistantRoutineOut,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';
import type { ScreenActionCard } from './tools-workflow';

const settingsHref = (ctx: ToolContext) => `/app/w/${ctx.workspaceId}/settings#notifications`;

/** The customer an alert watches, by name. */
async function nameOf(db: Db, ctx: ToolContext, watch: RoutineWatch): Promise<string | null> {
  if (watch.on !== 'reply' && watch.on !== 'booking') return null;
  const got = await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
    personId: watch.personId,
  }).catch(() => null);
  return got?.person.fullName?.trim() || null;
}

async function mine(db: Db, ctx: ToolContext, routineId: unknown): Promise<AssistantRoutineOut> {
  const { items } = await query<{ items: AssistantRoutineOut[] }>(
    db,
    ctx,
    'assistant_routine.list',
  );
  const found = items.find((r) => r.id === routineId);
  if (!found)
    throw HfosError.notFound(
      'That isn’t one of the things you asked the Assistant for here. read_assistant_routine_list has them.',
    );
  return found;
}

const whatOf = (r: AssistantRoutineOut) =>
  r.kind === 'question' ? `“${r.question ?? ''}”, ${r.when.toLowerCase()}` : r.when;

/** schedule_question and set_alert: what will be asked and when, or what it watches for, then made on Confirm. */
const scheduleQuestion: SettingsConfirmTool = {
  async prepare(_db, ctx, args, toolCallId) {
    const cadence = RoutineCadence.parse(args['cadence']);
    const first = nextRoutineRun(cadence, Date.now(), ctx.timezone);
    return {
      card: settingsCard(toolCallId, 'schedule_question', {
        title: 'Ask this on a schedule',
        fields: [
          { label: 'Question', value: String(args['question'] ?? '') },
          { label: 'When', value: cadenceWords(cadence) },
          { label: 'First time', value: dayTime(first, ctx.timezone) },
          {
            label: 'Answer goes to',
            value: args['email'] === true ? 'Your phone and your email' : 'Your phone',
          },
        ],
        confirmLabel: 'Set it up',
        warnings: [
          {
            kind: 'note',
            text: 'It’s asked as you, so the answer only holds what you can see. It only looks things up: it never sends, books or changes anything. Pause or stop it any time in Settings → Notifications.',
          },
        ],
      }),
      result: { waiting: true, when: cadenceWords(cadence) },
    };
  },
  async commit(db, ctx, args) {
    const out = await command<{ routineId: string; nextRunAt: string | null }>(
      db,
      ctx,
      'assistant_routine.create',
      {
        kind: 'question',
        question: args['question'],
        cadence: args['cadence'],
        ...(typeof args['email'] === 'boolean' ? { email: args['email'] } : {}),
      },
    );
    return {
      outcome: `Set up. It’s asked first ${out.nextRunAt ? dayTime(out.nextRunAt, ctx.timezone) : 'at its next time'}, and the answer goes to your phone`,
      href: settingsHref(ctx),
      command: 'assistant_routine.create',
      answer: out,
    };
  },
};

const setAlert: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const watch = RoutineWatch.parse(args['watch']);
    const once = typeof args['once'] === 'boolean' ? args['once'] : defaultOnce(watch);
    return {
      card: settingsCard(toolCallId, 'set_alert', {
        title: 'Set an alert',
        fields: [
          { label: 'Tell me', value: watchWords(watch, await nameOf(db, ctx, watch)) },
          { label: 'How often', value: once ? 'Once, then it stops' : 'Every time' },
          { label: 'Where', value: 'A notification on your phone' },
        ],
        confirmLabel: 'Set the alert',
        warnings: [
          {
            kind: 'note',
            text: 'Only you get it, and only about what you can see. Pause or stop it any time in Settings → Notifications.',
          },
        ],
      }),
      result: { waiting: true },
    };
  },
  async commit(db, ctx, args) {
    const out = await command<{ routineId: string }>(db, ctx, 'assistant_routine.create', {
      kind: 'alert',
      watch: args['watch'],
      ...(typeof args['once'] === 'boolean' ? { once: args['once'] } : {}),
    });
    return {
      outcome: 'The alert is on. You’ll get a notification on your phone',
      href: settingsHref(ctx),
      command: 'assistant_routine.create',
      answer: out,
    };
  },
};

export const routineConfirmTools: Record<string, SettingsConfirmTool> = {
  schedule_question: scheduleQuestion,
  set_alert: setAlert,
};

/** What the panel says while each one runs. */
export const routineStepLabels: Record<string, string> = {
  schedule_question: 'Getting the question ready',
  set_alert: 'Getting the alert ready',
};

const updateCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const r = await mine(db, ctx, args['routineId']);
    const fields: { label: string; value: string }[] = [{ label: 'Which', value: whatOf(r) }];
    if (typeof args['paused'] === 'boolean')
      fields.push({ label: 'Now', value: args['paused'] ? 'Paused' : 'On' });
    if (typeof args['question'] === 'string')
      fields.push({ label: 'Question', value: args['question'] });
    const cadence = RoutineCadence.safeParse(args['cadence']);
    if (cadence.success) fields.push({ label: 'When', value: cadenceWords(cadence.data) });
    if (typeof args['email'] === 'boolean')
      fields.push({ label: 'Email too', value: args['email'] ? 'Yes' : 'No' });
    const watch = RoutineWatch.safeParse(args['watch']);
    if (watch.success)
      fields.push({
        label: 'Tell me',
        value: watchWords(watch.data, await nameOf(db, ctx, watch.data)),
      });
    if (typeof args['once'] === 'boolean')
      fields.push({
        label: 'How often',
        value: args['once'] ? 'Once, then it stops' : 'Every time',
      });
    const pausing = args['paused'] === true && fields.length === 2;
    const resuming = args['paused'] === false && fields.length === 2;
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: pausing ? 'Pause this' : resuming ? 'Turn this on again' : 'Change this',
        fields,
        confirmLabel: pausing ? 'Pause it' : resuming ? 'Turn it on' : 'Save the change',
      }),
      result: { waiting: true },
    };
  },
  async done(_db, ctx, args) {
    return {
      outcome:
        args['paused'] === true
          ? 'Paused'
          : args['paused'] === false
            ? 'Turned on again'
            : 'Changed',
      href: settingsHref(ctx),
    };
  },
};

const deleteCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const r = await mine(db, ctx, args['routineId']);
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: r.kind === 'question' ? 'Stop asking this' : 'Delete this alert',
        fields: [{ label: 'Which', value: whatOf(r) }],
        confirmLabel: 'Delete it',
        warnings: [
          {
            kind: 'note',
            text: 'Pausing keeps it to turn on again later; deleting doesn’t. The answers it already gave stay in their chat.',
          },
        ],
      }),
      result: { waiting: true },
    };
  },
  async done(_db, ctx) {
    return { outcome: 'Deleted', href: settingsHref(ctx) };
  },
};

export const routineScreenCards: Readonly<Record<string, ScreenActionCard>> = {
  [assistantRoutineUpdate.name]: updateCard,
  [assistantRoutineDelete.name]: deleteCard,
};
