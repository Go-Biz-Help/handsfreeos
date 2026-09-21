import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { fakeCallSid, postVoice, setUpTexting, twimlParameters } from './telephony';

const MIKE = '+17135550142';

/** The stand-in device the app uses with the fake carrier (apps/web/src/lib/calls/fake-device.ts). */
interface FakeVoice {
  ring(params: Record<string, string>): void;
  digits: string[];
  outgoing: Record<string, string>[];
}
const fakeVoice = (page: Page) => ({
  ring: (params: Record<string, string>) =>
    page.evaluate(
      (p) => (window as unknown as { __hfosVoice: FakeVoice }).__hfosVoice.ring(p),
      params,
    ),
  digits: () =>
    page.evaluate(() => (window as unknown as { __hfosVoice: FakeVoice }).__hfosVoice.digits),
  outgoing: () =>
    page.evaluate(() => (window as unknown as { __hfosVoice: FakeVoice }).__hfosVoice.outgoing),
});

/** The voice token names the workspace's subaccount (sub) and the identity this browser rings as. */
function claimsOf(token: string): { sub: string; grants: { identity: string } } {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
    sub: string;
    grants: { identity: string };
  };
}

/**
 * The worker settles a call a moment after Twilio reports it; a page that loaded in that moment missed the
 * live update, so reload until the timeline shows it.
 */
async function seeOnTimeline(page: Page, testId: string, text: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId(testId)).toContainText(text, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Calls end to end with the fake carrier: this browser rings for a customer's call, answers, keeps the call
 * while moving around, hangs up; a missed call leaves a voicemail with its words; then a call to Mike from
 * his page, with the business number as the caller ID. The carrier's side is posted to the worker, signed.
 */
test('calls: ring, answer, move around, hang up, voicemail, and call a customer', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'calls-owner');
  const workspaceId = await createBusiness(page, { name: 'Calls Test HVAC' });
  const business = await setUpTexting(page, workspaceId);

  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Phone').fill('(713) 555-0142');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  const customerUrl = page.url();

  // The worker out of reach: the calls control stays, says why on hover, and asks again when pressed.
  await page.route('**/v1/telephony/voice-token', (route) => route.abort());
  await page.goto(`/app/w/${workspaceId}/inbox`);
  const unavailable = page.getByTestId('calls-unavailable');
  await expect(unavailable).toContainText('Calls unavailable');
  await expect(unavailable).toHaveAttribute('title', /not reachable/);
  await page.unroute('**/v1/telephony/voice-token');

  // Back within reach: turn calls on in this browser.
  const tokenResponse = page.waitForResponse(
    (r) => r.url().endsWith('/v1/telephony/voice-token') && r.ok(),
  );
  await unavailable.click();
  const { token } = (await (await tokenResponse).json()) as { token: string };
  const {
    sub: accountSid,
    grants: { identity },
  } = claimsOf(token);
  await page.getByTestId('calls-enable').click();
  await expect(page.getByTestId('calls-ready')).toContainText('Calls ring in this browser');

  // Mike calls: the worker's TwiML rings this browser, and the card says who it is.
  const callSid = fakeCallSid();
  const inbound = {
    AccountSid: accountSid,
    CallSid: callSid,
    From: MIKE,
    To: business,
    CallStatus: 'ringing',
    Direction: 'inbound',
  };
  const twiml = await postVoice('inbound', inbound);
  expect(twiml).toContain(`<Identity>${identity}</Identity>`);
  await fakeVoice(page).ring(twimlParameters(twiml));
  const card = page.getByRole('alertdialog', { name: 'Incoming call' });
  await expect(card).toContainText('Mike Johnson');
  await expect(card).toContainText('Incoming call · Calls Test HVAC');
  await page.getByTestId('call-answer').click();
  await expect(card).toBeHidden();

  // The bar keeps the call while moving around the app: mute, a keypad tone, hang up.
  const bar = page.getByRole('region', { name: 'Call in progress' });
  await expect(bar).toContainText('Mike Johnson');
  await expect(bar.getByTestId('call-status')).toHaveText(/^0:0\d$/);
  await page.locator('aside').getByRole('link', { name: 'Customers' }).click();
  await expect(page).toHaveURL(/\/customers/);
  await expect(bar).toBeVisible();
  await bar.getByTestId('call-mute').click();
  await expect(bar.getByTestId('call-status')).toContainText('muted');
  await bar.getByTestId('call-keypad-toggle').click();
  await page.getByTestId('call-keypad').getByRole('button', { name: '5', exact: true }).click();
  expect(await fakeVoice(page).digits()).toContain('5');
  await bar.getByTestId('call-hang-up').click();
  await expect(bar).toBeHidden();
  await expect(page.getByText('Call saved to Mike’s timeline').first()).toBeVisible();

  // Twilio's report of that call: this browser took it and they talked for 14 seconds.
  const browserLeg = fakeCallSid();
  const leg = { AccountSid: accountSid, CallSid: browserLeg, ParentCallSid: callSid, From: MIKE };
  await postVoice('leg-status', { ...leg, CallStatus: 'in-progress', To: `client:${identity}` });
  await postVoice('leg-status', {
    ...leg,
    CallStatus: 'completed',
    CallDuration: '14',
    To: `client:${identity}`,
  });
  await postVoice('status', { ...inbound, CallStatus: 'completed', CallDuration: '19' });
  await page.goto(customerUrl);
  await seeOnTimeline(
    page,
    'timeline-call-answered',
    'Mike Johnson called · 0:14 · you answered in the browser',
  );

  // Nobody answers the next one: the greeting, a voicemail, and its words.
  const missedSid = fakeCallSid();
  const missed = { ...inbound, CallSid: missedSid };
  await postVoice('inbound', missed);
  expect(await postVoice('dial-result', { ...missed, DialCallStatus: 'no-answer' })).toContain(
    '<Record',
  );
  const recordingSid = fakeCallSid().replace(/^CA/, 'RE');
  await postVoice('recording', {
    AccountSid: accountSid,
    CallSid: missedSid,
    RecordingSid: recordingSid,
    RecordingStatus: 'completed',
    RecordingDuration: '32',
  });
  await postVoice('status', { ...missed, CallStatus: 'completed', CallDuration: '45' });
  await seeOnTimeline(page, 'timeline-call-voicemail', 'Mike Johnson left a voicemail · 0:32');
  // The words are nobody's webhook any more. Storing the recording queues `call.transcribe`
  // (apps/worker/src/processors/twilio-voice.ts), which asks the transcriber for them — so they arrive a
  // moment after the row does, and this waits rather than looking once.
  await seeOnTimeline(page, 'timeline-call-voicemail', 'Give me a call back when you can');

  // In the conversation it sits with a player; it plays.
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await page.getByTestId('conversation-list').getByText('Mike Johnson').click();
  const voicemail = page.getByTestId('message-log').locator('[data-kind="voicemail"]');
  await expect(voicemail).toContainText('Missed call · left a voicemail');
  await expect(voicemail).toContainText('“Hey, it’s Mike on Main Street.');
  await voicemail.getByRole('button', { name: 'Play voicemail' }).click();
  await expect(voicemail.getByRole('button', { name: 'Pause voicemail' })).toBeVisible();

  // Calling Mike from his page: the dialog names the caller ID, the bar says "Calling…" until he picks up.
  await page.goto(customerUrl);
  await page.getByTestId('action-call-customer').click();
  const dialog = page.getByRole('dialog', { name: 'Call Mike Johnson' });
  await expect(dialog).toContainText('Caller ID: Calls Test HVAC');
  await dialog.getByTestId('dialer-call').click();
  await expect(bar.getByTestId('call-status')).toHaveText('Calling…');
  await expect(bar.getByTestId('call-status')).toHaveText(/^0:0\d$/, { timeout: 5_000 });
  const [placed] = await fakeVoice(page).outgoing();
  expect(placed).toMatchObject({ To: MIKE });

  // Twilio's side: the TwiML app dials Mike from the business number, and they talk for 30 seconds.
  const outboundSid = fakeCallSid();
  const dial = await postVoice('outbound', {
    AccountSid: accountSid,
    CallSid: outboundSid,
    From: `client:${identity}`,
    To: MIKE,
    CallId: placed!['CallId']!,
  });
  expect(dial).toContain(`<Dial callerId="${business}"`);
  const customerLeg = {
    AccountSid: accountSid,
    CallSid: fakeCallSid(),
    ParentCallSid: outboundSid,
    From: business,
    To: MIKE,
  };
  await postVoice('leg-status', { ...customerLeg, CallStatus: 'in-progress' });
  await postVoice('leg-status', { ...customerLeg, CallStatus: 'completed', CallDuration: '30' });
  await bar.getByTestId('call-hang-up').click();
  await expect(bar).toBeHidden();
  await seeOnTimeline(page, 'timeline-call-outbound', 'called · 0:30');
});
