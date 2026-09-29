/**
 * Server-side form helpers: one form with its draft parsed, the catalogs a definition is checked against
 * (the pipelines, tags, workflows and invented fields it may name), and everything wrong with a form as
 * the business stands today. Reads the database, so it is exported from '@hfos/core/server' only —
 * forms/index.ts stays browser-safe.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { customFields, forms, pipelineStages, pipelines, tags, workflows } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { isPlaceholder } from '../workflows/ids';
import {
  allQuestions,
  FormDefinition,
  formProblems,
  scoringProblems,
  withSafeResultLinks,
  type Question,
} from './definition';
import { newPageId, newResultId } from './ids';
import { customTargetFieldId, isCustomTarget, type QuestionType } from './questions';

// ---- A form to start from ----

/** A new, empty form: one page, one thank-you screen, nothing asked yet. */
export function blankForm(
  title: string,
  mode: 'form' | 'survey' | 'quiz' = 'form',
): FormDefinition {
  return FormDefinition.parse({
    mode,
    title,
    pages: [{ id: newPageId(), title: '', questions: [] }],
    results: [{ id: newResultId(), name: 'Thank you', headline: 'Thanks — we’ve got that.' }],
  });
}

// ---- Loading ----

export type FormRow = typeof forms.$inferSelect;

export interface LoadedForm {
  readonly row: FormRow;
  /** The draft, parsed with every default filled in. */
  readonly definition: FormDefinition;
}

/**
 * A stored definition (a draft or a version), parsed; a broken one is our fault, not the caller's. A
 * result link saved before links had to be web pages is dropped rather than making the form unreadable.
 */
export function parseStoredForm(raw: unknown): FormDefinition {
  const parsed = FormDefinition.safeParse(withSafeResultLinks(raw));
  if (!parsed.success)
    throw HfosError.internal(
      'This form’s saved questions can’t be read right now. Try again in a minute.',
    );
  return parsed.data;
}

/** One form with its draft parsed. `forUpdate` locks the row. */
export async function loadForm(
  tx: Tx,
  workspaceId: string,
  formId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<LoadedForm> {
  const query = tx
    .select()
    .from(forms)
    .where(and(eq(forms.id, formId), eq(forms.workspaceId, workspaceId)));
  const [row] = opts.forUpdate ? await query.for('update') : await query;
  if (!row)
    throw HfosError.notFound(
      'That form isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return { row, definition: parseStoredForm(row.definition) };
}

// ---- What a form may name ----

export interface FormCustomField {
  readonly id: string;
  readonly entity: 'person' | 'company' | 'lead';
  readonly label: string;
  readonly type: string;
}

export interface FormCatalogs {
  readonly pipelines: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
    readonly stages: readonly { readonly id: string; readonly name: string }[];
  }[];
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly workflows: readonly { readonly id: string; readonly name: string }[];
  readonly customFields: readonly FormCustomField[];
}

export async function loadFormCatalogs(tx: Tx, workspaceId: string): Promise<FormCatalogs> {
  const pipelineList = await tx
    .select({ id: pipelines.id, name: pipelines.name, archivedAt: pipelines.archivedAt })
    .from(pipelines)
    .where(eq(pipelines.workspaceId, workspaceId))
    .orderBy(asc(pipelines.position));
  const stageList = await tx
    .select({
      id: pipelineStages.id,
      pipelineId: pipelineStages.pipelineId,
      name: pipelineStages.name,
    })
    .from(pipelineStages)
    .where(eq(pipelineStages.workspaceId, workspaceId))
    .orderBy(asc(pipelineStages.position));
  const tagList = await tx
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.workspaceId, workspaceId))
    .orderBy(asc(tags.name));
  const workflowList = await tx
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(and(eq(workflows.workspaceId, workspaceId), ne(workflows.status, 'archived')))
    .orderBy(asc(workflows.name));
  const fieldList = await tx
    .select({
      id: customFields.id,
      entity: customFields.entity,
      label: customFields.label,
      type: customFields.type,
    })
    .from(customFields)
    .where(
      and(
        eq(customFields.workspaceId, workspaceId),
        sql`archived_at is null`,
        // A form fills in a customer, their company or their lead; a pet's or a car's fields are its own (0101).
        ne(customFields.entity, 'custom_record'),
      ),
    )
    .orderBy(asc(customFields.position));
  return {
    pipelines: pipelineList.map((p) => ({
      id: p.id,
      name: p.name,
      archived: p.archivedAt !== null,
      stages: stageList
        .filter((s) => s.pipelineId === p.id)
        .map((s) => ({ id: s.id, name: s.name })),
    })),
    tags: tagList.map((t) => ({ id: t.id, name: String(t.name) })),
    workflows: workflowList,
    customFields: fieldList.map((f) => ({
      ...f,
      entity: f.entity as Exclude<typeof f.entity, 'custom_record'>,
    })),
  };
}

/**
 * What a question's answer may be written into. A short answer can fill almost anything; a number needs a
 * field that holds numbers. Anything else is refused with the field's own name, not its id.
 */
const CUSTOM_FIELD_ACCEPTS: Readonly<Record<string, readonly QuestionType[]>> = {
  text: ['short_text', 'long_text', 'choice', 'phone', 'email', 'date', 'time'],
  long_text: ['long_text', 'short_text'],
  number: ['number', 'rating', 'scale'],
  money: ['money', 'number'],
  date: ['date'],
  choice: ['choice', 'short_text', 'yes_no'],
  multi_choice: ['checkboxes'],
  boolean: ['yes_no'],
  phone: ['phone', 'short_text'],
  email: ['email', 'short_text'],
  url: ['short_text'],
};

export interface FormIssue {
  readonly message: string;
  /** The question or page it is on, when it is on one. */
  readonly questionId?: string;
}

/**
 * Everything wrong with a form as this business stands today: what the definition itself can tell (a rule
 * reading an answer nobody has given yet), plus what only the database knows — a pipeline that has been
 * archived, a workflow that is gone, an answer pointed at a field that can't hold it.
 *
 * The editor shows these while the business works. `form.publish` refuses while any are left, which is
 * where "a half-built form is allowed to be half-built" stops.
 */
export async function formIssues(
  tx: Tx,
  workspaceId: string,
  definition: FormDefinition,
): Promise<{ issues: FormIssue[]; catalogs: FormCatalogs }> {
  const catalogs = await loadFormCatalogs(tx, workspaceId);
  const issues: FormIssue[] = [
    ...formProblems(definition).map((message) => ({ message })),
    ...scoringProblems(definition).map((message) => ({ message })),
  ];

  const { lead, workflowIds, person } = definition.onSubmit;
  const realId = (ref: unknown): string | null =>
    typeof ref === 'string' ? ref : isPlaceholder(ref) ? null : null;

  if (lead) {
    const pipelineId = realId(lead.pipelineId);
    const pipeline = catalogs.pipelines.find((p) => p.id === pipelineId);
    if (pipelineId && !pipeline)
      issues.push({ message: 'The pipeline this form files leads in is gone.' });
    else if (pipeline?.archived)
      issues.push({ message: `“${pipeline.name}” is archived, so leads can’t go there.` });
    const stageId = realId(lead.stageId);
    if (stageId && pipeline && !pipeline.stages.some((s) => s.id === stageId))
      issues.push({ message: 'The stage this form files leads in is gone.' });
    if (lead.valueFrom && !definition.calculations.some((c) => c.id === lead.valueFrom))
      issues.push({ message: 'The lead’s value comes from a calculation that isn’t there.' });
  }
  for (const tagRef of person.tagIds) {
    const tagId = realId(tagRef);
    if (tagId && !catalogs.tags.some((t) => t.id === tagId))
      issues.push({ message: 'One of the tags this form adds is gone.' });
  }
  for (const workflowRef of workflowIds) {
    const workflowId = realId(workflowRef);
    if (workflowId && !catalogs.workflows.some((w) => w.id === workflowId))
      issues.push({ message: 'One of the workflows this form starts is gone.' });
  }

  for (const question of allQuestions(definition)) {
    if (!question.mapTo || !isCustomTarget(question.mapTo)) continue;
    const field = catalogs.customFields.find((f) => f.id === customTargetFieldId(question.mapTo!));
    if (!field) {
      issues.push({
        message: `“${question.title}” fills in a field that is gone.`,
        questionId: question.id,
      });
      continue;
    }
    const accepts = CUSTOM_FIELD_ACCEPTS[field.type] ?? [];
    if (!accepts.includes(question.type))
      issues.push({
        message: `“${question.title}” can’t fill in “${field.label}”.`,
        questionId: question.id,
      });
  }

  return { issues, catalogs };
}

/** The invented fields a form writes to, so the submit path knows what to fill in. */
export function mappedCustomFieldIds(definition: FormDefinition): string[] {
  return [
    ...new Set(
      allQuestions(definition)
        .map((q: Question) => q.mapTo)
        .filter((target): target is string => typeof target === 'string' && isCustomTarget(target))
        .map(customTargetFieldId),
    ),
  ];
}

// ---- Public links ----

/** A form's link name from its title: "Get a Quote!" → "get-a-quote". */
export function formSlugFrom(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'form';
}

/** The first free link name for this business: "get-a-quote", then "get-a-quote-2". */
export async function freeFormSlug(
  tx: Tx,
  workspaceId: string,
  wanted: string,
  exceptFormId?: string,
): Promise<string> {
  const base = formSlugFrom(wanted);
  const taken = await rows<{ slug: string }>(
    tx,
    sql`select slug from app.forms where workspace_id = ${workspaceId}
          and (${exceptFormId ?? null}::uuid is null or id <> ${exceptFormId ?? null}::uuid)
        union select slug from app.form_slugs where workspace_id = ${workspaceId}`,
  );
  const used = new Set(taken.map((r) => r.slug));
  if (!used.has(base)) return base;
  for (let n = 2; n < 200; n++) {
    const candidate = `${base.slice(0, 58)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}
