import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { apiAs, signInForApi } from './workflow-approval-api';

/** A tiny real PNG (1×1), so Storage stores a picture. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/dYW+aQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Files on a public form (docs/forms.md, "Files on a public form"): a customer adds their shirt design on the form's
 * own page, sees it go up, is told plainly that an Illustrator file won't do, and sends it. The business opens the
 * design from the answers, and finds a copy in the customer's Files.
 */
test('a customer adds their design to the form, and the business finds it', async ({ page }) => {
  test.setTimeout(150_000);
  const owner = await signUpAndConfirm(page, 'forms-uploads');
  const workspaceId = await createBusiness(page, { name: 'Crafts-n-Things' });
  const api = apiAs(await signInForApi(owner.email));
  const created = await api<{ formId: string; revision: number; slug: string }>(
    'commands/form.create',
    { workspaceId, name: 'Custom order' },
  );
  const got = await api<{ definition: { pages: { id: string }[] } }>('queries/form.get', {
    workspaceId,
    formId: created.formId,
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
    formId: created.formId,
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
      add({
        id: 'q_phone000',
        type: 'phone',
        title: 'Your phone',
        mapTo: 'person.phone',
        config: {},
      }),
      add({
        id: 'q_design00',
        type: 'file',
        title: 'Your design',
        config: { maxFiles: 2, maxMb: 10, accept: 'document' },
      }),
    ],
  });
  await api('commands/form.publish', {
    workspaceId,
    formId: created.formId,
    baseRevision: saved.revision,
  });
  const { site } = await api<{ site: { slug: string } | null }>('queries/booking_site.get', {
    workspaceId,
  });

  await page.goto(`/f/${site!.slug}/${created.slug}`);
  await page.getByLabel('Your name').fill('Sherri');
  await page.getByLabel('Your phone').fill('(512) 555-0199');
  const box = page.getByTestId('file-input-q_design00');
  await box.setInputFiles([
    { name: 'shirt-front.png', mimeType: 'image/png', buffer: PNG },
    { name: 'shirt-back.ai', mimeType: 'application/postscript', buffer: Buffer.from('%!PS') },
  ]);
  await expect(page.getByTestId('file-added')).toContainText('shirt-front.png');
  await expect(page.getByTestId('file-refused')).toContainText(
    'shirt-back.ai is a design file this form can’t take. Save it as a PDF or a PNG and add that.',
  );
  await expect(page.getByTestId('form-send')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('form-send').click();
  await expect(page.getByTestId('form-sent')).toBeVisible();

  // The business opens it from the answers.
  await page.goto(`/app/w/${workspaceId}/forms/${created.formId}`);
  await page.getByTestId('tab-results').click();
  await page.getByRole('button', { name: 'One at a time' }).click();
  await page.getByTestId('response-row').first().click();
  await expect(page.getByTestId('response-file')).toContainText('shirt-front.png');

  // And the customer has their own copy, once the worker has put it in place.
  await expect
    .poll(
      async () => {
        const people = await api<{ items: { id: string; firstName: string }[] }>(
          'queries/person.list',
          { workspaceId, limit: 20 },
        );
        const sherri = people.items.find((p) => p.firstName === 'Sherri');
        if (!sherri) return [];
        const list = await api<{ files: { name: string }[] }>('queries/file.list', {
          workspaceId,
          recordType: 'person',
          recordId: sherri.id,
        });
        return list.files.map((f) => f.name);
      },
      { timeout: 30_000 },
    )
    .toEqual(['shirt-front.png']);
});
