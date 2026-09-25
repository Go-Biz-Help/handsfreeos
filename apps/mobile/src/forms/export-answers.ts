import { formAnswersCsv, formAnswersFileName, type AnswersSheet } from '@hfos/core';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { api, errorMessage, unwrap } from '@/lib/api';

import { FORM_WORDS } from './words';

/** How many answer sheets come down at a time: the most `form.response_export` gives. */
const PAGE = 500;
/** Enough for any form a small business runs. Past it, the newest are the ones worth having on a phone. */
export const EXPORT_MOST = 20_000;

/**
 * A form's answers as a spreadsheet (M17): every finished answer sheet from `form.response_export`, a page at a time,
 * made into a CSV by core's `formAnswersCsv` (the same file the web would make), put in the phone's cache and handed to
 * the share sheet — Save to Files, Drive, Mail, Numbers or Excel, whichever the person wants. Nothing is kept: the cache
 * is the phone's to clear.
 *
 * Needs signal, and says so. Resolves with how many answer sheets went in.
 */
export async function exportFormAnswers(input: {
  readonly workspaceId: string;
  readonly formId: string;
  readonly slug: string;
  readonly timeZone: string;
}): Promise<{ readonly count: number; readonly capped: boolean }> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone can’t save or share files.');

  let columns: AnswersSheet['columns'] = [];
  const rows: AnswersSheet['rows'][number][] = [];
  let cursor: string | null = null;
  try {
    do {
      const page: {
        columns: AnswersSheet['columns'];
        rows: AnswersSheet['rows'];
        nextCursor: string | null;
      } = unwrap(
        await api.POST('/v1/queries/form.response_export', {
          body: {
            workspaceId: input.workspaceId,
            formId: input.formId,
            limit: PAGE,
            ...(cursor ? { cursor } : {}),
          },
        }),
      );
      // Every page carries the same columns; the last one's are as good as any.
      columns = page.columns;
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor && rows.length < EXPORT_MOST);
  } catch (e) {
    throw new Error(e instanceof TypeError ? FORM_WORDS.exportNeedsSignal : errorMessage(e));
  }

  const capped = cursor !== null;
  const kept = rows.slice(0, EXPORT_MOST);
  const file = new File(Paths.cache, formAnswersFileName(input.slug, Date.now(), input.timeZone));
  if (file.exists) file.delete();
  file.create();
  file.write(formAnswersCsv({ columns, rows: kept }, input.timeZone));
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: FORM_WORDS.exportTitle,
  });
  return { count: kept.length, capped };
}
