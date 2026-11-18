import { expect, test } from '@playwright/test';
import { formWithAnswers } from './forms';

/**
 * The add menu's First name and Last name boxes, and an address question's Google address search (docs/forms.md,
 * "Name boxes, and Google address search"). The name boxes are short answers saved as the customer's name, and the
 * browser is told what they are. Google is stood in for in the page, so the spec needs no key: typing a street shows
 * its suggestions in the form's flow, and picking one fills the street, town, state and ZIP.
 */
test('adds name boxes and an address that searches Google', async ({ page }) => {
  test.setTimeout(150_000);
  // Google's Maps script, stood in for: one suggestion for whatever is typed, with the parts Places (New) hands back.
  await page.addInitScript(() => {
    const parts = [
      { types: ['street_number'], longText: '1500', shortText: '1500' },
      { types: ['route'], longText: 'Marilla Street', shortText: 'Marilla St' },
      { types: ['locality', 'political'], longText: 'Dallas', shortText: 'Dallas' },
      { types: ['administrative_area_level_1', 'political'], longText: 'Texas', shortText: 'TX' },
      { types: ['postal_code'], longText: '75201', shortText: '75201' },
    ];
    const prediction = {
      text: { text: '1500 Marilla St, Dallas, TX, USA' },
      mainText: { text: '1500 Marilla St' },
      secondaryText: { text: 'Dallas, TX, USA' },
      toPlace: () => {
        const place: Record<string, unknown> = {
          fetchFields: async ({ fields }: { fields: string[] }) => {
            if (fields.includes('addressComponents')) place.addressComponents = parts;
          },
        };
        return place;
      },
    };
    (window as unknown as { google: unknown }).google = {
      maps: {
        Map: function Map() {},
        places: {
          AutocompleteSessionToken: function Token() {},
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: async () => ({
              suggestions: [{ placePrediction: prediction }],
            }),
          },
        },
      },
    };
  });

  const { workspaceId, formId } = await formWithAnswers(page, 'forms-name-address');
  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  const rows = page.getByTestId('question-row');

  // First name and Last name from the menu: short answers saved as the customer's name.
  await page.getByTestId('add-question').click();
  await page.getByRole('menuitem', { name: 'First name', exact: true }).click();
  await expect(page.locator('#q-map')).toHaveValue('person.first_name');
  await page.getByTestId('add-question').click();
  await page.getByRole('menuitem', { name: 'Last name', exact: true }).click();
  await expect(page.locator('#q-map')).toHaveValue('person.last_name');
  await expect(rows.filter({ hasText: 'Last name' })).toHaveCount(1);

  // An address, with Google's address search turned on.
  await page.getByTestId('add-question').click();
  await page.getByRole('menuitem', { name: 'Address', exact: true }).click();
  const search = page.getByTestId('question-address-search');
  await expect(search).toHaveAttribute('aria-checked', 'false');
  await search.click();
  await expect(search).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 });

  // Kept once it's saved.
  await page.reload();
  await rows.filter({ hasText: 'Your address' }).getByRole('button').first().click();
  await expect(page.getByTestId('question-address-search')).toHaveAttribute('aria-checked', 'true');

  // The preview is the public page: the browser is told the name boxes are names, and the street searches.
  await page.getByTestId('tab-preview').click();
  const preview = page.getByTestId('form-preview');
  await expect(preview.getByLabel('First name')).toHaveAttribute('autocomplete', 'given-name');
  await expect(preview.getByLabel('Last name')).toHaveAttribute('autocomplete', 'family-name');
  const street = preview.getByRole('combobox', { name: 'Street' });
  await street.pressSequentially('1500 Mar');
  const suggestions = preview.getByTestId('form-address-suggestions');
  await expect(suggestions).toContainText('Dallas, TX, USA');
  await expect(suggestions).toContainText('Google Maps');
  await suggestions.getByRole('option', { name: /1500 Marilla St/ }).click();
  await expect(street).toHaveValue('1500 Marilla St');
  await expect(preview.getByLabel('Town')).toHaveValue('Dallas');
  await expect(preview.getByLabel('State')).toHaveValue('TX');
  await expect(preview.getByLabel('Postcode')).toHaveValue('75201');
  await expect(suggestions).toHaveCount(0);
});
