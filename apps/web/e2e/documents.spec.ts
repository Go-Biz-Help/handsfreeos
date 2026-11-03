import { expect, test } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { api, ownerWithSite, signInOwner, WORKER } from './booking-helpers';
import { codeFrom, linkFrom, waitForMail } from './helpers';

/**
 * Documents to sign (docs/documents.md), the way a business uses it.
 *
 * Part 1: a template made from a PDF in the editor (a signature placed for the customer, a line of the PDF typed
 * over), sent from the Send screen, signed on the signer's own link in a fresh browser with no session, and the
 * signed copy filed.
 *
 * Part 2: the AI places the fields on a PDF (4a), the customer signs in person on the team's screen (13a), and
 * then from their own portal, with no code to type (10b).
 */

/** A two-page lease, its second page turned on its side, as a business's PDF might be. */
async function leasePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const one = doc.addPage([612, 792]);
  one.drawText('Residential lease', { x: 72, y: 720, size: 20, font });
  one.drawText('Monthly rent: $1,800', { x: 72, y: 660, size: 12, font });
  one.drawText('Tenant signature', { x: 72, y: 200, size: 10, font });
  const two = doc.addPage([612, 792]);
  two.setRotation(degrees(90));
  two.drawText('House rules', { x: 72, y: 720, size: 14, font });
  return Buffer.from(await doc.save());
}

test('a template from a PDF is sent, signed on its link, and filed', async ({ page, browser }) => {
  const owner = await ownerWithSite(page, 'docs', 'Lone Star Leasing');
  const { workspaceId, token } = owner;
  const customer = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Maria',
    lastName: 'Garza',
    email: `maria-${Date.now()}@example.com`,
  });

  // A new template, from its PDF.
  await page.goto(`/app/w/${workspaceId}/documents?tab=templates`);
  await page.getByTestId('template-new').click();
  await page.getByTestId('template-new-file').setInputFiles({
    name: 'Lease.pdf',
    mimeType: 'application/pdf',
    buffer: await leasePdf(),
  });
  await expect(page.getByTestId('template-new-name')).toHaveValue('Lease');
  await page.getByTestId('template-new-create').click();
  await expect(page).toHaveURL(/\/documents\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('document-page-1')).toBeVisible();
  // Page two is turned, so it's drawn wider than it's tall.
  const turned = await page.getByTestId('document-page-1').boundingBox();
  expect(turned!.width).toBeGreaterThan(turned!.height);
  await expect(page.getByTestId('template-issues')).toContainText('Customer has nothing to sign');

  // A signature for the customer, near "Tenant signature".
  await page.getByTestId('tool-signature').click();
  const first = page.getByTestId('document-page-0');
  const box = (await first.boundingBox())!;
  await first.click({ position: { x: box.width * 0.4, y: box.height * 0.72 } });
  await expect(page.getByTestId('field-settings')).toBeVisible();
  await expect(first.getByTestId('field-box')).toHaveCount(1);

  // The rent typed over (answer 26c).
  await page.getByTestId('tool-words').click();
  await page.locator('[data-testid="word-run"][title*="1,800"]').first().click();
  await expect(page.getByTestId('edit-text')).toHaveValue('Monthly rent: $1,800');
  await page.getByTestId('edit-text').fill('Monthly rent: $1,950');
  await expect(first.getByText('Monthly rent: $1,950')).toBeVisible();

  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 });
  await page.getByTestId('template-send').click();

  // Sending it to Maria.
  await expect(page).toHaveURL(/\/documents\/send\?template=/);
  await page.locator('#send-about').fill('Maria');
  await page.getByTestId('money-person-Maria Garza').click();
  await expect(page.getByTestId('send-signers')).toContainText('Maria Garza');
  await page.getByTestId('send-submit').click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('document-status')).toHaveText('Out for signing');
  const documentId = /documents\/([0-9a-f-]{36})$/.exec(page.url())![1]!;

  // Maria's own link, as her email carries it.
  const got = await api<{ signers: { id: string; kind: string }[] }>(
    token,
    'queries',
    'document.get',
    {
      workspaceId,
      documentId,
    },
  );
  const signer = got.signers.find((s) => s.kind === 'signer')!;
  const { token: fresh } = await signInOwner(owner.email);
  const linkRes = await fetch(`${WORKER}/v1/documents/link`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fresh}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, signerId: signer.id }),
  });
  expect(linkRes.ok).toBe(true);
  const { url } = (await linkRes.json()) as { url: string };
  expect(url).toMatch(/\/d\/[A-Za-z0-9]+$/);

  // Signed out, she agrees, signs with her typed name, and finishes.
  const context = await browser.newContext();
  const maria = await context.newPage();
  await maria.goto(new URL(url).pathname);
  await expect(maria.getByTestId('signing-name')).toHaveText('Lease');
  await expect(maria.getByText('Monthly rent: $1,950')).toBeVisible();
  await expect(maria.getByTestId('signing-left')).toHaveText('Tick the box above to start.');
  await maria.getByTestId('signing-agree').check();
  await maria.getByTestId('signing-next').click();
  await expect(maria.getByTestId('signing-field-sheet')).toBeVisible();
  await expect(maria.getByTestId('signature-name')).toHaveValue('Maria Garza');
  await maria.getByTestId('signature-adopt').click();
  await expect(maria.getByTestId('signing-field-sheet')).toBeHidden();
  await maria.getByTestId('signing-finish').click();
  await expect(
    maria.getByTestId('signing-signed').or(maria.getByTestId('signing-completed')),
  ).toBeVisible();

  // The signed copy is made and filed; the team sees it signed.
  await expect
    .poll(
      async () =>
        (
          await api<{ status: string; signed: unknown }>(token, 'queries', 'document.get', {
            workspaceId,
            documentId,
          })
        ).status,
      { timeout: 45_000 },
    )
    .toBe('completed');
  await page.reload();
  await expect(page.getByTestId('document-status')).toHaveText('Signed');
  await expect(page.getByTestId('document-download')).toBeVisible();
  await expect(page.getByTestId('document-steps')).toContainText('Agreed to sign electronically');

  // Her link now offers the signed copy.
  await maria.reload();
  await expect(maria.getByTestId('signing-completed')).toBeVisible();
  await expect(maria.getByTestId('signing-download')).toBeVisible();
  await context.close();
  expect(customer.personId).toBeTruthy();
});

test('a link that doesn’t exist says so, signed out', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/d/abcdefghijklmnopqrstuvwxyz0123456789');
  await expect(page.getByTestId('signing-failed')).toContainText('This link doesn’t work');
  await context.close();
});

/** An agreement with its blanks drawn as underscores, the way most are typed. */
async function agreementPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const one = doc.addPage([612, 792]);
  one.drawText('SERVICE AGREEMENT', { x: 72, y: 720, size: 18, font });
  one.drawText(
    'This agreement is between the business and the Client named below, for the work described.',
    {
      x: 72,
      y: 690,
      size: 10,
      font,
    },
  );
  one.drawText('Client signature: ____________________', { x: 72, y: 200, size: 11, font });
  one.drawText('Date: ______________', { x: 72, y: 170, size: 11, font });
  return Buffer.from(await doc.save());
}

test('the AI places the fields, and the customer signs in person, then from their portal', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'docs2', 'Lone Star Leasing');
  const { workspaceId, token } = owner;
  const email = `rosa-${Date.now()}@example.com`;
  const { personId } = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Rosa',
    lastName: 'Diaz',
    email,
  });

  // A template from the PDF, its fields placed by the AI.
  await page.goto(`/app/w/${workspaceId}/documents?tab=templates`);
  await page.getByTestId('template-new').click();
  await page.getByTestId('template-new-file').setInputFiles({
    name: 'Service agreement.pdf',
    mimeType: 'application/pdf',
    buffer: await agreementPdf(),
  });
  await page.getByTestId('template-new-create').click();
  await expect(page).toHaveURL(/\/documents\/templates\/[0-9a-f-]{36}$/);
  const templateId = /templates\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByTestId('document-page-0')).toBeVisible();
  await page.getByTestId('template-place-fields').click();
  await expect(page.getByText('Placed 2 fields')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('document-page-0').getByTestId('field-box')).toHaveCount(2);
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 });
  await page.getByTestId('template-send').click();

  // Sent to Rosa, who's here with us.
  await page.locator('#send-about').fill('Rosa');
  await page.getByTestId('money-person-Rosa Diaz').click();
  await page.getByTestId('signer-in-person-customer').check();
  await page.getByTestId('send-submit').click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
  const documentPath = new URL(page.url()).pathname;
  await expect(page.getByTestId('document-signer')).toContainText('Signs with you in person');

  // Sign now: the screen is handed to her, and handed back.
  await page.getByTestId('document-sign-now').click();
  await expect(page.getByTestId('signing-hand-over')).toContainText('Hand this to Rosa');
  await page.getByTestId('signing-hand-start').click();
  await page.getByTestId('signing-agree').check();
  await page.getByTestId('signing-next').click();
  await page.getByTestId('signature-adopt').click();
  await page.getByTestId('signing-finish').click();
  await expect(page.getByTestId('signing-hand-back')).toBeVisible();
  await page.getByTestId('signing-back').click();
  await expect(page).toHaveURL(new RegExp(`${documentPath}$`));
  await expect(page.getByTestId('document-steps')).toContainText(
    'Handed over to sign in person by',
  );

  // Another, this time with a code: she signs it from her portal, where signing in was the code.
  await api(token, 'commands', 'document.send', {
    workspaceId,
    templateId,
    about: { personId },
    signers: [{ roleKey: 'customer', personId }],
    settings: { askCode: true },
  });
  const invited = Date.now();
  await api(token, 'commands', 'portal_access.give', { workspaceId, personId });
  const invite = await waitForMail(email, 'Your private portal with Lone Star Leasing', {
    after: invited,
  });
  const link = linkFrom(invite.text, /http:\/\/localhost:3000\/c\/[A-Za-z0-9_.~-]+/);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const rosa = await phone.newPage();
  await rosa.goto(link);
  const asked = Date.now();
  await rosa.getByTestId('portal-send-code').click();
  const code = codeFrom(await waitForMail(email, 'Your Lone Star Leasing code', { after: asked }));
  await rosa.getByTestId('portal-digit-0').fill(code);
  await rosa.getByTestId('portal-home-documents').click();
  await expect(rosa.getByTestId('portal-document')).toHaveCount(2);
  await rosa.getByTestId('portal-document-sign').click();
  await expect(rosa.getByTestId('signing-back')).toHaveText('Back to your portal');
  await rosa.getByTestId('signing-agree').check();
  await rosa.getByTestId('signing-next').click();
  await rosa.getByTestId('signature-adopt').click();
  await rosa.getByTestId('signing-finish').click();
  await expect(
    rosa.getByTestId('signing-signed').or(rosa.getByTestId('signing-completed')),
  ).toBeVisible();
  await rosa.getByTestId('signing-back').click();
  await expect(rosa.getByTestId('portal-documents')).toBeVisible();
  await expect(rosa.getByTestId('portal-document-sign')).toHaveCount(0);
  await phone.close();
});

test('in Safari, where a stream can’t be looped over, the AI still places the fields and the words can be typed over', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Safari has no `for await` over a stream yet, which pdf.js reads a page's words with.
  await page.addInitScript(() => {
    const proto = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    delete proto[Symbol.asyncIterator];
    delete proto.values;
  });
  const { workspaceId } = await ownerWithSite(page, 'docs3', 'Lone Star Leasing');

  await page.goto(`/app/w/${workspaceId}/documents?tab=templates`);
  await page.getByTestId('template-new').click();
  await page.getByTestId('template-new-file').setInputFiles({
    name: 'Service agreement.pdf',
    mimeType: 'application/pdf',
    buffer: await agreementPdf(),
  });
  await page.getByTestId('template-new-create').click();
  await expect(page).toHaveURL(/\/documents\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('document-page-0')).toBeVisible();
  expect(await page.evaluate(() => Symbol.asyncIterator in ReadableStream.prototype)).toBe(true);

  await page.getByTestId('template-place-fields').click();
  await expect(page.getByText('Placed 2 fields')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('tool-words').click();
  await page.locator('[data-testid="word-run"][title*="SERVICE AGREEMENT"]').first().click();
  await expect(page.getByTestId('edit-text')).toHaveValue('SERVICE AGREEMENT');
});
