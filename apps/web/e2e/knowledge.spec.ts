import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { addTeammate } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

const WORKER_URL = (process.env.WORKER_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
/** The stand-in website playwright.config.ts serves, which the worker may scan (FETCH_TEST_ORIGINS). */
const KNOWLEDGE_SITE = 'http://127.0.0.1:4190';
const DOC = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../worker/fixtures/knowledge-docs/${name}`, import.meta.url)),
  );

/** Three FAQs, one with its answer missing. */
const CSV = [
  'question,answer,tags',
  '"Do you work weekends?","Yes, Saturdays from 8 AM to 2 PM.",Scheduling',
  '"Is there a trip charge?","",Pricing',
  '"Do you service heat pumps?","Yes, every major brand.","Heating; Brands"',
].join('\n');

const tab = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Knowledge' }).getByRole('link', { name, exact: true });

/**
 * The knowledge base end to end: the profile and its price switch, an FAQ by hand, a CSV import with a problem
 * row, a website scan (an unreachable address first, then the stand-in site), accepting and rejecting its
 * suggestions, and Try it answering from what was accepted (the scripted model) or adding a gap.
 */
test('knowledge: profile, an FAQ, a CSV import, a website scan, suggestions and Try it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signUpAndConfirm(page, 'kb-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  // 1. From the sidebar, right after Workflows.
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav.getByRole('link')).toContainText(['Workflows', 'Knowledge', 'Tasks']);
  await nav.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/knowledge$`));
  await expect(page.getByTestId('profile-completeness')).toHaveText('0 of 7');

  // 2. The profile and tone of voice.
  await page.getByTestId('profile-edit').click();
  const form = page.getByTestId('profile-form');
  await form
    .getByLabel('Describe the business')
    .fill('Heating, cooling and roofing for Houston homes.');
  await form.getByTestId('service-add').click();
  await form.getByLabel('Service', { exact: true }).fill('AC tune-up');
  await form.getByLabel('Price', { exact: true }).fill('$89');
  await form.getByLabel('Service area').fill('Houston inside the Beltway, Katy and Bellaire');
  await form.getByLabel('Hours').fill('Mon–Fri 7 AM–6 PM, Sat 8 AM–1 PM');
  await form.getByLabel('How messages should sound').fill('Friendly, plain and neighborly');
  await form.getByLabel('Words to use').fill('neighbor');
  await form.getByLabel('Words to use').press('Enter');
  await form.getByLabel('Sign messages as').fill('– Dale at Lone Star');
  await form.getByTestId('profile-save').click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByTestId('profile-completeness')).toHaveText('6 of 7');
  await expect(page.getByTestId('profile-card')).toContainText('AC tune-up');
  await expect(page.getByTestId('tone-text')).toHaveText('Friendly, plain and neighborly');
  await expect(page.getByTestId('tone-card')).toContainText('neighbor');
  // "AI may quote prices" is off until someone turns it on.
  const prices = page.getByTestId('prices-switch');
  await expect(prices).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('prices-note')).toContainText('Off.');
  await prices.click();
  await expect(page.getByTestId('prices-note')).toContainText('On.');
  await page.reload();
  await expect(page.getByTestId('prices-switch')).toHaveAttribute('aria-checked', 'true');

  // 3. An FAQ by hand, published.
  await page.getByTestId('knowledge-add-faq').click();
  await page.getByTestId('item-title').fill('What brands do you install?');
  await page
    .getByTestId('item-body')
    .fill('Carrier, Trane and Lennox, and we service most others.');
  await page.getByLabel('Tags').fill('Brands');
  await page.getByLabel('Tags').press('Enter');
  await page.getByTestId('item-publish').click();
  await expect(page).toHaveURL(/\/knowledge\/items\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('item-status')).toHaveText('Published');
  await expect(page.getByTestId('item-source')).toContainText('Added by hand');

  // 4. The list: search shows the matching words.
  await tab(page, 'Items').click();
  const list = page.getByTestId('items-list');
  await expect(list).toContainText('What brands do you install?');
  await page.getByTestId('items-search').fill('Lennox');
  await expect(page).toHaveURL(/q=Lennox/);
  await expect(list.locator('mark')).toHaveText(['Lennox']);
  await page.getByTestId('items-search').fill('');
  await expect(page).not.toHaveURL(/q=/);

  // 5. A CSV of FAQs: the preview shows the row with a problem, and only the good ones come in.
  await page.getByTestId('import-csv').click();
  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'faqs.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  await expect(page.getByTestId('import-row')).toHaveCount(2);
  await expect(page.getByTestId('import-row-bad')).toContainText('The answer is missing.');
  await expect(page.getByTestId('import-summary')).toContainText(
    '2 FAQs ready, 1 row has a problem',
  );
  await page.getByTestId('import-go').click();
  await expect(page.getByText('Imported 2 FAQs as drafts.')).toBeVisible();
  const weekends = list.getByRole('link').filter({ hasText: 'Do you work weekends?' });
  await expect(weekends.getByTestId('item-status')).toHaveText('Draft');
  await expect(list).not.toContainText('Is there a trip charge?');

  // 6. The website: an address that can't be reached is explained in plain words.
  await tab(page, 'Website').click();
  await page.getByTestId('website-url').fill('lonestar-hvac.example');
  await page.getByTestId('scan-start').click();
  await expect(page.getByTestId('website-url')).toHaveValue('https://lonestar-hvac.example/');
  await expect(page.getByTestId('scan-failed')).toContainText('lonestar-hvac.example', {
    timeout: 60_000,
  });

  // 7. The stand-in site instead (the address itself must stay https): progress, then its suggestions.
  const res = await page.request.post(`${WORKER_URL}/test/knowledge/scan-at`, {
    data: { workspaceId, url: KNOWLEDGE_SITE },
  });
  expect(res.status(), await res.text()).toBe(200);
  await page.reload();
  await expect(page.getByTestId('scan-live').or(page.getByTestId('scan-result'))).toBeVisible();
  await expect(page.getByTestId('scan-result')).toHaveAttribute('data-scan-status', 'done', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('scan-problems')).toContainText('private address');
  await expect(page.getByTestId('suggestions-count')).toBeVisible();

  // 8. Accept one of the FAQ page's suggestions and reject another.
  await page
    .getByRole('navigation', { name: 'Pages' })
    .getByRole('button', { name: /\/faq/ })
    .click();
  const financing = page.getByTestId('suggestion').filter({ hasText: 'Do you offer financing?' });
  await financing.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('Added “Do you offer financing?” and published it.')).toBeVisible();
  await expect(financing).toHaveCount(0);
  const licensed = page
    .getByTestId('suggestion')
    .filter({ hasText: 'Are your technicians licensed?' });
  await licensed.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Rejected. Nothing was added.')).toBeVisible();
  await expect(licensed).toHaveCount(0);

  // The accepted FAQ is published and points at the page it came from.
  await tab(page, 'Items').click();
  await expect(list).toContainText('Do you offer financing?');
  await expect(list).not.toContainText('Are your technicians licensed?');
  await list.getByRole('link').filter({ hasText: 'Do you offer financing?' }).click();
  await expect(page).toHaveURL(/\/knowledge\/items\/[0-9a-f-]{36}$/);
  const editor = page.getByTestId('item-editor');
  await expect(editor.getByTestId('item-status')).toHaveText('Published');
  await expect(editor.getByTestId('item-source')).toContainText('From your website');
  await expect(editor.getByTestId('item-source-url')).toHaveAttribute(
    'href',
    `${KNOWLEDGE_SITE}/faq`,
  );

  // 9. Try it answers from what was accepted and lists the item it used.
  await tab(page, 'Overview').click();
  await page.getByTestId('try-question').fill('Do you offer financing?');
  await page.getByTestId('try-ask').click();
  await expect(page.getByTestId('try-answer')).toContainText('financed over 60 months');
  const used = page.getByTestId('try-used-item');
  await expect(used).toHaveCount(1);
  await expect(used).toContainText('Do you offer financing?');

  // 10. A question nothing answers becomes a gap, answered once from Suggestions.
  await page.getByTestId('try-question').fill('Can I pay with bitcoin?');
  await page.getByTestId('try-ask').click();
  await expect(page.getByTestId('try-gap')).toContainText('We added this to Suggestions.');
  await expect(page.getByTestId('try-used-item')).toHaveCount(0);
  await page.getByTestId('try-gap').getByRole('link', { name: 'Write the answer' }).click();
  await expect(page).toHaveURL(/\/knowledge\/suggestions\?reason=gap$/);
  const gap = page
    .getByTestId('suggestion')
    .filter({ hasText: 'Customers asked: Can I pay with bitcoin?' });
  await gap.getByTestId('gap-answer').fill('Not yet. We take cards, checks and cash.');
  await gap.getByRole('button', { name: 'Save as an FAQ' }).click();
  await expect(page.getByText('Added “Can I pay with bitcoin?” and published it.')).toBeVisible();
  await expect(gap).toHaveCount(0);
});

/** Documents: a text file becomes a draft with its text; a scanned PDF (no text in it) says so. */
test('knowledge: documents become drafts to check; a scanned PDF says it has no text', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'kb-docs');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  await page.goto(`/app/w/${workspaceId}/knowledge/documents`);
  await expect(page.getByTestId('documents-empty')).toBeVisible();
  await page.getByTestId('document-input').setInputFiles([
    {
      name: 'Warranty.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Our warranty\n\nRepairs are covered for 90 days, parts and labor.\n'),
    },
    { name: 'scanned.pdf', mimeType: 'application/pdf', buffer: DOC('scanned.pdf') },
  ]);
  const list = page.getByTestId('documents-list');
  const warranty = list.getByRole('link').filter({ hasText: 'Warranty' });
  const scanned = list.getByRole('link').filter({ hasText: 'scanned' });
  await expect(warranty).toContainText('characters', { timeout: 60_000 });
  await expect(scanned.getByTestId('document-no-text')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('document-pending')).toHaveCount(0);

  await scanned.click();
  await expect(page.getByTestId('document-empty')).toContainText('No text could be read');
  await page.goBack();
  await warranty.click();
  await expect(page.getByTestId('item-body')).toHaveValue(/Repairs are covered for 90 days/);
  await expect(page.getByTestId('item-status')).toHaveText('Draft');
  await page.getByTestId('item-publish').click();
  await expect(page.getByTestId('item-status')).toHaveText('Published');
});

/** Members read every Knowledge page and change nothing. */
test('knowledge: a member sees every page read-only', async ({ browser, page }) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'kb-lead');
  const business = 'Summit Heating & Air';
  const workspaceId = await createBusiness(page, { name: business });
  await page.goto(`/app/w/${workspaceId}/knowledge/items/new?kind=faq`);
  await page.getByTestId('item-title').fill('Do you offer financing?');
  await page.getByTestId('item-body').fill('Yes, on new systems.');
  await page.getByTestId('item-publish').click();
  await expect(page.getByTestId('item-status')).toHaveText('Published');
  const itemUrl = page.url();

  const member = await addTeammate(page, browser, workspaceId, business);
  const m = member.page;
  const base = `/app/w/${workspaceId}/knowledge`;
  await m.goto(base);
  await expect(m.getByTestId('profile-card')).toBeVisible();
  await expect(m.getByTestId('profile-edit')).toHaveCount(0);
  await expect(m.getByTestId('prices-switch')).toBeDisabled();
  await expect(m.getByTestId('knowledge-add-faq')).toHaveCount(0);
  await expect(m.getByTestId('try-it')).toContainText('Only owners and admins can try questions.');
  await expect(m.getByTestId('try-question')).toHaveCount(0);

  await m.goto(`${base}/items`);
  await expect(m.getByTestId('items-list')).toContainText('Do you offer financing?');
  await expect(m.getByTestId('import-csv')).toHaveCount(0);
  await m.goto(itemUrl);
  await expect(m.getByTestId('item-title')).toHaveAttribute('readonly', '');
  await expect(m.getByTestId('item-body')).toHaveAttribute('readonly', '');
  await expect(m.getByTestId('item-publish')).toHaveCount(0);
  await expect(m.getByTestId('item-archive')).toHaveCount(0);
  await m.goto(`${base}/items/new?kind=faq`);
  await expect(m).toHaveURL(/\/knowledge\/items$/);

  await m.goto(`${base}/profile`);
  await expect(m.getByLabel('Describe the business')).toBeDisabled();
  await expect(m.getByTestId('profile-save')).toHaveCount(0);
  await m.goto(`${base}/documents`);
  await expect(m.getByTestId('documents')).toContainText(
    'Only owners and admins can add documents.',
  );
  await expect(m.getByTestId('document-input')).toHaveCount(0);
  await m.goto(`${base}/website`);
  await expect(m.getByTestId('website-url')).toHaveAttribute('readonly', '');
  await expect(m.getByTestId('scan-start')).toHaveCount(0);
  await m.goto(`${base}/suggestions`);
  await expect(m.getByTestId('suggestions-empty')).toBeVisible();
  await member.context.close();
});
