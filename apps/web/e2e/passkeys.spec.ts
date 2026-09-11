import { expect, test } from '@playwright/test';
import { createBusiness, signOut, signUpAndConfirm } from './helpers';

test('register a passkey, sign in with it, then remove it', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await signUpAndConfirm(page, 'passkey');
  const id = await createBusiness(page, { name: 'Passkey Co' });
  await page.goto(`/app/w/${id}/settings`);
  await page.getByTestId('passkey-add').click();
  await expect(page.getByTestId('passkey-row')).toHaveCount(1);
  const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(creds.credentials).toHaveLength(1);

  await signOut(page);
  await page.getByTestId('passkey-sign-in').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${id}`));

  await page.goto(`/app/w/${id}/settings`);
  await page.getByTestId('passkey-remove').click();
  await page.getByTestId('passkey-remove-confirm').click();
  await expect(page.getByTestId('passkey-row')).toHaveCount(0);
});
