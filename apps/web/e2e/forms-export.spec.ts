import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { apiAs, signInForApi } from './workflow-approval-api';

/**
 * A form's answers as a spreadsheet on the web (M17): the owner opens Results and presses Export to CSV, and the
 * browser downloads one file with a row per answer sheet under a column per question — Excel's byte-order mark first,
 * a comma kept inside its quotes, and a customer's `=1+1` kept as text rather than run as a formula.
 *
 * The form and its answers are made through the API (`form_response.record`, as the phone fills one in), so the spec
 * is about the export and not the editor.
 */
test('exports every answer to a CSV the browser downloads', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await signUpAndConfirm(page, 'forms-csv');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const api = apiAs(await signInForApi(owner.email));

  const created = await api<{ formId: string; revision: number; slug: string }>(
    'commands/form.create',
    { workspaceId, name: 'Job feedback', mode: 'survey' },
  );
  const { formId } = created;
  const got = await api<{ definition: { pages: { id: string }[] } }>('queries/form.get', {
    workspaceId,
    formId,
  });
  const pageId = got.definition.pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const saved = await api<{ revision: number }>('commands/form.save_draft', {
    workspaceId,
    formId,
    baseRevision: created.revision,
    ops: [
      add({
        id: 'q_name0000',
        type: 'short_text',
        title: 'Your name',
        required: true,
        mapTo: 'person.first_name',
        config: {},
      }),
      // The form needs a way to reach them (identity "required", the default).
      add({
        id: 'q_phone000',
        type: 'phone',
        title: 'Your phone',
        mapTo: 'person.phone',
        config: {},
      }),
      add({
        id: 'q_rating00',
        type: 'rating',
        title: 'How did we do?',
        config: { max: 5, icon: 'star' },
      }),
      add({ id: 'q_notes000', type: 'long_text', title: 'Anything else?', config: {} }),
    ],
  });
  await api('commands/form.publish', { workspaceId, formId, baseRevision: saved.revision });

  const answer = (name: string, phone: string, rating: number, notes: string) =>
    api('commands/form_response.record', {
      workspaceId,
      formId,
      answers: { q_name0000: name, q_phone000: phone, q_rating00: rating, q_notes000: notes },
    });
  await answer('Rosa', '(512) 555-0301', 5, 'Late, but fixed it');
  await answer('Tom', '(512) 555-0302', 4, '=1+1');

  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  await page.getByTestId('tab-results').click();
  const downloading = page.waitForEvent('download');
  await page.getByTestId('form-export-csv').click();
  const download = await downloading;

  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^${created.slug}-answers-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
  );
  const csv = readFileSync((await download.path())!, 'utf8');
  // Excel reads the file as UTF-8 only with the byte-order mark first.
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).split('\r\n');
  expect(lines[0]).toBe('Answered,Name,From,Your name,Your phone,How did we do?,Anything else?');
  expect(lines).toHaveLength(4); // the heading, two answer sheets, and the line end after the last
  expect(lines[3]).toBe('');
  const rows = lines.slice(1, 3);
  for (const row of rows) expect(row).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},/);
  // Filled in the way the phone fills one in, so each says it came from the phone app.
  const rosa = rows.find((r) => r.includes(',Rosa,'))!;
  expect(rosa).toContain(',Phone app,Rosa,');
  expect(rosa).toMatch(/,5,"Late, but fixed it"$/);
  const tom = rows.find((r) => r.includes(',Tom,'))!;
  expect(tom).toMatch(/,4,'=1\+1$/);
});
