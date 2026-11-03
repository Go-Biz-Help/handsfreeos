import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { api, consentToAssistant, signInOwner } from './booking-helpers';
import { createTeammate } from './ai-team';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Talking out loud, in a real browser: Chrome's stand-in microphone plays a recording of "talking" (a tone that
 * rises and falls like speech for a second and a half, then quiet, over and over), and the worker's stand-in
 * speech hears any recording as "Hello, can you hear me?" and answers each clip with a quiet WAV. So the whole
 * loop runs for real — the microphone, noticing the end of a turn, the recording going to the worker, the answer
 * played through the page's audio — without anyone speaking.
 *
 * A live test call runs the same way, streamed: the microphone goes to the worker as phone audio while it talks,
 * the stand-in hears talking and then a pause as "Hello, can you hear me?", and what the teammate says streams
 * back and plays.
 *
 * The stand-in speaks every voice, Rime's too, so a test call can try one, hear it and keep it.
 */

const HEARD = 'Hello, can you hear me?';

/** 16 kHz mono WAV: `talk` seconds of speech-like tone, then `quiet` seconds of nothing. */
function talkingWav(talk = 1.5, quiet = 3): string {
  const rate = 16_000;
  const samples = Math.round((talk + quiet) * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const syllables = 0.15 + 0.85 * Math.abs(Math.sin(2 * Math.PI * 2 * t));
    const voice = Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t);
    const v = t < talk ? 0.45 * syllables * voice : 0;
    wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 20_000))), 44 + i * 2);
  }
  const file = join(tmpdir(), `hfos-talking-${process.pid}.wav`);
  writeFileSync(file, wav);
  return file;
}

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${talkingWav()}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

test('talking out loud: a test call in the teammate’s voice, and the Assistant hands-free', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'voice-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const { token } = await signInOwner(email);
  await createTeammate(token, workspaceId);
  await consentToAssistant(email);

  // The test console: Talk out loud on a call. It says the greeting, listens, and what the caller said
  // becomes their turn, answered and said out loud, and then it listens again.
  await page.goto(`/app/w/${workspaceId}/ai-team`);
  await page.getByTestId('open-test-console').click();
  const testConsole = page.getByTestId('test-console');
  await testConsole.getByTestId('test-channel-phone').click();
  const talk = testConsole.getByTestId('test-console-talk');
  await talk.click();
  await expect(talk).toHaveAttribute('aria-pressed', 'true');
  const bar = testConsole.getByTestId('voice-bar');
  await expect(bar).toHaveAttribute('data-phase', 'idle');
  await testConsole.getByTestId('test-console-start-call').click();
  await expect(testConsole.getByTestId('test-console-reply').first()).toContainText(
    'Thanks for calling',
  );
  await expect(
    testConsole.getByTestId('test-console-chat').getByText(HEARD, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(testConsole.getByTestId('test-console-reply')).toHaveCount(2, { timeout: 30_000 });
  await expect(testConsole.getByTestId('test-console-log')).toContainText(`“${HEARD}”`);
  await expect(bar).toHaveAttribute('data-phase', /listening|hearing|thinking|speaking/);
  // Stop turns it off, and the microphone goes.
  await bar.getByTestId('voice-stop').click();
  await expect(bar).toBeHidden();
  await expect(talk).toHaveAttribute('aria-pressed', 'false');
  await testConsole.getByRole('button', { name: 'Close' }).click();

  // The Assistant: the mic listens, asks what was said (out loud), reads the answer, and listens again.
  await page.getByTestId('ask-assistant').click();
  const panel = page.getByTestId('assistant-panel');
  await panel.getByTestId('assistant-talk').click();
  const assistantBar = panel.getByTestId('voice-bar');
  await expect(assistantBar).toBeVisible();
  await expect(panel.getByTestId('assistant-question').first()).toHaveText(HEARD, {
    timeout: 30_000,
  });
  await expect(panel.getByTestId('assistant-message').first()).toHaveAttribute(
    'data-state',
    'done',
  );
  // After the answer it listens for the next question by itself.
  await expect(panel.getByTestId('assistant-question')).toHaveCount(2, { timeout: 30_000 });
  await panel.getByTestId('assistant-talk').click();
  await expect(assistantBar).toBeHidden();
});

test('a live test call from this browser: it picks up, hears the caller, answers, and hangs up', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'live-call-owner');
  const workspaceId = await createBusiness(page, { name: 'Bluebonnet Plumbing' });
  const { token } = await signInOwner(email);
  await createTeammate(token, workspaceId);

  await page.goto(`/app/w/${workspaceId}/ai-team`);
  await page.getByTestId('open-test-console').click();
  const testConsole = page.getByTestId('test-console');
  await testConsole.getByTestId('test-channel-phone').click();
  // No business number yet, so there's no phone line to pick: the call goes straight from this browser.
  await expect(testConsole.getByTestId('test-call-options')).toBeVisible();
  await expect(testConsole.getByTestId('test-call-way-phone')).toHaveCount(0);
  await testConsole.getByTestId('test-console-live-call').click();

  const bar = testConsole.getByTestId('live-call-bar');
  await expect(bar).toHaveAttribute('data-phase', 'live');
  await expect(testConsole.getByTestId('test-console-reply').first()).toContainText(
    'Thanks for calling',
  );
  // The microphone talks, then pauses: that's their turn, heard, answered out loud, and timed.
  await expect(
    testConsole.getByTestId('test-console-chat').getByText(HEARD, { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(testConsole.getByTestId('test-console-reply').nth(1)).not.toBeEmpty({
    timeout: 30_000,
  });
  await expect(
    testConsole
      .getByTestId('test-console-timing')
      .filter({ hasText: 'Where the time went' })
      .first(),
  ).toContainText('first sound', { timeout: 30_000 });
  await expect(testConsole.getByTestId('test-console-timing').first()).toContainText('Said hello');

  await bar.getByTestId('live-call-hang-up').click();
  await expect(testConsole.getByTestId('test-console-live-ended')).toContainText('The call ended.');
  await expect(bar).toBeHidden();
});

test('trying another voice on a test call: Hear it says the greeting, and Use this voice keeps it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { email } = await signUpAndConfirm(page, 'voice-pick-owner');
  const workspaceId = await createBusiness(page, { name: 'Pecan Street Plumbing' });
  const { token } = await signInOwner(email);
  await createTeammate(token, workspaceId);

  await page.goto(`/app/w/${workspaceId}/ai-team`);
  await page.getByTestId('open-test-console').click();
  const testConsole = page.getByTestId('test-console');
  await testConsole.getByTestId('test-channel-phone').click();
  const pick = testConsole.getByTestId('test-call-voice');
  await expect(pick).toHaveValue('warm');
  // Rime's voices sit beside Deepgram's; trying one leaves the settings alone.
  await pick.selectOption('rime_eyre');
  const trying = testConsole.getByTestId('test-call-voice-trying');
  await expect(trying).toContainText('Trying Eyre');
  const hear = testConsole.getByTestId('test-call-voice-hear');
  await hear.click();
  await expect(hear).toHaveAttribute('aria-pressed', 'true');
  // The stand-in's clip is a few seconds of quiet, and then it's ready to play again.
  await expect(hear).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });

  await testConsole.getByTestId('test-call-voice-use').click();
  await expect(page.getByText('Eyre is its phone voice now.')).toBeVisible();
  await expect(trying).toBeHidden();
  await expect(pick).toHaveValue('rime_eyre');
  // The builder saves it as it saves any change: calls are answered in it.
  await expect
    .poll(
      async () =>
        (
          await api<{ teammate: { config: { phone: { voice: string } } } }>(
            token,
            'queries',
            'ai_teammate.get',
            { workspaceId },
          )
        ).teammate.config.phone.voice,
      { timeout: 20_000 },
    )
    .toBe('rime_eyre');
});
