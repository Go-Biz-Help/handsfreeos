import { expect, test, type Page } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { formWithAnswers } from './forms';
import {
  confirmEmail,
  createBusiness,
  linkFrom,
  signUp,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';
import { setUpTexting, textFromCustomer, TINY_PNG_BYTES } from './telephony';

/**
 * Search everything's page, `/search#q=…` (design/search, boards 2, 3 and 4), reached by its address: Search 9 links
 * it from the side menu's box. What's typed lives after `#`, so the web's own server never sees it; the page asks
 * the API from the browser. Then what each new kind of result opens onto: a message in its thread, a task, a form's
 * answers, a note, a file on its record, the text composer, the merge dialog, an item in the Deleted bin, and a new
 * contact with what was typed as the name.
 */

type Json = Record<string, unknown>;

/**
 * The kinds an owner may look in that found nothing for “smith”, in kind order: a member's are the same, but for the
 * Deleted bin, which neither names (the owner's has Kai Smith in it, and a member can't look there).
 */
const NOTHING_IN_FOR_SMITH =
  'Nothing in Money, Messages, Calendar, Tasks, Files, Forms, Knowledge and Settings.';

/** Every request the browser sends the web's own server, whole: address, body and headers. */
function webRequests(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).port === '3000')
      sent.push(`${r.url()} ${r.postData() ?? ''} ${JSON.stringify(r.headers())}`.toLowerCase());
  });
  return sent;
}

test('the Search page by its address: cards, one kind with its banner, the odd states, and nothing typed reaches the web’s server', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { email } = await signUpAndConfirm(page, 'search-page');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const { token } = await signInOwner(email);
  const run = <T = Json>(name: string, input: Json) =>
    api<T>(token, 'commands', name, { workspaceId, ...input });

  // Dana Abbott, a client (her lead was won), first: the oldest, so only Name A–Z puts her first.
  const abbott = await run<{ personId: string }>('person.create', {
    firstName: 'Dana',
    lastName: 'Abbott',
  });
  const drain = await run<{ leadId: string }>('lead.create', {
    title: 'Drain cleaning',
    personId: abbott.personId,
  });
  const { pipelines } = await api<{
    pipelines: { isDefault: boolean; stages: { id: string; kind: string }[] }[];
  }>(token, 'queries', 'pipeline.list', { workspaceId });
  const won = pipelines.find((p) => p.isDefault)!.stages.find((st) => st.kind === 'won')!;
  await run('lead.move_stage', { leadId: drain.leadId, stageId: won.id });
  const dana = await run<{ personId: string }>('person.create', {
    firstName: 'Dana',
    lastName: 'Smith',
    phone: '(504) 555-0142',
    email: 'dana.smith@gmail.com',
  });
  // A second Dana Smith on the same number, as a web form and a phone call would leave: the banner's pair.
  const dana2 = await run<{ personId: string }>('person.create', {
    firstName: 'Dana',
    lastName: 'Smith',
    phone: '504 555 0142',
    ignoreDuplicates: true,
  });
  const marcus = await run<{ personId: string }>('person.create', {
    firstName: 'Marcus',
    lastName: 'Smith',
    phone: '(504) 555-0188',
  });
  await run('company.create', { name: 'Smithfield Property Mgmt' });
  await run('lead.create', {
    title: 'Water heater swap',
    personId: dana.personId,
    valueCents: 245000,
  });
  await run('task.create', { title: 'Call Marcus about the permit', personId: marcus.personId });
  await run('activity.log', {
    kind: 'note',
    body: 'Gate code 4471, dog in the yard',
    personId: dana.personId,
  });
  // Tom Becnel archived, and another Tom Becnel in the Deleted bin: board 4's "someone archived or deleted".
  const tom = await run<{ personId: string }>('person.create', {
    firstName: 'Tom',
    lastName: 'Becnel',
  });
  await run('person.archive', { personId: tom.personId });
  const gone = await run<{ personId: string }>('person.create', {
    firstName: 'Tom',
    lastName: 'Becnel',
    ignoreDuplicates: true,
  });
  await run('person.delete', { personIds: [gone.personId] });
  // A Smith in the Deleted bin too: the bin has its own card, and isn't among the kinds that found nothing.
  const kai = await run<{ personId: string }>('person.create', {
    firstName: 'Kai',
    lastName: 'Smith',
  });
  await run('person.delete', { personIds: [kai.personId] });
  // More than one page of one kind.
  for (let i = 1; i <= 51; i++)
    await run('person.create', { firstName: 'Zed', lastName: `Pool ${i}` });

  const sent = webRequests(page);
  await page.goto(`/app/w/${workspaceId}/search#q=smith`);
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
  await expect(
    page.getByText('Everything in Bayou Plumbing Co. you’re allowed to see.'),
  ).toBeVisible();
  await expect(page.getByTestId('search-page-input')).toHaveValue('smith');
  await expect(page.getByTestId('search-results-for')).toContainText('results for “smith”');

  // A card for each kind found, in kind order, and the kinds list with their counts.
  const contacts = page.getByTestId('search-card-contacts');
  await expect(contacts.getByTestId('search-row-contacts')).toHaveCount(3);
  await expect(contacts).toContainText('Marcus Smith');
  await expect(contacts.locator('mark').first()).toHaveText(/smith/i);
  await expect(page.getByTestId('search-card-companies')).toContainText('Smithfield Property Mgmt');
  // The lead and the note are found by the name of who they're on (decision 34).
  await expect(page.getByTestId('search-card-leads')).toContainText('Water heater swap');
  await expect(page.getByTestId('search-card-notes')).toContainText(
    'Gate code 4471, dog in the yard',
  );
  await expect(page.getByTestId('search-kind-contacts')).toContainText('3');
  await expect(page.getByTestId('search-kind-bin')).toContainText('1');
  await expect(page.getByTestId('search-card-bin')).toContainText('Kai Smith');
  await expect(page.getByTestId('search-nothing-in')).toHaveText(NOTHING_IN_FOR_SMITH);

  // A phone typed with its punctuation finds both Danas on it.
  await page.getByTestId('search-page-input').fill('504.555.0142');
  await expect(
    page.getByTestId('search-card-contacts').getByTestId('search-row-contacts'),
  ).toHaveCount(2);

  // Typing goes into the address after `#`, a moment after it stops.
  await page.getByTestId('search-page-input').fill('dana');
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/search#q=dana$`));
  await expect(
    page.getByTestId('search-card-contacts').getByTestId('search-row-contacts'),
  ).toHaveCount(3);

  // One kind: the Danas told apart in a table, with All · Leads · Clients, Sort, and the banner.
  await page.getByTestId('search-only-contacts').click();
  await expect(page).toHaveURL(/#q=dana&kind=contacts$/);
  await expect(page.getByTestId('search-kind-title')).toHaveText('3 contacts named “dana”');
  const rows = page.getByTestId('search-contacts-table').getByTestId('search-row-contacts');
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('search-standing-all')).toHaveText('All 3');
  await expect(page.getByTestId('search-standing-leads')).toHaveText('Leads 2');
  await expect(page.getByTestId('search-standing-clients')).toHaveText('Clients 1');
  await expect(page.getByTestId('search-kind-footer')).toHaveText('Showing all 3');
  await page.getByTestId('search-sort').selectOption('name');
  await expect(page).toHaveURL(/#q=dana&kind=contacts&sort=name$/);
  await expect(rows.nth(0)).toContainText('Dana Abbott');
  await expect(rows.nth(1)).toContainText('Dana Smith');
  await expect(rows.nth(2)).toContainText('Dana Smith');
  await page.getByTestId('search-standing-leads').click();
  await expect(page).toHaveURL(/&show=leads$/);
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('search-contacts-table')).not.toContainText('Dana Abbott');
  await expect(page.getByTestId('search-duplicates')).toContainText(
    'Two Dana Smiths share the number (504) 555-0142. They may be the same person.',
  );
  await page.getByTestId('search-standing-clients').click();
  await expect(page).toHaveURL(/&show=clients$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Dana Abbott');
  await page.getByTestId('search-standing-all').click();
  await expect(rows).toHaveCount(3);
  // Compare and merge opens one of them with Merge open and the other already chosen, then leaves the address.
  await page.getByTestId('search-compare').click();
  await expect(page).toHaveURL(
    new RegExp(`/customers/people/(${dana.personId}|${dana2.personId})$`),
  );
  await expect(page.getByTestId('merge-keep')).toContainText('Dana Smith');
  await expect(page.getByTestId('merge-dup')).toContainText('Dana Smith');
  await page.keyboard.press('Escape');

  // A kind with more than a page: 50 at a time, and Show 50 more reads the rest.
  await page.goto(`/app/w/${workspaceId}/search#q=zed%20pool&kind=contacts`);
  await expect(page.getByTestId('search-kind-footer')).toContainText('Showing 50 of 51');
  await page.getByTestId('search-kind-more').click();
  await expect(page.getByTestId('search-kind-footer')).toHaveText('Showing all 51');
  await expect(
    page.getByTestId('search-contacts-table').getByTestId('search-row-contacts'),
  ).toHaveCount(51);

  // Nothing found: what to try, and Add a contact with what was typed as the name, carried after `#`.
  await page.goto(`/app/w/${workspaceId}/search#q=zxqv`);
  await expect(page.getByTestId('search-empty')).toContainText('No matches for “zxqv”');
  await expect(page.getByTestId('search-empty')).toContainText(
    'Check the spelling, or try a phone number, an email or a street.',
  );
  await page.getByTestId('search-add-contact').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/customers$`));
  await expect(page.getByLabel('First name')).toHaveValue('zxqv');
  await page.keyboard.press('Escape');
  // Already on Contacts, as the box will be: the fragment changes, and the dialog opens again.
  await expect(page.getByLabel('First name')).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = 'add=person&name=qwerty';
  });
  await expect(page.getByLabel('First name')).toHaveValue('qwerty');
  await page.keyboard.press('Escape');

  // Nobody active: the archived Tom under Archived, the deleted one under the Deleted bin, which opens it ringed.
  await page.goto(`/app/w/${workspaceId}/search#q=tom%20becnel`);
  await expect(page.getByTestId('search-results')).toContainText(
    'No one active matches “tom becnel”.',
  );
  await expect(page.getByTestId('search-card-archived')).toContainText('Tom Becnel');
  await expect(page.getByTestId('search-card-archived')).toContainText(
    'Restore from the record’s menu',
  );
  const bin = page.getByTestId('search-card-bin');
  await expect(bin).toContainText('Gone for good in');
  await bin.getByTestId('search-row-bin').click();
  await expect(page).toHaveURL(new RegExp(`/settings/deleted-bin\\?item=[0-9a-f-]{36}$`));
  await expect(page.getByTestId(`bin-item-${gone.personId}`)).toHaveClass(/ring-2/);

  // None of it reached the web's own server: only the API, in a request's body.
  for (const typed of ['smith', 'dana', 'zed', 'zxqv', 'becnel', '555.0142'])
    expect(sent.filter((s) => s.includes(typed))).toEqual([]);

  // A member can't look in the Deleted bin: no card for it, and it isn't named among the kinds that found nothing.
  const mate = uniqueEmail('search-member');
  const started = Date.now();
  await api(token, 'commands', 'membership.invite', { workspaceId, email: mate, role: 'member' });
  const mail = await waitForMail(mate, 'invited you to Bayou Plumbing Co.', { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const mem = await ctx.newPage();
  await signUp(mem, { name: 'Priya Natarajan', email: mate });
  await confirmEmail(mem, mate);
  await mem.goto(link);
  await mem.getByTestId('accept-invite').click();
  await expect(mem).toHaveURL(new RegExp(`/app/w/${workspaceId}`), { timeout: 45_000 });
  await mem.goto(`/app/w/${workspaceId}/search#q=smith`);
  await expect(mem.getByTestId('search-card-contacts')).toContainText('Marcus Smith');
  await expect(mem.getByTestId('search-nothing-in')).toHaveText(NOTHING_IN_FOR_SMITH);
  await expect(mem.getByTestId('search-card-bin')).toHaveCount(0);
  await expect(mem.getByTestId('search-kind-bin')).toHaveCount(0);
  await ctx.close();
});

test('what results open onto: a message in its thread, a task, a form’s answers, a note, a file, and the text sheet', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const { workspaceId, formId, email } = await formWithAnswers(page, 'search-opens');
  const { token } = await signInOwner(email);
  const run = <T = Json>(name: string, input: Json) =>
    api<T>(token, 'commands', name, { workspaceId, ...input });

  // A thread longer than its first page, whose oldest message holds the word: it opens there, ringed.
  const number = await setUpTexting(page, workspaceId);
  await textFromCustomer({
    from: '+15045550199',
    to: number,
    body: 'The porch light flickers in the rain, zebrawood door',
  });
  for (let i = 1; i <= 32; i++)
    await textFromCustomer({ from: '+15045550199', to: number, body: `Following up, note ${i}` });

  // The worker takes each text in turn: search once the last one is in.
  const message = page.getByTestId('search-card-messages').getByTestId('search-row-messages');
  await expect(async () => {
    await page.goto(`/app/w/${workspaceId}/search#q=note%2032`);
    await expect(message).toContainText('note 32', { timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await page.goto(`/app/w/${workspaceId}/search#q=zebrawood`);
  await expect(message).toContainText('zebrawood');
  await message.click();
  await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}\?message=[0-9a-f-]{36}&at=/);
  const messageId = new URL(page.url()).searchParams.get('message')!;
  const opened = page.getByTestId(`message-${messageId}`);
  await expect(opened).toContainText('zebrawood');
  await expect(opened).toHaveClass(/ring-2/);
  // Everything after it came too, the newest included: all 33.
  const log = page.getByTestId('message-log');
  await expect(log).toContainText('Following up, note 32');
  await expect(log.locator('[data-testid^="message-"][data-direction="inbound"]')).toHaveCount(33);

  // A task opens in its dialog on the Tasks page, whoever it's for; closing it leaves the list.
  await run('task.create', { title: 'Replace the anode rod', assigneeUserId: null });
  await page.goto(`/app/w/${workspaceId}/search#q=anode`);
  await page.getByTestId('search-card-tasks').getByTestId('search-row-tasks').click();
  await expect(page).toHaveURL(/\/tasks\?task=[0-9a-f-]{36}$/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Task')).toHaveValue('Replace the anode rod');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/tasks$`));
  // Closing it says nothing went wrong, and nor does an ordinary visit to Tasks.
  const gone = page.getByText('That task isn’t there anymore');
  await page.waitForTimeout(1_000);
  await expect(gone).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/tasks`);
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(gone).toHaveCount(0);

  // A form answer opens the form's Results with that person's answers showing.
  await page.goto(`/app/w/${workspaceId}/search#q=fixed%20it`);
  await page.getByTestId('search-card-forms').getByTestId('search-row-forms').click();
  await expect(page).toHaveURL(new RegExp(`/forms/${formId}\\?response=[0-9a-f-]{36}$`));
  await expect(page.getByRole('dialog')).toContainText('Late, but fixed it');

  // A note opens over its customer's timeline.
  const kim = await run<{ personId: string }>('person.create', {
    firstName: 'Kim',
    lastName: 'Le',
    phone: '(504) 555-0163',
  });
  await run('activity.log', {
    kind: 'note',
    body: 'Slab leak likely, under the kitchen',
    personId: kim.personId,
  });
  await page.goto(`/app/w/${workspaceId}/search#q=slab%20leak`);
  await page.getByTestId('search-card-notes').getByTestId('search-row-notes').click();
  await expect(page).toHaveURL(
    new RegExp(`/customers/people/${kim.personId}\\?activity=[0-9a-f-]{36}$`),
  );
  await expect(page.getByTestId('opened-activity')).toHaveText(
    'Slab leak likely, under the kitchen',
  );
  const activityId = new URL(page.url()).searchParams.get('activity')!;
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/customers/people/${kim.personId}$`));
  // A result for the page already open, as the box will offer: the address changes, the page stays, the note opens.
  await page.evaluate((id) => window.history.pushState(null, '', `?activity=${id}`), activityId);
  await expect(page.getByTestId('opened-activity')).toHaveText(
    'Slab leak likely, under the kitchen',
  );
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/customers/people/${kim.personId}$`));

  // A file opens its customer's Files with its card ringed.
  await page.getByTestId('action-file').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'inspection-report.png',
    mimeType: 'image/png',
    buffer: TINY_PNG_BYTES,
  });
  await expect(page.getByTestId('file-grid')).toContainText('inspection-report.png');
  await page.goto(`/app/w/${workspaceId}/search#q=inspection`);
  await page.getByTestId('search-card-files').getByTestId('search-row-files').click();
  await expect(page).toHaveURL(
    new RegExp(`/customers/people/${kim.personId}\\?tab=files&file=[0-9a-f-]{36}$`),
  );
  const fileId = new URL(page.url()).searchParams.get('file')!;
  await expect(page.getByTestId(`file-tile-${fileId}`)).toHaveClass(/ring-2/);

  // Text on a contact opens the record's text sheet.
  await page.goto(`/app/w/${workspaceId}/customers/people/${kim.personId}?compose=sms`);
  await expect(page.getByTestId('message-sheet')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/customers/people/${kim.personId}$`));
});
