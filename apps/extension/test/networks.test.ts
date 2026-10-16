/**
 * The networks, a kit each (src/networks/): which ones the extension works on (on in HandsFreeOS, and allowed by
 * Chrome), LinkedIn's script registered only while both say so, and each network's warnings kept apart, so a warning
 * on one never stops another (Chris's rule, HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md).
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const signed = vi.hoisted(() => ({
  place: { userId: 'u-dana', businessId: 'b-one' } as { userId: string; businessId: string } | null,
  answered: [] as { type: string; input: Record<string, unknown> }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
}));
vi.mock('../src/hfos/session', () => ({
  savingTo: async () => signed.place,
  answer: async (ask: { type: string; input: Record<string, unknown> }) => {
    signed.answered.push(ask);
    return { ok: true, value: { repeated: false } };
  },
  api: () => ({
    POST: async (path: string, options: { body: Record<string, unknown> }) => {
      signed.posted.push({ path, body: options.body });
      return {
        data: { step: null, repeated: false, replies: [] },
        response: { ok: true, status: 200 },
      };
    },
  }),
}));

const { facebook, KIT_LIST, kitFor, kitHere, kitOf, linkedin } = await import('../src/networks');
const { isWorking, NETWORKS_KEY, networkStates } = await import('../src/networks/on');
const { scriptId, syncNetworks } = await import('../src/networks/scripts');
const { keepWarning, warnedNow, warningInput, WARNED_KEY } = await import('../src/hfos/warned');
const { looked } = await import('../src/hfos/looked');
const { notHereWords } = await import('../src/asks/run');
const { SETTINGS_KEY } = await import('../src/hfos/follow');
const { PLACE_KEY } = await import('../src/hfos/messages');
const { rememberedFor, takeNote, withSeen } = await import('../src/hfos/noting');

const store = new Map<string, unknown>();
const registered = new Map<string, chrome.scripting.RegisteredContentScript>();
let granted = false;
const today = () => new Date().toLocaleDateString('en-CA');

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((k) => store.has(k))
              .map((k) => [k, JSON.parse(JSON.stringify(store.get(k)))]),
          ),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, JSON.parse(JSON.stringify(v)));
        },
        remove: async (keys: string | string[]) => {
          for (const k of [keys].flat()) store.delete(k);
        },
      },
      session: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) =>
        granted && origins.every((o) => o === 'https://www.linkedin.com/*'),
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids }: { ids: string[] }) =>
        ids.flatMap((id) => (registered.has(id) ? [registered.get(id)!] : [])),
      registerContentScripts: async (scripts: chrome.scripting.RegisteredContentScript[]) => {
        for (const script of scripts) {
          if (registered.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`);
          registered.set(script.id, script);
        }
      },
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
        for (const id of ids) registered.delete(id);
      },
    },
  });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  store.clear();
  registered.clear();
  granted = false;
  signed.place = { userId: 'u-dana', businessId: 'b-one' };
  signed.answered.length = 0;
  signed.posted.length = 0;
  store.set(PLACE_KEY, { userId: 'u-dana', businessId: 'b-one' });
});

/** The person's settings as the extension keeps them, with LinkedIn on or off, and what the business allows. */
const settings = (
  linkedinOn: boolean,
  allowed: readonly Platform[] = ['facebook', 'linkedin'],
  userId = 'u-dana',
) => ({
  userId,
  settings: { networks: { facebook: { on: true }, linkedin: { on: linkedinOn } } },
  rules: { networksAllowed: allowed },
});

describe('a kit per network', () => {
  it('finds a tab’s network by its address alone', () => {
    expect(kitOf('https://www.facebook.com/groups/4455667788/')).toBe(facebook);
    expect(kitOf('https://www.linkedin.com/in/dana-reyes-4b2a1c/')).toBe(linkedin);
    expect(kitOf('https://accountscenter.facebook.com/info_and_permissions/dyi/')).toBeNull();
    // Accounts Center is where Facebook's work goes, for the person's file.
    expect(kitHere('https://accountscenter.facebook.com/info_and_permissions/dyi/')).toBe(facebook);
    for (const elsewhere of [
      'https://example.com/',
      'https://www.linkedin.com.example.com/',
      'chrome://extensions',
      '',
    ])
      expect(kitHere(elsewhere)).toBeNull();
    expect(KIT_LIST.map((kit) => kit.platform)).toEqual(['facebook', 'linkedin']);
    expect(kitFor('linkedin')).toBe(linkedin);
  });

  it('opens a work tab only on its own network’s pages', () => {
    expect(linkedin.workUrl('https://www.linkedin.com/in/dana-reyes-4b2a1c/')).toBe(
      'https://www.linkedin.com/in/dana-reyes-4b2a1c/',
    );
    expect(linkedin.workUrl('https://www.facebook.com/')).toBeNull();
    expect(facebook.workUrl('https://www.linkedin.com/feed/')).toBeNull();
  });

  it('starts with Facebook on from install and LinkedIn off, asked for when it’s turned on', () => {
    expect(facebook).toMatchObject({ startsOn: true, optional: false });
    expect(linkedin).toMatchObject({
      startsOn: false,
      optional: true,
      hosts: ['https://www.linkedin.com/*'],
    });
    // Each network's tabs do its own steps: LinkedIn's, the asks' since 0.40.0.
    expect(facebook.work).toBeDefined();
    expect(linkedin.work).toBeDefined();
  });
});

describe('which networks it works on', () => {
  it('is LinkedIn only while HandsFreeOS says it’s on and Chrome allows it', () => {
    const states = (on: boolean, allowed: boolean) =>
      networkStates(KIT_LIST, settings(on), 'u-dana', { linkedin: allowed });
    expect(isWorking(linkedin, states(true, true))).toBe(true);
    expect(isWorking(linkedin, states(true, false))).toBe(false);
    expect(isWorking(linkedin, states(false, true))).toBe(false);
    expect(isWorking(facebook, states(false, false))).toBe(true);
  });

  it('is LinkedIn off when the business doesn’t allow it, for someone else’s settings, or signed out', () => {
    const allowedNot = networkStates(KIT_LIST, settings(true, ['facebook']), 'u-dana', {
      linkedin: true,
    });
    expect(isWorking(linkedin, allowedNot)).toBe(false);
    const others = networkStates(KIT_LIST, settings(true, undefined, 'u-sam'), 'u-dana', {
      linkedin: true,
    });
    expect(isWorking(linkedin, others)).toBe(false);
    const signedOut = networkStates(KIT_LIST, settings(true), null, { linkedin: true });
    expect(isWorking(linkedin, signedOut)).toBe(false);
    // Facebook, as it always was, signed in or not.
    expect(isWorking(facebook, signedOut)).toBe(true);
    expect(isWorking(facebook, null)).toBe(true);
    expect(isWorking(linkedin, null)).toBe(false);
  });

  it('is Facebook off only when the person turned it off', () => {
    const off = {
      ...settings(false),
      settings: { networks: { facebook: { on: false }, linkedin: { on: false } } },
    };
    expect(isWorking(facebook, networkStates(KIT_LIST, off, 'u-dana', {}))).toBe(false);
  });
});

describe('LinkedIn’s script', () => {
  const id = scriptId(linkedin);

  it('is registered on LinkedIn’s site once both say so, and kept for the tabs and the panel', async () => {
    store.set(SETTINGS_KEY, settings(true));
    await syncNetworks();
    // Chrome hasn't allowed it: nothing runs, and the panel shows the line to allow it.
    expect(registered.has(id)).toBe(false);
    expect(store.get(NETWORKS_KEY)).toEqual({
      facebook: { on: true, allowed: true },
      linkedin: { on: true, allowed: false },
    });
    granted = true;
    await syncNetworks();
    expect(registered.get(id)).toEqual({
      id,
      matches: ['https://www.linkedin.com/*'],
      js: ['content.js'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    });
    // Twice at once registers it once.
    await Promise.all([syncNetworks(), syncNetworks()]);
    expect(registered.size).toBe(1);
  });

  it('is taken away as soon as either stops: turned off, not allowed by the business, Chrome, signed out or in as someone else', async () => {
    granted = true;
    const stops: (() => void)[] = [
      () => store.set(SETTINGS_KEY, settings(false)),
      () => store.set(SETTINGS_KEY, settings(true, ['facebook'])),
      () => (granted = false),
      () => store.delete(PLACE_KEY),
      () => store.set(PLACE_KEY, { userId: 'u-sam', businessId: 'b-one' }),
    ];
    for (const stop of stops) {
      store.set(SETTINGS_KEY, settings(true));
      granted = true;
      store.set(PLACE_KEY, { userId: 'u-dana', businessId: 'b-one' });
      await syncNetworks();
      expect(registered.has(id)).toBe(true);
      stop();
      await syncNetworks();
      expect(registered.has(id)).toBe(false);
      expect(isWorking(linkedin, store.get(NETWORKS_KEY) as never)).toBe(false);
    }
  });
});

describe('each network’s warnings, kept apart', () => {
  it('stops only the network that warned', async () => {
    expect(await keepWarning(['You’ve reached the weekly invitation limit'], 'linkedin')).toEqual([
      'You’ve reached the weekly invitation limit',
    ]);
    expect((await warnedNow('linkedin'))?.words).toEqual([
      'You’ve reached the weekly invitation limit',
    ]);
    // Facebook's runner and asks look at Facebook's alone.
    expect(await warnedNow()).toBeNull();
    // And the reverse: Facebook's leaves LinkedIn's as it was.
    await keepWarning(['You’re temporarily blocked']);
    expect((await warnedNow())?.words).toEqual(['You’re temporarily blocked']);
    expect((await warnedNow('linkedin'))?.words).toEqual([
      'You’ve reached the weekly invitation limit',
    ]);
    // The same words on the other network are news there.
    expect(await keepWarning(['You’re temporarily blocked'], 'linkedin')).toEqual([
      'You’re temporarily blocked',
    ]);
  });

  it('reads a record kept before networks as Facebook’s', async () => {
    store.set(WARNED_KEY, { day: today(), words: ['Slow down'] });
    expect((await warnedNow())?.words).toEqual(['Slow down']);
    expect(await warnedNow('linkedin')).toBeNull();
    await keepWarning(['Your account has been restricted'], 'linkedin');
    expect((await warnedNow())?.words).toEqual(['Slow down']);
  });

  it('is noted in HandsFreeOS as the network’s that showed it, with its own page', async () => {
    expect(warningInput('b-one', ['x'], 'https://www.linkedin.com/feed/', 'linkedin')).toEqual({
      workspaceId: 'b-one',
      platform: 'linkedin',
      words: ['x'],
      url: 'https://www.linkedin.com/feed/',
    });
    // Another network's page is never sent as this one's.
    expect(warningInput('b-one', ['x'], 'https://www.linkedin.com/feed/').url).toBeNull();
    await looked(
      {
        type: 'hfos-looked',
        url: 'https://www.linkedin.com/feed/',
        warnings: ['Your account has been temporarily restricted'],
        result: null,
      },
      'linkedin',
    );
    expect(signed.answered).toEqual([
      {
        type: 'hfos-warning',
        input: {
          workspaceId: 'b-one',
          platform: 'linkedin',
          words: ['Your account has been temporarily restricted'],
          url: 'https://www.linkedin.com/feed/',
        },
      },
    ]);
    expect(await warnedNow()).toBeNull();
  });
});

describe('the person’s steps on LinkedIn, noted as LinkedIn’s', () => {
  const LI = 'https://www.linkedin.com';
  const dana = {
    name: 'Dana Reyes',
    profile: { id: null, username: 'dana-reyes-4b2a1c', url: `${LI}/in/dana-reyes-4b2a1c/` },
  };
  const step = {
    kind: 'like' as const,
    to: dana,
    group: null,
    postUrl: `${LI}/feed/update/urn:li:activity:7380000000000000101/`,
    thread: null,
    replying: null,
  };
  const at = new Date().toISOString();

  it('sends each step, answer and reply a LinkedIn tab tells with platform linkedin', async () => {
    await takeNote({ type: 'hfos-noted', step, at }, 'linkedin');
    await takeNote(
      { type: 'hfos-answered', answered: { answer: 'confirm', to: dana, mutualFriends: 4 }, at },
      'linkedin',
    );
    await takeNote(
      {
        type: 'hfos-replies',
        looking: false,
        seen: [
          { name: 'Dana Reyes', threadKey: '2-MadeUpThreadDana0001==', profile: null, when: null },
        ],
      },
      'linkedin',
    );
    expect(signed.posted.map((p) => [p.path, p.body.platform])).toEqual([
      ['/v1/commands/outreach.touch.save', 'linkedin'],
      ['/v1/commands/outreach.friend.note', 'linkedin'],
      ['/v1/commands/outreach.replies.note', 'linkedin'],
    ]);
    expect(signed.posted[0]!.body).toMatchObject({
      kind: 'like',
      profile: dana.profile,
      postUrl: step.postUrl,
    });
  });

  it('never takes a group remembered from Facebook', () => {
    const fb = {
      profile: {
        id: '100003000000002',
        username: null,
        url: 'https://www.facebook.com/profile.php?id=100003000000002',
      },
      name: 'Dana Reyes',
      group: {
        id: '4455667788',
        url: 'https://www.facebook.com/groups/4455667788/',
        name: 'Makers',
      },
    };
    const groups = withSeen({}, fb, 1);
    expect(rememberedFor(groups, { ...step, to: { ...dana } }, 'linkedin')).toBeNull();
    // Facebook's, by name, as before.
    expect(
      rememberedFor(groups, { ...step, to: { name: 'Dana Reyes', profile: fb.profile } }),
    ).toEqual(fb.group);
  });
});

describe('the asks on each network', () => {
  it('goes on a network that’s on and allowed, and ends one that isn’t, saying how to turn it on', () => {
    const both = {
      facebook: { on: true, allowed: true },
      linkedin: { on: true, allowed: true },
    };
    expect(notHereWords({ platform: 'facebook' }, both)).toBeNull();
    expect(notHereWords({ platform: 'linkedin' }, both)).toBeNull();
    // A build before networks never said: Facebook's.
    expect(notHereWords({} as { platform: Platform }, both)).toBeNull();
    expect(
      notHereWords({ platform: 'linkedin' }, { ...both, linkedin: { on: false, allowed: true } }),
    ).toBe(
      'LinkedIn is off for you, so the extension does nothing on it. Turn it on under Social Outreach → Settings in HandsFreeOS, then ask again.',
    );
    expect(
      notHereWords({ platform: 'linkedin' }, { ...both, linkedin: { on: true, allowed: false } }),
    ).toBe(
      'Chrome hasn’t let the extension on LinkedIn yet. Press Allow on LinkedIn in the extension’s panel, then ask again.',
    );
  });
});
