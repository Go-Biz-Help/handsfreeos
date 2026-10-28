import { expect, test } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { api, ownerWithSite, signInOwner, WORKER } from './booking-helpers';

/**
 * Documents to sign (docs/documents.md), part 1, the way a business uses it: a template made from a PDF in the editor
 * (a signature placed for the customer, a line of the PDF typed over), sent from the Send screen, signed on the
 * signer's own link in a fresh browser with no session, and the signed copy filed.
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
