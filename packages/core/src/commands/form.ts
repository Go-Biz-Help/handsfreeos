/**
 * Forms, surveys and quizzes: create one, save the draft every editor changes (patch ops against a base
 * revision), publish it as an append-only version, open and close it for answers, rename it, change where
 * it can appear, duplicate it, archive it, and put an old version back.
 *
 * Nobody writes a response here — responses arrive through the worker (see form-response.ts). And nothing
 * a visitor can see changes until a publish: the draft is only ever the business's own working copy.
 */
import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import { forms, formVersions } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { allQuestions, type FormDefinition } from '../forms/definition';
import { describeFormOps } from '../forms/describe';
import {
  blankForm,
  formIssues,
  freeFormSlug,
  loadForm,
  parseStoredForm,
  type FormRow,
} from '../forms/load';
import { applyFormOps, FormOpError, type FormOp } from '../forms/ops';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  FormCreateInput,
  FormCreateOutput,
  FormDeliveryOutput,
  FormDuplicateInput,
  FormPublishInput,
  FormPublishOutput,
  FormRefInput,
  FormRenameInput,
  FormRestoreVersionInput,
  FormSaveDraftInput,
  FormSaveDraftOutput,
  FormSetDeliveryInput,
  FormSetSlugInput,
  FormSetStatusInput,
  FormSlugOutput,
  FormStatusOutput,
} from '../schemas/form';
import { jsonEqual } from '../workflows/json';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const asJson = (d: FormDefinition) => d as unknown as Record<string, unknown>;

/** Audit entries keep the first lines of a long batch. */
const MAX_CHANGE_LINES = 40;
const capLines = (lines: string[]) =>
  lines.length <= MAX_CHANGE_LINES
    ? lines
    : [...lines.slice(0, MAX_CHANGE_LINES - 1), `…and ${lines.length - MAX_CHANGE_LINES + 1} more`];

/** One line per op for the audit log, read against the form as it was before the batch. */
const opLines = (ops: readonly FormOp[], before: FormDefinition): string[] =>
  describeFormOps(ops, before);

export function formRevisionConflict(revision: number): HfosError {
  return new HfosError(
    'conflict',
    409,
    'Someone saved this form in the meantime. Reload to see their changes.',
    { revision },
    'revision_conflict',
  );
}

/** Applies ops all or nothing; a bad op is a 400 naming its index and what's wrong. */
function applyOps(definition: FormDefinition, ops: readonly unknown[]): FormDefinition {
  try {
    return applyFormOps(definition, ops as readonly FormOp[]).definition;
  } catch (e) {
    if (!(e instanceof FormOpError)) throw e;
    throw new HfosError(
      'validation',
      400,
      e.message,
      { opIndex: e.opIndex, code: e.code, targetId: e.targetId, issues: e.issues },
      'form_op_invalid',
    );
  }
}

function assertNotArchived(row: FormRow): void {
  if (row.status === 'archived')
    throw HfosError.conflict('This form is archived.', 'form_archived');
}

interface SaveArgs {
  readonly formId: string;
  readonly baseRevision: number;
  readonly ops: readonly unknown[];
  readonly restoredFrom?: number;
}

/** The save path, shared by saving and by putting an old version back. */
async function saveDraft(ctx: CommandContext, args: SaveArgs) {
  const ws = ctx.scope.workspaceId!;
  const current = await loadForm(ctx.tx, ws, args.formId, { forUpdate: true });
  assertNotArchived(current.row);
  if (current.row.revision !== args.baseRevision) throw formRevisionConflict(current.row.revision);
  const next = applyOps(current.definition, args.ops);
  const { issues } = await formIssues(ctx.tx, ws, next);
  if (jsonEqual(next, current.definition))
    return {
      formId: current.row.id,
      revision: current.row.revision,
      changed: false,
      changes: [],
      issues,
    };
  const changes = [
    ...(args.restoredFrom ? [`Put version ${args.restoredFrom} back`] : []),
    ...opLines(args.ops as readonly FormOp[], current.definition),
  ];
  const revision = current.row.revision + 1;
  await ctx.tx
    .update(forms)
    .set({
      definition: asJson(next),
      definitionVersion: next.version,
      revision,
      mode: next.mode,
    })
    .where(eq(forms.id, current.row.id));
  await ctx.emit({
    type: 'form.draft_saved',
    entityType: 'form',
    entityId: current.row.id,
    payload: {
      revision,
      changes: capLines(changes),
      opCount: args.ops.length,
      ...(args.restoredFrom ? { restoredFrom: args.restoredFrom } : {}),
    },
    before: { name: current.row.name, revision: current.row.revision },
    after: { name: current.row.name, revision, changes: capLines(changes) },
  });
  return { formId: current.row.id, revision, changed: true, changes, issues };
}

// ---- Commands ----

export const formCreate = defineCommand({
  name: 'form.create',
  description:
    'Start a form, a survey or a quiz: one empty page and a thank-you screen, as a draft nobody can fill in yet.',
  risk: 1,
  input: FormCreateInput,
  output: FormCreateOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const definition = blankForm(input.title ?? input.name, input.mode);
    const slug = await freeFormSlug(ctx.tx, ws, input.name);
    const [row] = await ctx.tx
      .insert(forms)
      .values({
        workspaceId: ws,
        name: input.name,
        mode: input.mode,
        status: 'draft',
        slug,
        definition: asJson(definition),
        definitionVersion: definition.version,
        revision: 1,
        createdBy: me,
      })
      .returning({ id: forms.id });
    if (!row) throw HfosError.forbidden();
    const { issues } = await formIssues(ctx.tx, ws, definition);
    await ctx.emit({
      type: 'form.created',
      entityType: 'form',
      entityId: row.id,
      payload: { name: input.name, mode: input.mode, slug },
      after: { name: input.name, mode: input.mode, status: 'draft', link: slug },
    });
    return { formId: row.id, revision: 1, slug, issues };
  },
});

export const formSaveDraft = defineCommand({
  name: 'form.save_draft',
  description:
    'Save changes to a form as patch ops against the revision the editor started from. The question list, the preview and the Assistant all save this way.',
  risk: 1,
  input: FormSaveDraftInput,
  output: FormSaveDraftOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.draft_saved'],
  handler: (ctx, input) =>
    saveDraft(ctx, { formId: input.formId, baseRevision: input.baseRevision, ops: input.ops }),
});

export const formRestoreVersion = defineCommand({
  name: 'form.restore_version',
  description:
    'Put an old published version back as the draft. It is not live until it is published again.',
  risk: 1,
  input: FormRestoreVersionInput,
  output: FormSaveDraftOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.draft_saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [version] = await ctx.tx
      .select()
      .from(formVersions)
      .where(
        and(
          eq(formVersions.formId, input.formId),
          eq(formVersions.workspaceId, ws),
          eq(formVersions.version, input.version),
        ),
      );
    if (!version) throw HfosError.notFound('That version isn’t there.');
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    assertNotArchived(current.row);
    if (current.row.revision !== input.baseRevision)
      throw formRevisionConflict(current.row.revision);
    const wanted = parseStoredForm(version.definition);
    if (jsonEqual(wanted, current.definition))
      return {
        formId: current.row.id,
        revision: current.row.revision,
        changed: false,
        changes: [],
        issues: (await formIssues(ctx.tx, ws, current.definition)).issues,
      };
    // The whole definition at once: restoring is one change, however many questions moved.
    const revision = current.row.revision + 1;
    const { issues } = await formIssues(ctx.tx, ws, wanted);
    await ctx.tx
      .update(forms)
      .set({
        definition: asJson(wanted),
        definitionVersion: wanted.version,
        revision,
        mode: wanted.mode,
      })
      .where(eq(forms.id, current.row.id));
    const changes = [`Put version ${input.version} back`];
    await ctx.emit({
      type: 'form.draft_saved',
      entityType: 'form',
      entityId: current.row.id,
      payload: { revision, changes, restoredFrom: input.version, opCount: 0 },
      before: { revision: current.row.revision },
      after: { revision, changes },
    });
    return { formId: current.row.id, revision, changed: true, changes, issues };
  },
});

export const formPublish = defineCommand({
  name: 'form.publish',
  description:
    'Publish the draft as a new version and start taking answers on it. Refused while anything is wrong with the form, or while it asks nothing.',
  risk: 2,
  input: FormPublishInput,
  output: FormPublishOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.published'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    assertNotArchived(current.row);
    if (current.row.revision !== input.baseRevision)
      throw formRevisionConflict(current.row.revision);
    const asked = allQuestions(current.definition).filter((q) => q.type !== 'content');
    if (!asked.length)
      throw HfosError.rule('form_empty', 422, 'Add a question before you publish this.');
    const { issues } = await formIssues(ctx.tx, ws, current.definition);
    if (issues.length)
      throw new HfosError(
        'rule_violation',
        422,
        'There are things to fix before this can go out.',
        { issues },
        'form_issues',
      );
    const [last] = await ctx.tx
      .select({ version: formVersions.version })
      .from(formVersions)
      .where(eq(formVersions.formId, current.row.id))
      .orderBy(desc(formVersions.version))
      .limit(1);
    const version = (last?.version ?? 0) + 1;
    const [row] = await ctx.tx
      .insert(formVersions)
      .values({
        workspaceId: ws,
        formId: current.row.id,
        version,
        definition: asJson(current.definition),
        definitionVersion: current.definition.version,
        revision: current.row.revision,
        source: input.source,
        publishedBy: me,
      })
      .returning({ id: formVersions.id });
    if (!row) throw HfosError.forbidden();
    // A form that was closed stays closed: publishing changes what it asks, not whether it is open.
    const status = current.row.status === 'closed' ? ('closed' as const) : ('live' as const);
    await ctx.tx
      .update(forms)
      .set({ activeVersionId: row.id, status })
      .where(eq(forms.id, current.row.id));
    await ctx.emit({
      type: 'form.published',
      entityType: 'form',
      entityId: current.row.id,
      payload: { versionId: row.id, version, source: input.source, questionCount: asked.length },
      before: { status: current.row.status },
      after: { status, version, questions: asked.length },
    });
    return { formId: current.row.id, versionId: row.id, version, status };
  },
});

export const formSetStatus = defineCommand({
  name: 'form.set_status',
  description:
    'Start or stop taking answers. A closed form still opens for anyone holding the link, and says so.',
  risk: 2,
  input: FormSetStatusInput,
  output: FormStatusOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.opened', 'form.closed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    assertNotArchived(current.row);
    if (!current.row.activeVersionId)
      throw HfosError.rule('form_unpublished', 409, 'Publish this form before you open it.');
    if (current.row.status === input.status)
      return { formId: current.row.id, status: input.status };
    await ctx.tx.update(forms).set({ status: input.status }).where(eq(forms.id, current.row.id));
    await ctx.emit({
      type: input.status === 'live' ? 'form.opened' : 'form.closed',
      entityType: 'form',
      entityId: current.row.id,
      payload: { status: input.status },
      before: { status: current.row.status },
      after: { status: input.status },
    });
    return { formId: current.row.id, status: input.status };
  },
});

export const formRename = defineCommand({
  name: 'form.rename',
  description: 'Rename a form. Its link stays as it is until the link itself is changed.',
  risk: 1,
  input: FormRenameInput,
  output: FormStatusOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.renamed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    assertNotArchived(current.row);
    if (current.row.name !== input.name) {
      await ctx.tx.update(forms).set({ name: input.name }).where(eq(forms.id, current.row.id));
      await ctx.emit({
        type: 'form.renamed',
        entityType: 'form',
        entityId: current.row.id,
        payload: { name: input.name },
        before: { name: current.row.name },
        after: { name: input.name },
      });
    }
    return { formId: current.row.id, status: current.row.status };
  },
});

export const formSetSlug = defineCommand({
  name: 'form.set_slug',
  description:
    'Change the form’s public link. The old one keeps working: anything already printed or texted still lands here.',
  risk: 2,
  input: FormSetSlugInput,
  output: FormSlugOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.slug_changed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    assertNotArchived(current.row);
    if (current.row.slug === input.slug) return { formId: current.row.id, slug: input.slug };
    const free = await freeFormSlug(ctx.tx, ws, input.slug, current.row.id);
    if (free !== input.slug)
      throw HfosError.conflict('Another form already uses that link.', 'form_slug_taken');
    await ctx.tx.update(forms).set({ slug: input.slug }).where(eq(forms.id, current.row.id));
    await ctx.emit({
      type: 'form.slug_changed',
      entityType: 'form',
      entityId: current.row.id,
      payload: { slug: input.slug, was: current.row.slug },
      before: { link: current.row.slug },
      after: { link: input.slug },
    });
    return { formId: current.row.id, slug: input.slug };
  },
});

export const formSetDelivery = defineCommand({
  name: 'form.set_delivery',
  description:
    'Where a form may appear: the sites allowed to embed it, and whether the AI teammate may ask its questions in a conversation.',
  risk: 2,
  input: FormSetDeliveryInput,
  output: FormDeliveryOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.delivery_changed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    assertNotArchived(current.row);
    const embedOrigins = input.embedOrigins
      ? [...new Set(input.embedOrigins)]
      : current.row.embedOrigins;
    const inChat = input.inChat ?? current.row.inChat;
    await ctx.tx.update(forms).set({ embedOrigins, inChat }).where(eq(forms.id, current.row.id));
    await ctx.emit({
      type: 'form.delivery_changed',
      entityType: 'form',
      entityId: current.row.id,
      payload: { embedOrigins, inChat },
      before: { sites: current.row.embedOrigins, inChat: current.row.inChat },
      after: { sites: embedOrigins, inChat },
    });
    return { formId: current.row.id, embedOrigins, inChat };
  },
});

export const formDuplicate = defineCommand({
  name: 'form.duplicate',
  description:
    'Copy a form, questions and all, as a fresh draft with its own link. The copy has no answers.',
  risk: 1,
  input: FormDuplicateInput,
  output: FormCreateOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = requireHuman(ctx).userId;
    const source = await loadForm(ctx.tx, ws, input.formId);
    const name = input.name ?? `${source.row.name} copy`;
    const slug = await freeFormSlug(ctx.tx, ws, name);
    const [row] = await ctx.tx
      .insert(forms)
      .values({
        workspaceId: ws,
        name,
        mode: source.row.mode,
        status: 'draft',
        slug,
        definition: asJson(source.definition),
        definitionVersion: source.definition.version,
        revision: 1,
        createdBy: me,
      })
      .returning({ id: forms.id });
    if (!row) throw HfosError.forbidden();
    const { issues } = await formIssues(ctx.tx, ws, source.definition);
    await ctx.emit({
      type: 'form.created',
      entityType: 'form',
      entityId: row.id,
      payload: { name, mode: source.row.mode, slug, copiedFrom: source.row.id },
      after: { name, status: 'draft', copiedFrom: source.row.name, link: slug },
    });
    return { formId: row.id, revision: 1, slug, issues };
  },
});

export const formArchive = defineCommand({
  name: 'form.archive',
  description:
    'Put a form away. It stops taking answers and leaves the list; the answers it already has stay.',
  risk: 2,
  input: FormRefInput,
  output: FormStatusOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.archived'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    if (current.row.status === 'archived')
      return { formId: current.row.id, status: 'archived' as const };
    await ctx.tx
      .update(forms)
      .set({ status: 'archived', archivedAt: dsql`now()` })
      .where(eq(forms.id, current.row.id));
    await ctx.emit({
      type: 'form.archived',
      entityType: 'form',
      entityId: current.row.id,
      payload: { name: current.row.name },
      before: { status: current.row.status },
      after: { status: 'archived' },
    });
    return { formId: current.row.id, status: 'archived' as const };
  },
});

export const formRestore = defineCommand({
  name: 'form.restore',
  description: 'Take a form back out of the archive. It comes back closed, not taking answers.',
  risk: 1,
  input: FormRefInput,
  output: FormStatusOutput,
  permission: 'forms.manage',
  scope: inWorkspace,
  emits: ['form.restored'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await loadForm(ctx.tx, ws, input.formId, { forUpdate: true });
    if (current.row.status !== 'archived')
      return { formId: current.row.id, status: current.row.status };
    const status = current.row.activeVersionId ? ('closed' as const) : ('draft' as const);
    await ctx.tx
      .update(forms)
      .set({ status, archivedAt: null })
      .where(eq(forms.id, current.row.id));
    await ctx.emit({
      type: 'form.restored',
      entityType: 'form',
      entityId: current.row.id,
      payload: { status },
      before: { status: 'archived' },
      after: { status },
    });
    return { formId: current.row.id, status };
  },
});

export const formCommands = [
  formCreate,
  formSaveDraft,
  formRestoreVersion,
  formPublish,
  formSetStatus,
  formRename,
  formSetSlug,
  formSetDelivery,
  formDuplicate,
  formArchive,
  formRestore,
] as const;
