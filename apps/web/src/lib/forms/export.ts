import { formAnswersCsv, formAnswersFileName, type AnswersSheet } from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';

/**
 * A form's answers as a spreadsheet, downloaded (M17): every finished answer sheet from `form.response_export`, a page
 * of 500 at a time, made into one CSV by core's `formAnswersCsv` — the same file the phone makes — and handed to the
 * browser as a download. Resolves with how many answer sheets went in.
 */
export async function downloadFormAnswers(input: {
  readonly workspaceId: string;
  readonly formId: string;
  readonly slug: string;
  readonly timeZone: string;
}): Promise<number> {
  let columns: AnswersSheet['columns'] = [];
  const rows: AnswersSheet['rows'][number][] = [];
  let cursor: string | null = null;
  do {
    const page: {
      columns: AnswersSheet['columns'];
      rows: AnswersSheet['rows'];
      nextCursor: string | null;
    } = unwrap(
      await apiBrowser().POST('/v1/queries/form.response_export', {
        body: {
          workspaceId: input.workspaceId,
          formId: input.formId,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        },
      }),
    );
    // Every page carries the same columns.
    columns = page.columns;
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);

  const csv = formAnswersCsv({ columns, rows }, input.timeZone);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = formAnswersFileName(input.slug, Date.now(), input.timeZone);
  a.click();
  URL.revokeObjectURL(url);
  return rows.length;
}
