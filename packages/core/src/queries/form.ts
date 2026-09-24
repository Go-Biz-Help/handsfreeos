/**
 * Form reads (everyone in the business): the list, one form with its draft and what is still wrong with
 * it, a published version, the pickers the editor offers, the responses, and the results — the part where
 * four hundred answers to question three become one bar chart.
 *
 * The summaries are worked out in the database rather than by reading every response into memory, which is
 * what `form_answers` (0074) exists for.
 */
import { and, desc, eq, inArray, ne, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { formResponses, forms, formVersions } from '@hfos/db/schema';
import { userNames, uuidArray } from '../calendar/load';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import { allQuestions, type FormDefinition, type FormMode } from '../forms/definition';
import { formIssues, loadForm, loadFormCatalogs, parseStoredForm } from '../forms/load';
import { jsonEqual } from '../workflows/json';
import {
  FormCatalogsInput,
  FormCatalogsOutput,
  FormGetInput,
  FormGetOutput,
  FormListInput,
  FormListOutput,
  FormResponseExportInput,
  FormResponseExportOutput,
  FormResponseGetInput,
  FormResponseGetOutput,
  FormResponseListInput,
  FormResponseListOutput,
  FormResultsInput,
  FormResultsOutput,
  FormVersionGetInput,
  FormVersionGetOutput,
} from '../schemas/form';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type FormRow = typeof forms.$inferSelect;

const asked = (definition: FormDefinition): number =>
  allQuestions(definition).filter((q) => q.type !== 'content').length;

function summaryOf(
  row: FormRow,
  definition: FormDefinition,
  extra: { version: number | null; starts: number },
) {
  const completionRate =
    extra.starts > 0
      ? Math.min(1, row.responseCount / extra.starts)
      : row.responseCount > 0
        ? 1
        : null;
  return {
    formId: row.id,
    name: row.name,
    mode: row.mode as FormMode,
    status: row.status,
    slug: row.slug,
    questionCount: asked(definition),
    responseCount: row.responseCount,
    completionRate,
    lastResponseAt: row.lastResponseAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    version: extra.version,
    inChat: row.inChat,
    embedOrigins: row.embedOrigins,
  };
}

export const formList = defineQuery({
  name: 'form.list',
  description:
    'Every form, survey and quiz with its link, how many people answered, how many finished what they started, and whether it is taking answers.',
  input: FormListInput,
  output: FormListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const list = await ctx.tx
      .select()
      .from(forms)
      .where(
        and(
          eq(forms.workspaceId, ws),
          input.status?.length
            ? inArray(forms.status, input.status)
            : input.includeArchived
              ? undefined
              : ne(forms.status, 'archived'),
          input.mode?.length ? inArray(forms.mode, input.mode) : undefined,
          input.search ? dsql`${forms.name} ilike ${'%' + input.search + '%'}` : undefined,
        ),
      )
      .orderBy(dsql`lower(${forms.name})`, forms.id);
    if (!list.length) return { items: [] };
    const ids = list.map((f) => f.id);
    const versions = await rows<{ form_id: string; version: number }>(
      ctx.tx,
      sql`select v.form_id, v.version from app.form_versions v
          join app.forms f on f.active_version_id = v.id
          where v.form_id = any(${uuidArray(ids)})`,
    );
    const starts = await rows<{ form_id: string; starts: number }>(
      ctx.tx,
      sql`select form_id, coalesce(sum(starts), 0)::int as starts from app.form_days
          where form_id = any(${uuidArray(ids)}) group by form_id`,
    );
    const versionOf = new Map(versions.map((v) => [v.form_id, Number(v.version)]));
    const startsOf = new Map(starts.map((s) => [s.form_id, Number(s.starts)]));
    return {
      items: list.map((row) =>
        summaryOf(row, parseStoredForm(row.definition), {
          version: versionOf.get(row.id) ?? null,
          starts: startsOf.get(row.id) ?? 0,
        }),
      ),
    };
  },
});

export const formGet = defineQuery({
  name: 'form.get',
  description:
    'One form: the draft every editor works on, what is still wrong with it as the business stands today, its published versions, and whether the draft has moved on since the last publish.',
  input: FormGetInput,
  output: FormGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { row, definition } = await loadForm(ctx.tx, ws, input.formId);
    const { issues } = await formIssues(ctx.tx, ws, definition);
    const versionRows = await ctx.tx
      .select()
      .from(formVersions)
      .where(eq(formVersions.formId, row.id))
      .orderBy(desc(formVersions.version));
    const names = await userNames(
      ctx.tx,
      versionRows.map((v) => v.publishedBy).filter((id): id is string => id !== null),
    );
    const live = versionRows.find((v) => v.id === row.activeVersionId) ?? null;
    const [starts] = await rows<{ starts: number }>(
      ctx.tx,
      sql`select coalesce(sum(starts), 0)::int as starts from app.form_days where form_id = ${row.id}`,
    );
    return {
      form: summaryOf(row, definition, {
        version: live?.version ?? null,
        starts: Number(starts?.starts ?? 0),
      }),
      definition: definition as unknown as Record<string, unknown>,
      revision: row.revision,
      issues,
      versions: versionRows.map((v) => ({
        versionId: v.id,
        version: v.version,
        source: v.source,
        publishedBy: v.publishedBy ? (names.get(v.publishedBy) ?? null) : null,
        createdAt: v.createdAt.toISOString(),
        live: v.id === row.activeVersionId,
      })),
      unpublishedChanges: live
        ? !jsonEqual(parseStoredForm(live.definition), definition)
        : asked(definition) > 0,
    };
  },
});

export const formVersionGet = defineQuery({
  name: 'form.version_get',
  description: 'One published version, exactly as the people who filled it in saw it.',
  input: FormVersionGetInput,
  output: FormVersionGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [version] = await ctx.tx
      .select()
      .from(formVersions)
      .where(
        and(eq(formVersions.id, input.versionId), eq(formVersions.workspaceId, input.workspaceId)),
      );
    if (!version) throw HfosError.notFound('That version isn’t there.');
    return {
      versionId: version.id,
      formId: version.formId,
      version: version.version,
      definition: version.definition as Record<string, unknown>,
      createdAt: version.createdAt.toISOString(),
    };
  },
});

export const formCatalogs = defineQuery({
  name: 'form.catalogs',
  description:
    'What the editor’s pickers offer: the pipelines and their stages, the tags, the live workflows, the fields the business invented, and the team.',
  input: FormCatalogsInput,
  output: FormCatalogsOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const catalogs = await loadFormCatalogs(ctx.tx, input.workspaceId);
    const team = await rows<{ user_id: string; name: string }>(
      ctx.tx,
      sql`select wm.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name
          from app.workspace_memberships wm
          join app.users u on u.id = wm.user_id
          where wm.workspace_id = ${input.workspaceId}
          order by 2`,
    );
    return {
      pipelines: catalogs.pipelines.map((p) => ({ ...p, stages: [...p.stages] })),
      tags: [...catalogs.tags],
      workflows: [...catalogs.workflows],
      customFields: catalogs.customFields.map((f) => ({
        id: f.id,
        entity: f.entity,
        label: f.label,
        type: f.type,
      })),
      team: team.map((t) => ({ userId: t.user_id, name: t.name })),
    };
  },
});

export const formResponseList = defineQuery({
  name: 'form.response_list',
  description: 'Who answered a form, newest first.',
  input: FormResponseListInput,
  output: FormResponseListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const after = decodeCursor(input.cursor);
    const list = await rows<{
      id: string;
      form_id: string;
      version_id: string;
      status: 'in_progress' | 'completed';
      source: string;
      person_id: string | null;
      person_name: string | null;
      lead_id: string | null;
      score_percent: number | null;
      passed: boolean | null;
      result_id: string | null;
      started_at: string | Date;
      completed_at: string | Date | null;
      sort: string;
    }>(
      ctx.tx,
      sql`select r.id, r.form_id, r.version_id, r.status, r.source, r.person_id, r.lead_id,
            r.score_percent, r.passed, r.result_id, r.started_at, r.completed_at,
            btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as person_name,
            to_char(coalesce(r.completed_at, r.started_at), 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as sort
          from app.form_responses r
          left join app.people p on p.id = r.person_id
          where r.form_id = ${input.formId} and r.workspace_id = ${input.workspaceId}
            and (${input.includeUnfinished} or r.status = 'completed')
            and (${after?.sort ?? null}::text is null or
              (coalesce(r.completed_at, r.started_at), r.id) <
                (${after?.sort ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          order by coalesce(r.completed_at, r.started_at) desc, r.id desc
          limit ${input.limit + 1}`,
    );
    const paged = page(list, input.limit, (r) => ({ sort: r.sort, id: r.id }));
    return {
      items: paged.items.map((r) => ({
        responseId: r.id,
        formId: r.form_id,
        versionId: r.version_id,
        status: r.status,
        source: r.source as 'link',
        personId: r.person_id,
        personName: r.person_name?.trim() || null,
        leadId: r.lead_id,
        scorePercent: r.score_percent === null ? null : Number(r.score_percent),
        passed: r.passed,
        resultId: r.result_id,
        startedAt: new Date(r.started_at).toISOString(),
        completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      })),
      nextCursor: paged.nextCursor,
    };
  },
});

export const formResponseGet = defineQuery({
  name: 'form.response_get',
  description: 'One response in full, with each question as it read when they answered it.',
  input: FormResponseGetInput,
  output: FormResponseGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [response] = await ctx.tx
      .select({
        id: formResponses.id,
        formId: formResponses.formId,
        versionId: formResponses.versionId,
        status: formResponses.status,
        source: formResponses.source,
        personId: formResponses.personId,
        leadId: formResponses.leadId,
        scorePercent: formResponses.scorePercent,
        passed: formResponses.passed,
        resultId: formResponses.resultId,
        startedAt: formResponses.startedAt,
        completedAt: formResponses.completedAt,
        calculations: formResponses.calculations,
      })
      .from(formResponses)
      .where(
        and(
          eq(formResponses.id, input.responseId),
          eq(formResponses.workspaceId, input.workspaceId),
        ),
      );
    if (!response) throw HfosError.notFound('That answer sheet isn’t there.');
    const answers = await rows<{
      question_id: string;
      question_title: string;
      question_type: string;
      value: unknown;
      text_value: string | null;
      choice_labels: string[];
    }>(
      ctx.tx,
      sql`select question_id, question_title, question_type, value, text_value, choice_labels
          from app.form_answers where response_id = ${response.id} order by answered_at, question_id`,
    );
    const person = response.personId
      ? await rows<{ name: string }>(
          ctx.tx,
          sql`select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) as name
              from app.people where id = ${response.personId}`,
        )
      : [];
    return {
      response: {
        responseId: response.id,
        formId: response.formId,
        versionId: response.versionId,
        status: response.status,
        source: response.source,
        personId: response.personId,
        personName: person[0]?.name.trim() || null,
        leadId: response.leadId,
        scorePercent: response.scorePercent === null ? null : Number(response.scorePercent),
        passed: response.passed,
        resultId: response.resultId,
        startedAt: response.startedAt.toISOString(),
        completedAt: response.completedAt?.toISOString() ?? null,
      },
      answers: answers.map((a) => ({
        questionId: a.question_id,
        questionTitle: a.question_title,
        questionType: a.question_type,
        value: a.value,
        text: a.text_value,
        labels: a.choice_labels ?? [],
      })),
      calculations: (response.calculations ?? {}) as Record<string, number>,
    };
  },
});

/** An answer in words for a spreadsheet cell: the choices picked, else the words kept for it, else its plain value. */
function answerCell(a: {
  value: unknown;
  text_value: string | null;
  choice_labels: string[] | null;
}): string {
  if (a.choice_labels?.length) return a.choice_labels.join(', ');
  if (a.text_value) return a.text_value;
  if (typeof a.value === 'boolean') return a.value ? 'Yes' : 'No';
  if (typeof a.value === 'number' || typeof a.value === 'string') return String(a.value);
  return '';
}

export const formResponseExport = defineQuery({
  name: 'form.response_export',
  description:
    'Every finished answer sheet on a form with each answer in words, newest first and a page at a time, for a spreadsheet.',
  input: FormResponseExportInput,
  output: FormResponseExportOutput,
  // Everyone may read one answer sheet at a time; taking all of them away in a file is looking after the form.
  permission: 'forms.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { row, definition } = await loadForm(ctx.tx, ws, input.formId);
    const live = row.activeVersionId
      ? await ctx.tx.select().from(formVersions).where(eq(formVersions.id, row.activeVersionId))
      : [];
    // The questions people are answering now, in order, as the results page reads them.
    const asking = live[0] ? parseStoredForm(live[0].definition) : definition;
    const columns = allQuestions(asking)
      .filter((q) => q.type !== 'content')
      .map((q) => ({ questionId: q.id, title: q.title }));
    // Then anything an older version asked that somebody answered, worded as it last was, in the order it first came.
    const answered = await rows<{ question_id: string; title: string }>(
      ctx.tx,
      sql`select question_id, (array_agg(question_title order by answered_at desc))[1] as title
          from app.form_answers where form_id = ${row.id}
          group by question_id order by min(answered_at), question_id`,
    );
    const known = new Set(columns.map((c) => c.questionId));
    for (const a of answered)
      if (!known.has(a.question_id)) columns.push({ questionId: a.question_id, title: a.title });

    const after = decodeCursor(input.cursor);
    const list = await rows<{
      id: string;
      source: string;
      person_name: string | null;
      score_percent: number | null;
      passed: boolean | null;
      answered_at: string | Date;
      sort: string;
    }>(
      ctx.tx,
      sql`select r.id, r.source, r.score_percent, r.passed,
            btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as person_name,
            coalesce(r.completed_at, r.started_at) as answered_at,
            to_char(coalesce(r.completed_at, r.started_at), 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as sort
          from app.form_responses r
          left join app.people p on p.id = r.person_id
          where r.form_id = ${row.id} and r.workspace_id = ${ws} and r.status = 'completed'
            and (${after?.sort ?? null}::text is null or
              (coalesce(r.completed_at, r.started_at), r.id) <
                (${after?.sort ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          order by coalesce(r.completed_at, r.started_at) desc, r.id desc
          limit ${input.limit + 1}`,
    );
    const paged = page(list, input.limit, (r) => ({ sort: r.sort, id: r.id }));
    const ids = paged.items.map((r) => r.id);
    const cells = ids.length
      ? await rows<{
          response_id: string;
          question_id: string;
          value: unknown;
          text_value: string | null;
          choice_labels: string[] | null;
        }>(
          ctx.tx,
          sql`select response_id, question_id, value, text_value, choice_labels
              from app.form_answers where response_id = any(${uuidArray(ids)})`,
        )
      : [];
    const byResponse = new Map<string, Record<string, string>>();
    for (const c of cells) {
      const sheet = byResponse.get(c.response_id) ?? {};
      sheet[c.question_id] = answerCell(c);
      byResponse.set(c.response_id, sheet);
    }
    return {
      formName: row.name,
      columns,
      rows: paged.items.map((r) => ({
        responseId: r.id,
        personName: r.person_name?.trim() || null,
        source: r.source as 'link',
        completedAt: new Date(r.answered_at).toISOString(),
        scorePercent: r.score_percent === null ? null : Number(r.score_percent),
        passed: r.passed,
        answers: byResponse.get(r.id) ?? {},
      })),
      nextCursor: paged.nextCursor,
    };
  },
});

export const formResults = defineQuery({
  name: 'form.results',
  description:
    'What everybody said: a bar per choice, an average for numbers and ratings, the most recent text answers, and for a quiz how people scored.',
  input: FormResultsInput,
  output: FormResultsOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { row, definition } = await loadForm(ctx.tx, ws, input.formId);
    const live = row.activeVersionId
      ? await ctx.tx.select().from(formVersions).where(eq(formVersions.id, row.activeVersionId))
      : [];
    // The questions people are actually answering: the live version's, falling back to the draft.
    const asking = live[0] ? parseStoredForm(live[0].definition) : definition;

    const [days] = await rows<{ views: number; starts: number; completions: number }>(
      ctx.tx,
      sql`select coalesce(sum(views), 0)::int as views, coalesce(sum(starts), 0)::int as starts,
            coalesce(sum(completions), 0)::int as completions
          from app.form_days where form_id = ${row.id}`,
    );
    const [scores] = await rows<{ average: number | null; passed: number; graded: number }>(
      ctx.tx,
      sql`select avg(score_percent)::float as average,
            count(*) filter (where passed) ::int as passed,
            count(*) filter (where passed is not null) ::int as graded
          from app.form_responses where form_id = ${row.id} and status = 'completed'`,
    );
    const counts = await rows<{ question_id: string; answered: number; average: number | null }>(
      ctx.tx,
      sql`select question_id, count(*)::int as answered, avg(number_value)::float as average
          from app.form_answers where form_id = ${row.id} group by question_id`,
    );
    const choiceCounts = await rows<{ question_id: string; label: string; count: number }>(
      ctx.tx,
      sql`select a.question_id, l.label, count(*)::int as count
          from app.form_answers a, unnest(a.choice_labels) as l(label)
          where a.form_id = ${row.id}
          group by a.question_id, l.label order by 3 desc`,
    );
    const samples = await rows<{ question_id: string; text_value: string }>(
      ctx.tx,
      sql`select question_id, text_value from (
            select question_id, text_value, answered_at,
              row_number() over (partition by question_id order by answered_at desc) as n
            from app.form_answers
            where form_id = ${row.id} and text_value is not null
              and question_type in ('short_text', 'long_text', 'address', 'email', 'phone')
          ) x where n <= 5 order by question_id, answered_at desc`,
    );
    const resultCounts = await rows<{ result_id: string; count: number }>(
      ctx.tx,
      sql`select result_id, count(*)::int as count from app.form_responses
          where form_id = ${row.id} and status = 'completed' and result_id is not null
          group by result_id`,
    );

    const answeredOf = new Map(counts.map((c) => [c.question_id, c]));
    const questions = allQuestions(asking)
      .filter((q) => q.type !== 'content')
      .map((q) => {
        const found = answeredOf.get(q.id);
        return {
          questionId: q.id,
          title: q.title,
          type: q.type,
          answered: Number(found?.answered ?? 0),
          choices: choiceCounts
            .filter((c) => c.question_id === q.id)
            .map((c) => ({ label: c.label, count: Number(c.count) })),
          average:
            found?.average !== null && found?.average !== undefined
              ? Math.round(Number(found.average) * 100) / 100
              : null,
          samples: samples.filter((s) => s.question_id === q.id).map((s) => s.text_value),
        };
      });

    const graded = Number(scores?.graded ?? 0);
    return {
      formId: row.id,
      name: row.name,
      mode: row.mode as FormMode,
      views: Number(days?.views ?? 0),
      starts: Number(days?.starts ?? 0),
      completions: Number(days?.completions ?? row.responseCount),
      averagePercent:
        scores?.average === null || scores?.average === undefined
          ? null
          : Math.round(Number(scores.average)),
      passRate: graded > 0 ? Number(scores!.passed) / graded : null,
      questions,
      results: asking.results.map((result) => ({
        resultId: result.id,
        name: result.name,
        count: Number(resultCounts.find((r) => r.result_id === result.id)?.count ?? 0),
      })),
    };
  },
});

export const formQueries = [
  formList,
  formGet,
  formVersionGet,
  formCatalogs,
  formResponseList,
  formResponseGet,
  formResults,
  formResponseExport,
] as const;
