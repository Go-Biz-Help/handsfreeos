/**
 * The Assistant's form tools. Looking a form up, reading its results and building or changing one run on
 * their own — because a draft is the business's own working copy and no customer can see it. Publishing,
 * closing and texting somebody a link wait for the person's OK on a card: those are the moments a form
 * reaches the public.
 *
 * Everything goes through the same commands and queries the screens use, as the person, marked as done
 * through the Assistant.
 */
import { describeForm, HfosError, type AssistantCard } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { AI_UNAVAILABLE_MESSAGE } from '../ai/ask';
import { draftForm } from '../forms/builder';
import type { WorkerServices } from '../services';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, query } from './tools-read';

type Args = Record<string, unknown>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;

export interface FormToolDeps {
  readonly ai: WorkerServices['ai'];
  readonly log: Logger;
  readonly wallet: WorkerServices['wallet'];
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const formPaths = (ws: string) => ({
  list: () => `/app/w/${ws}/forms`,
  form: (id: string) => `/app/w/${ws}/forms/${id}`,
});

function confirmCard(
  toolCallId: string,
  tool: string,
  card: Pick<ConfirmCard, 'title' | 'fields' | 'body' | 'warnings' | 'confirmLabel'> &
    Partial<Pick<ConfirmCard, 'personId'>>,
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: null,
    conversationId: null,
    stageFrom: null,
    stageTo: null,
    reasons: [],
    editable: false,
    ...card,
  };
}

interface FormSummary {
  formId: string;
  name: string;
  mode: string;
  status: string;
  slug: string;
  questionCount: number;
  responseCount: number;
  completionRate: number | null;
  version: number | null;
}

// ---------- reading ----------

async function listForms(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const out = await query<{ items: FormSummary[] }>(db, ctx, 'form.list', {
    ...(str(args['status']) ? { status: [str(args['status'])] } : {}),
    ...(str(args['mode']) ? { mode: [str(args['mode'])] } : {}),
  });
  return {
    result: {
      forms: out.items.map((f) => ({
        formId: f.formId,
        name: f.name,
        kind: f.mode,
        status: f.status,
        link: f.status === 'draft' ? null : `/f/…/${f.slug}`,
        questions: f.questionCount,
        answers: f.responseCount,
        version: f.version,
      })),
    },
  };
}

async function getForm(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const formId = str(args['formId']);
  if (!formId) throw HfosError.validation(undefined, 'Which form?');
  const out = await query<{
    form: FormSummary;
    definition: unknown;
    issues: { message: string }[];
    unpublishedChanges: boolean;
  }>(db, ctx, 'form.get', { formId });
  const definition = out.definition as Parameters<typeof describeForm>[0];
  return {
    result: {
      form: {
        formId: out.form.formId,
        name: out.form.name,
        kind: out.form.mode,
        status: out.form.status,
        answers: out.form.responseCount,
        unpublishedChanges: out.unpublishedChanges,
      },
      asks: describeForm(definition),
      // The ids the builder needs to point at anything.
      questionIds: definition.pages.flatMap((p) =>
        p.questions.map((q) => ({ id: q.id, title: q.title, type: q.type })),
      ),
      toFix: out.issues.map((i) => i.message),
    },
  };
}

async function formResults(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const formId = str(args['formId']);
  if (!formId) throw HfosError.validation(undefined, 'Which form?');
  const out = await query<{
    name: string;
    mode: string;
    views: number;
    starts: number;
    completions: number;
    averagePercent: number | null;
    passRate: number | null;
    questions: {
      title: string;
      answered: number;
      choices: { label: string; count: number }[];
      average: number | null;
      samples: string[];
    }[];
  }>(db, ctx, 'form.results', { formId });
  return {
    result: {
      form: out.name,
      looked: out.views,
      started: out.starts,
      finished: out.completions,
      ...(out.mode === 'quiz' ? { averageScore: out.averagePercent, passRate: out.passRate } : {}),
      questions: out.questions.map((q) => ({
        question: q.title,
        answered: q.answered,
        ...(q.choices.length ? { picks: q.choices } : {}),
        ...(q.average !== null ? { average: q.average } : {}),
        ...(q.samples.length ? { recentAnswers: q.samples.slice(0, 3) } : {}),
      })),
    },
  };
}

// ---------- building (a draft: nobody outside the business sees it) ----------

async function buildForm(
  db: Db,
  ctx: ToolContext,
  args: Args,
  deps: FormToolDeps | null,
): Promise<ToolOutcome> {
  const description = str(args['description']);
  if (!description) throw HfosError.validation(undefined, 'What should the form ask?');
  if (!deps?.ai.provider) return { result: { error: AI_UNAVAILABLE_MESSAGE }, isError: true };

  let formId = str(args['formId']);
  let made = false;
  if (!formId) {
    const created = await command<{ formId: string }>(db, ctx, 'form.create', {
      name: str(args['name']) ?? 'New form',
      mode: str(args['mode']) ?? 'form',
    });
    formId = created.formId;
    made = true;
  }
  const drafted = await draftForm(
    { db, ai: deps.ai, log: deps.log, wallet: deps.wallet },
    ctx.actor,
    {
      workspaceId: ctx.workspaceId,
      formId,
      prompt: description,
    },
  );
  const href = formPaths(ctx.workspaceId).form(formId);
  return {
    result: {
      formId,
      created: made,
      summary: drafted.summary,
      changes: drafted.changes,
      ...(drafted.leftover.length ? { couldNotDo: drafted.leftover } : {}),
      ...(drafted.issues.length
        ? { toFixBeforePublishing: drafted.issues.map((i) => i.message) }
        : {}),
      saved: 'As a draft. Nothing a customer sees has changed; publishing is a separate step.',
    },
    card: {
      type: 'done',
      toolCallId: '',
      kind: 'note',
      title: made ? 'Drafted a form' : 'Changed a form',
      detail: [
        ...(drafted.summary ? [drafted.summary] : []),
        ...drafted.changes.slice(0, 6),
        ...(drafted.issues.length ? [`Still to fix: ${drafted.issues[0]!.message}`] : []),
      ].join(' · '),
      href,
      undoable: false,
    } as AssistantCard,
    command: 'form.save_draft',
    record: { formId, href },
  };
}

// ---------- what the public sees: on a card ----------

interface ConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    /** `webUrl` is the web app's address: a link that goes to a customer needs the whole thing, not a path. */
    extra: { readonly toolCallId: string; readonly webUrl: string },
  ): Promise<CommittedAction>;
}

const ACTION_WORDS = {
  publish: { title: 'Publish this form?', confirm: 'Publish' },
  close: { title: 'Stop taking answers?', confirm: 'Close it' },
  reopen: { title: 'Take answers again?', confirm: 'Reopen' },
} as const;

const publishForm: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const formId = str(args['formId']);
    const action = (str(args['action']) ?? 'publish') as keyof typeof ACTION_WORDS;
    if (!formId) throw HfosError.validation(undefined, 'Which form?');
    const out = await query<{
      form: FormSummary;
      issues: { message: string }[];
      unpublishedChanges: boolean;
      definition: Parameters<typeof describeForm>[0];
    }>(db, ctx, 'form.get', { formId });
    const words = ACTION_WORDS[action] ?? ACTION_WORDS.publish;
    const fields =
      action === 'publish'
        ? [
            { label: 'Form', value: out.form.name },
            { label: 'Asks', value: plural(out.form.questionCount, 'question') },
            {
              label: 'What changes',
              value: out.form.version
                ? `It is on version ${out.form.version}; this makes version ${out.form.version + 1}.`
                : 'Anybody with the link will be able to fill it in.',
            },
          ]
        : [
            { label: 'Form', value: out.form.name },
            {
              label: 'What changes',
              value:
                action === 'close'
                  ? 'It stops taking answers. The link still opens and says so.'
                  : 'It takes answers again.',
            },
          ];
    const blocked = action === 'publish' && out.issues.length ? out.issues[0]!.message : null;
    return {
      card: confirmCard(toolCallId, 'publish_form', {
        title: words.title,
        fields,
        body: action === 'publish' ? describeForm(out.definition).slice(0, 6).join('\n') : null,
        warnings: blocked ? [{ kind: 'form_issues', text: blocked }] : [],
        confirmLabel: blocked ? '' : words.confirm,
      }),
      result: { asked: words.title, issues: out.issues.map((i) => i.message) },
    };
  },
  async commit(db, ctx, args) {
    const formId = String(args['formId']);
    const action = (str(args['action']) ?? 'publish') as keyof typeof ACTION_WORDS;
    if (action === 'publish') {
      const got = await query<{ revision: number; form: FormSummary }>(db, ctx, 'form.get', {
        formId,
      });
      const out = await command<{ version: number }>(db, ctx, 'form.publish', {
        formId,
        baseRevision: got.revision,
        source: 'assistant',
      });
      return {
        outcome:
          out.version === 1
            ? `Published “${got.form.name}”. It is taking answers.`
            : `Published version ${out.version} of “${got.form.name}”.`,
        href: formPaths(ctx.workspaceId).form(formId),
        command: 'form.publish',
      };
    }
    await command(db, ctx, 'form.set_status', {
      formId,
      status: action === 'close' ? 'closed' : 'live',
    });
    return {
      outcome:
        action === 'close' ? 'It has stopped taking answers.' : 'It is taking answers again.',
      href: formPaths(ctx.workspaceId).form(formId),
      command: 'form.set_status',
    };
  },
};

const sendForm: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const formId = str(args['formId']);
    const personId = str(args['personId']);
    const message = str(args['message']);
    if (!formId || !personId || !message)
      throw HfosError.validation(undefined, 'Which form, to whom, and what should it say?');
    const form = await query<{ form: FormSummary }>(db, ctx, 'form.get', { formId });
    if (form.form.status !== 'live')
      throw HfosError.rule(
        'form_not_live',
        409,
        'That form isn’t taking answers yet. Publish it first.',
      );
    const person = await query<{ person: { fullName: string } }>(db, ctx, 'person.get', {
      personId,
    });
    const channel = str(args['channel']) === 'email' ? 'email' : 'sms';
    return {
      card: confirmCard(toolCallId, 'send_form', {
        title: channel === 'sms' ? 'Send this text?' : 'Send this email?',
        fields: [
          { label: 'To', value: person.person.fullName },
          { label: 'Form', value: form.form.name },
        ],
        body: message,
        warnings: [],
        confirmLabel: 'Send it',
        personId,
      }),
      result: { asked: 'Waiting for their OK before it goes out.' },
    };
  },
  async commit(db, ctx, args, extra) {
    const formId = String(args['formId']);
    const personId = String(args['personId']);
    const channel = str(args['channel']) === 'email' ? 'email' : 'sms';
    const form = await query<{ form: FormSummary }>(db, ctx, 'form.get', { formId });
    const site = await query<{ site: { slug: string } | null }>(db, ctx, 'booking_site.get', {});
    // Publishing gives the business its public name, so a live form has one. Without it there is no address to
    // send, and texting somebody a bare path would be worse than saying so.
    if (!site.site)
      throw HfosError.conflict(
        'This business has no link name yet, so the form has no address to send. Set one under Settings → Calendars → Booking site.',
        'no_booking_site',
      );
    // Their own domain once one is serving (M17), so the link the Assistant sends matches the one on their
    // booking page and their flyers.
    const branded = await query<{
      domain: { domain: string; status: string; certificateReady: boolean } | null;
    }>(db, ctx, 'branded_domain.get', {});
    const origin =
      branded.domain && branded.domain.status === 'verified' && branded.domain.certificateReady
        ? `https://${branded.domain.domain}`
        : extra.webUrl;
    const link = `${origin}/f/${site.site.slug}/${form.form.slug}`;
    const body = `${String(args['message'])}\n\n${link}`;
    if (channel === 'sms') {
      await command(db, ctx, 'message.send', { personId, body });
      return { outcome: 'Sent.', href: null, command: 'message.send' };
    }
    await command(db, ctx, 'email.send', {
      personId,
      subject: form.form.name,
      body,
    });
    return { outcome: 'Sent.', href: null, command: 'email.send' };
  },
};

export const formAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args, deps: FormToolDeps | null) => Promise<ToolOutcome>
> = {
  list_forms: (db, ctx, args) => listForms(db, ctx, args),
  get_form: (db, ctx, args) => getForm(db, ctx, args),
  form_results: (db, ctx, args) => formResults(db, ctx, args),
  build_form: buildForm,
};

export const formConfirmTools: Record<string, ConfirmTool> = {
  publish_form: publishForm,
  send_form: sendForm,
};
