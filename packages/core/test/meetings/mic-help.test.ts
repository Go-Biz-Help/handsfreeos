/**
 * Microphone trouble in a call (docs/video-calls.md, "Microphone trouble"), without a database: which trouble a
 * browser's error is, the steps for each browser and device, what everyone else sees, and the two judges the web's
 * call screen runs on the microphone's sound.
 */
import { describe, expect, it } from 'vitest';
import {
  callDeviceOf,
  mediaHelp,
  mediaTroubleOf,
  micStateOf,
  MUTED_TALK_AGAIN_MS,
  MUTED_TALK_MS,
  mutedTalkGate,
  SILENT_MIC_MS,
  silentMicJudge,
} from '../../src/meetings/mic-help';
import { isInAppBrowser, VIDEO_CALL_ATTRIBUTES } from '../../src/meetings/video-calls';

const err = (name: string, message = '') => Object.assign(new Error(message), { name });

const UA = {
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 15; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
};

describe('which trouble a browser’s error is', () => {
  it('tells the browser’s block from the computer’s own', () => {
    expect(mediaTroubleOf(err('NotAllowedError', 'Permission denied'))).toBe('blocked');
    expect(mediaTroubleOf(err('NotAllowedError', 'Permission denied by system'))).toBe('system');
    expect(mediaTroubleOf(err('SecurityError'))).toBe('blocked');
  });

  it('knows a missing device, a busy one, and anything else', () => {
    expect(mediaTroubleOf(err('NotFoundError', 'Requested device not found'))).toBe('missing');
    expect(mediaTroubleOf(err('OverconstrainedError'))).toBe('missing');
    expect(mediaTroubleOf(err('NotReadableError', 'Could not start audio source'))).toBe('busy');
    expect(mediaTroubleOf(err('TypeError', 'Something else'))).toBe('failed');
    expect(mediaTroubleOf(undefined)).toBe('failed');
  });

  it('reads LiveKit’s own words when the browser had already said no', () => {
    expect(mediaTroubleOf(new Error('GetUserMedia Permission denied'))).toBe('blocked');
  });
});

describe('the device and browser', () => {
  it('reads computers and phones, and their browsers', () => {
    expect(callDeviceOf(UA.macChrome)).toEqual({ os: 'mac', browser: 'chrome' });
    expect(callDeviceOf(UA.macSafari)).toEqual({ os: 'mac', browser: 'safari' });
    expect(callDeviceOf(UA.winEdge)).toEqual({ os: 'windows', browser: 'edge' });
    expect(callDeviceOf(UA.winFirefox)).toEqual({ os: 'windows', browser: 'firefox' });
    expect(callDeviceOf(UA.iphoneSafari)).toEqual({ os: 'ios', browser: 'safari' });
    expect(callDeviceOf(UA.iphoneChrome)).toEqual({ os: 'ios', browser: 'chrome' });
    expect(callDeviceOf(UA.androidChrome)).toEqual({ os: 'android', browser: 'chrome' });
    expect(callDeviceOf(UA.androidSamsung)).toEqual({ os: 'android', browser: 'samsung' });
    expect(callDeviceOf(null)).toEqual({ os: 'other', browser: 'other' });
  });

  it('takes a "Mac" with a touch screen as an iPad', () => {
    expect(callDeviceOf(UA.macSafari, 5).os).toBe('ios');
    expect(callDeviceOf(UA.macSafari, 0).os).toBe('mac');
  });
});

describe('the steps', () => {
  it('sends a Mac’s system block to System Settings, naming the browser', () => {
    const help = mediaHelp('system', callDeviceOf(UA.macChrome));
    expect(help.title).toContain('Mac');
    expect(help.title).toContain('Chrome');
    expect(help.steps.join(' ')).toContain('Privacy & Security');
    expect(help.steps.join(' ')).toContain('Quit Chrome');
  });

  it('sends a Windows system block to Windows’s privacy settings', () => {
    const steps = mediaHelp('system', callDeviceOf(UA.winEdge)).steps.join(' ');
    expect(steps).toContain('Privacy & security');
    expect(steps).toContain('Let desktop apps access');
  });

  it('gives each browser’s own way to allow it', () => {
    expect(mediaHelp('blocked', callDeviceOf(UA.iphoneSafari)).steps.join(' ')).toContain(
      'Website Settings',
    );
    expect(mediaHelp('blocked', callDeviceOf(UA.iphoneChrome)).steps.join(' ')).toContain(
      'Settings app',
    );
    expect(mediaHelp('blocked', callDeviceOf(UA.androidChrome)).steps.join(' ')).toContain(
      'Permissions',
    );
    expect(mediaHelp('blocked', callDeviceOf(UA.macSafari)).steps.join(' ')).toContain(
      'Settings for This Website',
    );
    expect(mediaHelp('blocked', callDeviceOf(UA.winFirefox)).steps.join(' ')).toContain('Blocked');
    expect(mediaHelp('blocked', callDeviceOf(UA.macChrome)).steps.join(' ')).toContain(
      'left of the web address',
    );
  });

  it('names what to allow: the microphone, the camera, or both', () => {
    const mac = callDeviceOf(UA.macChrome);
    expect(mediaHelp('blocked', mac).title).toBe('Your browser is blocking your microphone');
    expect(mediaHelp('blocked', mac, ['camera']).steps.join(' ')).toContain('Turn on Camera');
    expect(mediaHelp('blocked', mac, ['camera', 'microphone']).title).toBe(
      'Your browser is blocking your camera and microphone',
    );
  });

  it('falls back to the browser’s block where only a computer could say it was the system', () => {
    const help = mediaHelp('system', callDeviceOf(UA.androidChrome));
    expect(help.title).toBe('Your browser is blocking your microphone');
  });

  it('always has something to do, in plain words', () => {
    for (const ua of Object.values(UA))
      for (const t of ['blocked', 'system', 'missing', 'busy', 'failed'] as const) {
        const help = mediaHelp(t, callDeviceOf(ua));
        expect(help.steps.length).toBeGreaterThan(0);
        expect(`${help.title} ${help.steps.join(' ')}`).not.toMatch(/'|Error|undefined/);
      }
  });
});

describe('what everyone else sees', () => {
  it('is blocked or silent, and nothing else', () => {
    expect(VIDEO_CALL_ATTRIBUTES.mic).toBe('hfos.mic');
    expect(micStateOf('blocked')).toBe('blocked');
    expect(micStateOf('silent')).toBe('silent');
    expect(micStateOf('')).toBeNull();
    expect(micStateOf('anything')).toBeNull();
    expect(micStateOf(undefined)).toBeNull();
  });
});

describe('talking while muted', () => {
  it('says so once they’ve talked for a moment, then not again for a while', () => {
    const gate = mutedTalkGate();
    expect(gate.hear(0.2, 0)).toBe(false);
    expect(gate.hear(0.2, MUTED_TALK_MS - 1)).toBe(false);
    expect(gate.hear(0.2, MUTED_TALK_MS)).toBe(true);
    // Still talking: not told again straight away.
    expect(gate.hear(0.2, MUTED_TALK_MS * 3)).toBe(false);
    // Still talking once the wait is over: told again.
    expect(gate.hear(0.2, MUTED_TALK_MS + MUTED_TALK_AGAIN_MS)).toBe(true);
  });

  it('after the wait, needs a moment of talking again', () => {
    const gate = mutedTalkGate();
    gate.hear(0.2, 0);
    expect(gate.hear(0.2, MUTED_TALK_MS)).toBe(true);
    const later = MUTED_TALK_MS * 2 + MUTED_TALK_AGAIN_MS;
    expect(gate.hear(0.001, later - 100)).toBe(false);
    expect(gate.hear(0.2, later)).toBe(false);
    expect(gate.hear(0.2, later + MUTED_TALK_MS)).toBe(true);
  });

  it('never for a quiet room or a cough', () => {
    const gate = mutedTalkGate();
    for (let t = 0; t < 5_000; t += 100) expect(gate.hear(0.005, t)).toBe(false);
    expect(gate.hear(0.3, 5_000)).toBe(false);
    expect(gate.hear(0.001, 5_100)).toBe(false);
    expect(gate.hear(0.3, 5_200)).toBe(false);
  });
});

describe('a microphone that sends nothing', () => {
  it('is silent once pure silence has gone on a while, and sound the moment anything comes', () => {
    const judge = silentMicJudge();
    expect(judge.hear(true, 0)).toBeNull();
    expect(judge.hear(true, SILENT_MIC_MS - 1)).toBeNull();
    expect(judge.hear(true, SILENT_MIC_MS)).toBe('silent');
    expect(judge.hear(true, SILENT_MIC_MS * 2)).toBeNull();
    expect(judge.hear(false, SILENT_MIC_MS * 2 + 100)).toBe('sound');
    expect(judge.hear(false, SILENT_MIC_MS * 2 + 200)).toBeNull();
  });

  it('never for a microphone that sends anything at all', () => {
    const judge = silentMicJudge();
    for (let t = 0; t < 10_000; t += 100) expect(judge.hear(t % 1000 === 0, t)).toBeNull();
  });
});

describe('apps’ own browsers', () => {
  it('spots more of the apps that can block the microphone', () => {
    expect(
      isInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30',
      ),
    ).toBe(true);
    expect(
      isInAppBrowser(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe(true);
    expect(isInAppBrowser(UA.androidChrome)).toBe(false);
    expect(isInAppBrowser(UA.iphoneChrome)).toBe(false);
  });
});
