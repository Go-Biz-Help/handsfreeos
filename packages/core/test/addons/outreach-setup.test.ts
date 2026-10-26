/**
 * Social Outreach's setup, in HandsFreeOS (docs/outreach.md, decisions 36, 45 and 83): the main setup's steps and each
 * network's, where each stands worked out from facts, where it opens and what's next, the extension's link as a business
 * setting, and each person's own on the database: who's a first-timer, what the extension signing in does and doesn't
 * count as, and what the steps show.
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { withNetwork } from '../../src/addons/outreach/network-words';
import {
  extensionLinkProblem,
  OutreachSettingsSchema,
  outreachSettings,
  settingsToSave,
} from '../../src/addons/outreach/chat-read';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { READY_ITEMS, type ReadyState } from '../../src/addons/outreach/readiness';
import {
  bannerWords,
  businessStates,
  isFirstTime,
  networkSteps,
  networkStepStates,
  outreachPath,
  outreachSetupPath,
  readSetupStop,
  setupNext,
  setupOpenAt,
  setupStepStates,
  setupSteps,
  showsSetupBanner,
  startBlocker,
  startFix,
  stopAfter,
  stopBefore,
  SETUP_WORDS,
  whenWords,
  type NetworkFacts,
  type SetupFacts,
  type SetupOutput,
} from '../../src/addons/outreach/setup';
import { outreachBusiness, refused, runAs, setOutreach } from './outreach-fixture';

const admin = () => testDbs().admin.db;

const items = (state: ReadyState) =>
  READY_ITEMS.map((item) => ({ item, state, left: state === 'done' ? null : `${item} left` }));
const net = (
  platform: NetworkFacts['platform'],
  more: Partial<NetworkFacts> = {},
): NetworkFacts => ({
  platform,
  allowed: platform === 'facebook',
  ready: items('todo'),
  sending: 'off',
  started: false,
  ...more,
});
const facts = (more: Partial<SetupFacts> = {}): SetupFacts => ({
  canManage: true,
  extensionAt: null,
  settingsSaved: false,
  rulesSaved: false,
  video: false,
  noVideo: false,
  ready: items('todo'),
  networks: [net('facebook')],
  ...more,
});
const laid = (f: SetupFacts) => ({
  states: setupStepStates(f),
  networks: f.networks.map((n) => ({ platform: n.platform, steps: networkStepStates(f, n) })),
  business: businessStates(f),
});
const stateOf = (f: SetupFacts) =>
  Object.fromEntries(setupStepStates(f).map((s) => [s.step, s.state]));
/** Everything done on the main setup and Facebook, as an owner. */
const allDone = facts({
  extensionAt: '2026-10-21T10:00:00Z',
  settingsSaved: true,
  rulesSaved: true,
  noVideo: true,
  ready: items('done'),
  networks: [net('facebook', { ready: items('done'), sending: 'steps', started: true })],
});

describe('the setup’s steps', () => {
  it('has the business’s part only for owners and admins, then the computer and them', () => {
    // The networks before the goal, which counts every one of them (decision 88).
    expect(setupSteps(true)).toEqual([
      'offer',
      'playbook',
      'video',
      'rules',
      'extension',
      'messages',
      'networks',
      'numbers',
    ]);
    expect(setupSteps(false)).toEqual(['extension', 'messages', 'networks', 'numbers']);
    expect(networkSteps('facebook')).toEqual(['profile', 'choices', 'start']);
    expect(networkSteps('instagram')).toEqual(['allow', 'playbook', 'profile', 'choices', 'start']);
  });

  it('works out each main step from facts, never from how far they clicked', () => {
    expect(Object.values(stateOf(facts())).every((s) => s === 'todo')).toBe(true);
    expect(
      stateOf(
        facts({
          extensionAt: '2026-10-21T10:00:00Z',
          rulesSaved: true,
          settingsSaved: true,
          ready: items('done'),
        }),
      ),
    ).toEqual({
      offer: 'done',
      playbook: 'done',
      video: 'todo',
      rules: 'done',
      extension: 'done',
      messages: 'done',
      numbers: 'done',
      networks: 'done',
    });
    // The video holds nobody up: done once linked or once the business says it doesn't use one.
    expect(setupStepStates(facts()).find((s) => s.step === 'video')).toMatchObject({
      optional: true,
      left: SETUP_WORDS.left.video,
    });
    expect(stateOf(facts({ video: true })).video).toBe('done');
    expect(stateOf(facts({ noVideo: true })).video).toBe('done');
    // A playbook with its niche on another network the person works counts too.
    const onLinkedIn = facts({
      networks: [
        net('facebook'),
        net('linkedin', {
          ready: items('todo').map((r) => (r.item === 'playbook' ? { ...r, state: 'done' } : r)),
        }),
      ],
    });
    expect(stateOf(onLinkedIn).playbook).toBe('done');
    // The main offer changed: look at the messages again.
    const again = items('done').map((r) =>
      r.item === 'messages' ? { ...r, state: 'look_again' as const } : r,
    );
    expect(stateOf(facts({ ready: again })).messages).toBe('again');
  });

  it('shows a member the business’s part as theirs to wait on, and their messages waiting on it', () => {
    const member = facts({ canManage: false });
    expect(stateOf(member)).toEqual({
      extension: 'todo',
      messages: 'waiting',
      numbers: 'todo',
      networks: 'todo',
    });
    expect(businessStates(member)).toEqual([
      { item: 'offer', state: 'waiting' },
      { item: 'playbook', state: 'waiting' },
    ]);
    const ready = facts({ canManage: false, ready: items('done') });
    expect(businessStates(ready).every((b) => b.state === 'done')).toBe(true);
    expect(stateOf(ready).messages).toBe('done');
    expect(businessStates(facts())).toEqual([]);
  });

  it('works out each network’s steps: Chrome’s Allow, a playbook there, the profile, the choices and a day', () => {
    const states = (f: SetupFacts, n: NetworkFacts) =>
      Object.fromEntries(networkStepStates(f, n).map((s) => [s.step, s.state]));
    const linkedin = net('linkedin');
    expect(states(facts(), linkedin)).toEqual({
      allow: 'todo',
      playbook: 'todo',
      profile: 'todo',
      choices: 'todo',
      start: 'todo',
    });
    // Allow needs the extension in first, and says so.
    expect(networkStepStates(facts(), { ...linkedin, allowed: true })[0]).toMatchObject({
      state: 'todo',
      left: SETUP_WORDS.left.extensionFirst,
    });
    const signedIn = facts({ extensionAt: '2026-10-21T10:00:00Z', settingsSaved: true });
    expect(
      states(signedIn, { ...linkedin, allowed: true, ready: items('done'), sending: 'steps' }),
    ).toEqual({ allow: 'done', playbook: 'done', profile: 'done', choices: 'done', start: 'todo' });
    // Doing everything themselves there isn't a choice that starts a day; nor is a choice they never saved.
    expect(states(signedIn, { ...linkedin, sending: 'off' }).choices).toBe('todo');
    expect(states(facts(), { ...linkedin, sending: 'steps' }).choices).toBe('todo');
    expect(states(signedIn, net('facebook', { started: true })).start).toBe('done');
  });

  it('goes to the next step left, skipping the optional video and anything waiting on an owner', () => {
    expect(setupNext(laid(facts()))).toEqual({ net: null, step: 'offer' });
    const businessDone = facts({ ready: items('done').map((r) => r), rulesSaved: true });
    expect(setupNext(laid(businessDone))).toEqual({ net: null, step: 'extension' });
    expect(setupNext(laid(facts({ canManage: false })))).toEqual({ net: null, step: 'extension' });
    const mainDone = facts({
      extensionAt: '2026-10-21T10:00:00Z',
      settingsSaved: true,
      rulesSaved: true,
      ready: items('done'),
      networks: [net('facebook'), net('linkedin')],
    });
    expect(setupNext(laid(mainDone))).toEqual({ net: 'facebook', step: 'profile' });
    expect(setupNext(laid(allDone))).toBeNull();
    // After a step: the next one not done, which may be the optional video; Back is the one before.
    expect(stopAfter({ net: null, step: 'playbook' }, laid(facts()))).toEqual({
      net: null,
      step: 'video',
    });
    expect(stopAfter({ net: null, step: 'networks' }, laid(mainDone))).toEqual({
      net: 'facebook',
      step: 'profile',
    });
    // The goal comes after the networks while it's left: it counts each one turned on.
    expect(stopAfter({ net: null, step: 'messages' }, laid(facts()))).toEqual({
      net: null,
      step: 'networks',
    });
    expect(stopAfter({ net: null, step: 'networks' }, laid(facts()))).toEqual({
      net: null,
      step: 'numbers',
    });
    expect(SETUP_WORDS.networksNext(['Facebook', 'LinkedIn'], true)).toBe(
      'Next: your goal, then set up Facebook and LinkedIn. About 5 minutes each. Turn on more any time on the Settings tab.',
    );
    expect(SETUP_WORDS.networksNext(['Facebook'])).toMatch(/^Next: set up Facebook\./);
    expect(stopAfter({ net: 'facebook', step: 'start' }, laid(allDone))).toBe('done');
    expect(stopBefore({ net: null, step: 'offer' }, laid(facts()))).toBe('welcome');
    expect(stopBefore({ net: 'facebook', step: 'profile' }, laid(facts()))).toEqual({
      net: null,
      step: 'numbers',
    });
  });

  it('opens where the person got to', () => {
    const open = (
      f: SetupFacts,
      asked: ReturnType<typeof readSetupStop>,
      startedAt: string | null = '2026-10-21T09:00:00Z',
      again = false,
    ) => setupOpenAt({ ...laid(f), startedAt, finishedAt: null }, asked, again);
    // Not started: the welcome, before the steps; asked for, it opens any time.
    expect(open(facts(), null, null)).toBe('welcome');
    expect(open(allDone, 'welcome')).toBe('welcome');
    expect(open(facts(), null)).toEqual({ net: null, step: 'offer' });
    // A step of theirs asked for opens, done or not; one that isn't theirs goes to the next step left.
    expect(open(facts(), { net: null, step: 'numbers' })).toEqual({ net: null, step: 'numbers' });
    expect(open(facts({ canManage: false }), { net: null, step: 'rules' })).toEqual({
      net: null,
      step: 'extension',
    });
    expect(open(facts(), { net: 'linkedin', step: 'allow' })).toEqual({ net: null, step: 'offer' });
    expect(open(allDone, null)).toBe('done');
    // Set up again: the step asked for, or the first.
    expect(open(allDone, null, null, true)).toEqual({ net: null, step: 'offer' });
    expect(open(allDone, { net: 'facebook', step: 'choices' }, null, true)).toEqual({
      net: 'facebook',
      step: 'choices',
    });
  });

  it('reads its address, the old setup’s steps as what they became', () => {
    expect(readSetupStop('extension', null)).toEqual({ net: null, step: 'extension' });
    expect(readSetupStop('allow', 'linkedin')).toEqual({ net: 'linkedin', step: 'allow' });
    expect(readSetupStop('welcome', null)).toBe('welcome');
    expect(readSetupStop('playbooks', null)).toEqual({ net: null, step: 'playbook' });
    expect(readSetupStop('ready', null)).toEqual({ net: null, step: 'messages' });
    expect(readSetupStop('settings', null)).toEqual({ net: null, step: 'networks' });
    expect(readSetupStop('groups', null)).toEqual({ net: 'facebook', step: 'start' });
    expect(readSetupStop('allow', 'myspace')).toBeNull();
    expect(readSetupStop('nope', null)).toBeNull();
  });

  it('builds its address', () => {
    const ws = '11111111-1111-4111-8111-111111111111';
    expect(outreachSetupPath(ws)).toBe(`/app/w/${ws}/a/outreach/setup`);
    expect(outreachSetupPath(ws, { step: { net: null, step: 'extension' } })).toBe(
      `/app/w/${ws}/a/outreach/setup?step=extension`,
    );
    expect(outreachSetupPath(ws, { step: { net: 'linkedin', step: 'allow' } })).toBe(
      `/app/w/${ws}/a/outreach/setup?net=linkedin&step=allow`,
    );
    expect(outreachSetupPath(ws, { step: 'welcome' })).toBe(
      `/app/w/${ws}/a/outreach/setup?step=welcome`,
    );
    expect(outreachSetupPath(ws, { again: true })).toBe(`/app/w/${ws}/a/outreach/setup?again=1`);
    expect(outreachSetupPath(ws, { from: 'extension' })).toBe(
      `/app/w/${ws}/a/outreach/setup?from=extension`,
    );
    // And each view's, which the extension's links use.
    expect(outreachPath(ws, 'live')).toBe(`/app/w/${ws}/a/outreach?view=live`);
    // The old tabs open what they became (decision 59).
    expect(outreachPath(ws, 'activity')).toBe(`/app/w/${ws}/a/outreach?view=results`);
    expect(outreachPath(ws, 'waiting')).toBe(`/app/w/${ws}/a/outreach?view=today`);
    expect(outreachPath(ws, 'friends', { show: 'requests' })).toBe(
      `/app/w/${ws}/a/outreach?view=friends&show=requests`,
    );
  });

  it('says what’s in the way of a first day, and where a refusal is fixed', () => {
    expect(startBlocker(laid(allDone), 'facebook')).toBeNull();
    // The video never is.
    expect(startBlocker(laid({ ...allDone, noVideo: false }), 'facebook')).toBeNull();
    expect(startBlocker(laid(facts()), 'facebook')).toEqual({
      stop: { net: null, step: 'offer' },
      state: 'todo',
      left: 'offer left',
    });
    expect(startBlocker(laid(facts({ canManage: false })), 'facebook')).toEqual({
      stop: null,
      state: 'waiting',
      left: SETUP_WORDS.left.offerWaiting,
    });
    const choices = {
      ...allDone,
      networks: [net('facebook', { ready: items('done'), sending: 'off' })],
    };
    expect(startBlocker(laid(choices), 'facebook')).toEqual({
      stop: { net: 'facebook', step: 'choices' },
      state: 'todo',
      left: SETUP_WORDS.left.choices('Facebook'),
    });
    expect(startFix('outreach_sending_off', 'linkedin')).toEqual({
      net: 'linkedin',
      step: 'choices',
    });
    expect(startFix('outreach_network_off', 'linkedin')).toEqual({ net: null, step: 'networks' });
    expect(startFix('outreach_warned_today', 'linkedin')).toBeNull();
  });

  it('says what’s next on the tabs', () => {
    expect(bannerWords(laid(facts()), { net: null, step: 'offer' })).toBe(
      'Next: Main offer · 0 of 8 done.',
    );
    const linkedin = {
      ...allDone,
      networks: [...allDone.networks, net('linkedin', { allowed: false })],
    };
    expect(bannerWords(laid(linkedin), { net: 'linkedin', step: 'allow' })).toBe(
      'Next: set up LinkedIn · 0 of 5 done.',
    );
    expect(SETUP_WORDS.bannerWorking(['Facebook'])).toBe('Facebook is working.');
  });

  it('says when, in the business’s time zone, around midnight there', () => {
    const chicago = 'America/Chicago';
    // 11:50 PM in Austin on Oct 9 is already Oct 10 in UTC.
    const lateThere = '2026-10-10T04:50:00Z';
    expect(whenWords(lateThere, Date.parse('2026-10-10T04:55:00Z'), chicago)).toBe('at 11:50 PM');
    expect(whenWords(lateThere, Date.parse('2026-10-10T05:10:00Z'), chicago)).toBe('on Oct 9');
    expect(whenWords(lateThere, Date.parse('2026-10-10T05:10:00Z'), 'UTC')).toBe('at 4:50 AM');
  });

  it('says who’s a first-timer and who’s reminded of what’s next', () => {
    const none = { startedAt: null, finishedAt: null, bannerHiddenAt: null };
    expect(isFirstTime(null, false)).toBe(true);
    // A row the extension made by signing in isn't a start.
    expect(isFirstTime({ ...none }, false)).toBe(true);
    expect(isFirstTime({ ...none, startedAt: new Date() }, false)).toBe(false);
    expect(isFirstTime(null, true)).toBe(false);
    expect(showsSetupBanner(null, false, true)).toBe(true);
    // Someone who saved theirs long ago and never started isn't reminded.
    expect(showsSetupBanner(null, true, true)).toBe(false);
    expect(showsSetupBanner({ ...none, startedAt: new Date() }, true, true)).toBe(true);
    expect(
      showsSetupBanner({ ...none, startedAt: new Date(), bannerHiddenAt: new Date() }, true, true),
    ).toBe(false);
    // Nothing left, nothing to say.
    expect(showsSetupBanner({ ...none, startedAt: new Date() }, true, false)).toBe(false);
  });
});

describe('the extension’s link', () => {
  it('takes only an https link to the zip', () => {
    const ok = OutreachSettingsSchema.parse({
      extensionLink: 'https://files.example.test/social.zip',
    });
    expect(ok.extensionLink).toBe('https://files.example.test/social.zip');
    expect(OutreachSettingsSchema.parse({}).extensionLink).toBeNull();
    for (const bad of [
      'http://files.example.test/social.zip',
      'javascript:alert(1)',
      'social zip',
      'https:foo',
      'https:alert(1)',
    ]) {
      const got = OutreachSettingsSchema.safeParse({ extensionLink: bad });
      expect(got.success).toBe(false);
      expect(got.error?.issues[0]?.path).toEqual(['extensionLink']);
    }
  });

  it('reads a bad stored link as none, and keeps the other settings as saved', () => {
    const read = outreachSettings({
      extensionLink: 'http://old.example.test/x.zip',
      morningPushHour: 7,
    });
    expect(read.extensionLink).toBeNull();
    expect(read.morningPushHour).toBe(7);
  });

  it('saves the other settings over a stored link that stopped passing, which goes', () => {
    const stored = { extensionLink: 'http://old.example.test/x.zip', morningPushHour: 7 };
    const saving = settingsToSave(stored, { weeklyReport: false });
    expect(saving).toMatchObject({ extensionLink: null, morningPushHour: 7, weeklyReport: false });
    expect(OutreachSettingsSchema.safeParse(saving).success).toBe(true);
    // A screen that sends the stored settings back as they are would be refused over the link.
    expect(OutreachSettingsSchema.safeParse({ ...stored, weeklyReport: false }).success).toBe(
      false,
    );
  });

  it('says why a link won’t pass before it’s sent, in the save’s words', () => {
    expect(extensionLinkProblem('https://files.example.test/social.zip')).toBeNull();
    expect(extensionLinkProblem('  ')).toBeNull();
    expect(extensionLinkProblem('http://files.example.test/social.zip')).toBe(
      'That isn’t a whole link starting https://. Paste the https link to the extension’s zip.',
    );
    expect(extensionLinkProblem(`https://files.example.test/${'a'.repeat(500)}.zip`)).toBe(
      'That link is too long. Give a shorter link to the extension’s zip.',
    );
  });
});

describe('each person’s setup', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outsu-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outsu-member', { fullName: 'Riley Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Setup Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
  }, 60_000);
  afterAll(closeTestDbs);

  it('starts a new person as a first-timer, with their own steps, each to do', async () => {
    const mine: SetupOutput = await runAs(owner, ws, 'outreach.setup', {});
    expect(mine).toMatchObject({
      steps: [
        'offer',
        'playbook',
        'video',
        'rules',
        'extension',
        'messages',
        'networks',
        'numbers',
      ],
      business: [],
      networks: [{ platform: 'facebook' }],
      next: { net: null, step: 'offer' },
      reached: null,
      firstTime: true,
      banner: true,
      settingsSaved: false,
      canManage: true,
      sendingAllowedMore: true,
      extensionLink: null,
      noVideo: false,
      playbooks: [],
      groups: { mine: 0, business: 0 },
    });
    expect(mine.states.every((s) => s.state === 'todo')).toBe(true);
    expect(mine.networks[0]!.steps.map((s) => s.step)).toEqual(['profile', 'choices', 'start']);
    const theirs: SetupOutput = await runAs(member, ws, 'outreach.setup', {});
    expect(theirs).toMatchObject({
      steps: ['extension', 'messages', 'networks', 'numbers'],
      business: [
        { item: 'offer', state: 'waiting' },
        { item: 'playbook', state: 'waiting' },
      ],
      next: { net: null, step: 'extension' },
      firstTime: true,
      canManage: false,
    });
    expect(theirs.states.find((s) => s.step === 'messages')?.state).toBe('waiting');
  });

  it('doesn’t count the extension signing in as starting, and ticks its step', async () => {
    const signed: SetupOutput = await runAs(member, ws, 'outreach.setup.save', { extension: true });
    expect(signed.extensionAt).not.toBeNull();
    expect(signed).toMatchObject({ firstTime: true, startedAt: null, reached: null });
    expect(signed.states.find((s) => s.step === 'extension')?.state).toBe('done');
    await runAs(member, ws, 'outreach.setup.save', { extension: true });
    const events = await rows<{ entity_type: string; payload: Record<string, unknown> }>(
      admin(),
      sql`select entity_type, payload from app.events
          where workspace_id = ${ws} and event_type = 'outreach.setup.saved' order by created_at`,
    );
    expect(events.map((e) => [e.entity_type, e.payload.firstSignIn])).toEqual([
      ['outreach_setup', true],
      ['outreach_setup', false],
    ]);
    // The first is broadcast, so the setup open in another tab ticks; a sign-in again changes nothing anyone sees.
    expect(events.map((e) => e.payload._broadcast)).toEqual([undefined, false]);
  });

  it('still keeps an old tab’s furthest step, only ever forward, and deciding nothing', async () => {
    const one = await runAs(owner, ws, 'outreach.setup.save', { reached: 'playbooks' });
    expect(one).toMatchObject({ reached: 'playbooks', firstTime: false });
    expect(one.startedAt).not.toBeNull();
    await runAs(owner, ws, 'outreach.setup.save', { reached: 'extension' });
    const back: SetupOutput = await runAs(owner, ws, 'outreach.setup.save', {
      reached: 'settings',
    });
    expect(back.reached).toBe('extension');
    expect(back.states.find((s) => s.step === 'extension')?.state).toBe('todo');
    expect(back.finishedAt).toBeNull();
    const done = await runAs(owner, ws, 'outreach.setup.save', { finished: true });
    expect(done.finishedAt).not.toBeNull();
    // Riley's is their own.
    const riley = await runAs(member, ws, 'outreach.setup', {});
    expect(riley).toMatchObject({ reached: null, finishedAt: null });
    expect(await refused(runAs(owner, ws, 'outreach.setup.save', {}))).toBe('validation');
    expect(
      await refused(runAs(owner, ws, 'outreach.setup.save', { reached: 'networks-new' })),
    ).toBe('validation');
  });

  it('ticks the team’s rules once kept or changed, and the video once the business says it doesn’t use one', async () => {
    const before: SetupOutput = await runAs(owner, ws, 'outreach.setup', {});
    expect(before.states.find((s) => s.step === 'rules')?.state).toBe('todo');
    // The install's starting rules, stored as they are, aren't kept rules.
    const starting = (await runAs(owner, ws, 'addon.settings', { addonId: 'outreach' })).settings;
    await runAs(owner, ws, 'addon.save_settings', {
      addonId: 'outreach',
      settings: settingsToSave(starting, { rules: outreachSettings(starting).rules }),
    });
    const still: SetupOutput = await runAs(owner, ws, 'outreach.setup', {});
    expect(still.states.find((s) => s.step === 'rules')?.state).toBe('todo');
    const stored = (await runAs(owner, ws, 'addon.settings', { addonId: 'outreach' })).settings;
    await runAs(owner, ws, 'addon.save_settings', {
      addonId: 'outreach',
      settings: settingsToSave(stored, { rulesKept: true, noVideo: true }),
    });
    const after: SetupOutput = await runAs(owner, ws, 'outreach.setup', {});
    expect(after.states.find((s) => s.step === 'rules')?.state).toBe('done');
    expect(after.states.find((s) => s.step === 'video')?.state).toBe('done');
    expect(after.noVideo).toBe(true);
  });

  it('stops sending someone who left it for later, and hides the reminder when asked', async () => {
    const later = await runAs(member, ws, 'outreach.setup.save', { started: true });
    expect(later).toMatchObject({ firstTime: false, reached: null, banner: true });
    const hidden = await runAs(member, ws, 'outreach.setup.save', { hideBanner: true });
    expect(hidden.banner).toBe(false);
  });

  it('counts someone’s own saved settings, not ones an owner saved for them', async () => {
    const other = await createTestUser('outsu-other', { fullName: 'Dana Reyes' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: other.id, role: 'member' });
    await runAs(owner, ws, 'outreach.automation.save', {
      userId: other.id,
      settings: AUTOMATION_DEFAULTS,
    });
    expect(await runAs(other, ws, 'outreach.setup', {})).toMatchObject({
      settingsSaved: false,
      firstTime: true,
    });
    await runAs(other, ws, 'outreach.automation.save', {
      settings: withNetwork(AUTOMATION_DEFAULTS, 'linkedin', { on: true }),
    });
    const saved: SetupOutput = await runAs(other, ws, 'outreach.setup', {});
    expect(saved).toMatchObject({ settingsSaved: true, firstTime: false, banner: false });
    expect(saved.states.find((s) => s.step === 'networks')?.state).toBe('done');
    // LinkedIn turned on gets its own short setup, after Facebook's; Chrome hasn't allowed it on any computer yet.
    expect(saved.networks.map((n) => n.platform)).toEqual(['facebook', 'linkedin']);
    expect(saved.networks[1]!.steps.map((s) => [s.step, s.state])).toEqual([
      ['allow', 'todo'],
      ['playbook', 'waiting'],
      ['profile', 'todo'],
      ['choices', 'todo'],
      ['start', 'todo'],
    ]);
    // An owner changing them afterwards doesn't make them a first-timer again.
    await runAs(owner, ws, 'outreach.automation.save', {
      userId: other.id,
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
    });
    expect(await runAs(other, ws, 'outreach.setup', {})).toMatchObject({
      settingsSaved: true,
      firstTime: false,
      banner: false,
    });
    // Nor does it count as the owner choosing their own.
    const theOwner = await runAs(owner, ws, 'outreach.setup', {});
    expect(theOwner.settingsSaved).toBe(false);
  });

  it('keeps both of two saves at once', async () => {
    const both = await createTestUser('outsu-both', { fullName: 'Riley Both' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: both.id, role: 'member' });
    await runAs(both, ws, 'outreach.setup.save', { reached: 'settings' });
    await Promise.all([
      runAs(both, ws, 'outreach.setup.save', { extension: true }),
      runAs(both, ws, 'outreach.setup.save', { reached: 'groups', finished: true }),
      runAs(both, ws, 'outreach.setup.save', { started: true, reached: 'playbooks' }),
    ]);
    const got = await runAs(both, ws, 'outreach.setup', {});
    expect(got.reached).toBe('groups');
    expect(got.finishedAt).not.toBeNull();
    expect(got.extensionAt).not.toBeNull();
    expect(got.startedAt).not.toBeNull();
  });

  it('lets each person read and write only their own, on the database', async () => {
    await runAs(owner, ws, 'outreach.setup.save', { started: true });
    const seen = await asUser(testDbs().api.db, member.claims, (tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select user_id from addon_outreach.setup where workspace_id = ${ws}`,
      ),
    );
    expect(seen.map((r) => r.user_id)).toEqual([member.id]);
    const changed = await asUser(testDbs().api.db, member.claims, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`update addon_outreach.setup set finished_at = now()
            where workspace_id = ${ws} and user_id = ${owner.id} returning id`,
      ),
    );
    expect(changed).toEqual([]);
  });

  it('shows the playbooks in use, the person’s groups and the extension’s link', async () => {
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    await runAs(member, ws, 'outreach.groups.save', {
      groups: [
        {
          group: {
            id: '423456781',
            slug: null,
            url: 'https://www.facebook.com/groups/423456781/',
            name: 'Austin Makers',
          },
          joined: true,
        },
        {
          group: {
            id: '423456782',
            slug: null,
            url: 'https://www.facebook.com/groups/423456782/',
            name: 'Austin Trades',
          },
          joined: true,
        },
        {
          group: {
            id: '423456783',
            slug: null,
            url: 'https://www.facebook.com/groups/423456783/',
            name: 'Austin Cooks',
          },
          joined: false,
        },
      ],
    });
    expect(
      await refused(
        runAs(owner, ws, 'addon.save_settings', {
          addonId: 'outreach',
          settings: { extensionLink: 'http://files.example.test/social.zip' },
        }),
      ),
    ).toBe('validation');
    await runAs(owner, ws, 'addon.save_settings', {
      addonId: 'outreach',
      settings: { extensionLink: 'https://files.example.test/social.zip' },
    });
    // A link stored before its check got stricter: the business's other settings still save, and it goes.
    const old = JSON.stringify({ extensionLink: 'http://old.example.test/x.zip' });
    await admin().execute(
      sql`update app.addon_installations set settings = settings || ${old}::jsonb
          where workspace_id = ${ws} and addon_id = 'outreach'`,
    );
    const stored = (await runAs(owner, ws, 'addon.settings', { addonId: 'outreach' })).settings;
    expect(
      await refused(
        runAs(owner, ws, 'addon.save_settings', {
          addonId: 'outreach',
          settings: { ...stored, weeklyReport: false },
        }),
      ),
    ).toBe('validation');
    await runAs(owner, ws, 'addon.save_settings', {
      addonId: 'outreach',
      settings: settingsToSave(stored, { weeklyReport: false }),
    });
    expect((await runAs(member, ws, 'outreach.setup', {})).extensionLink).toBeNull();
    await runAs(owner, ws, 'addon.save_settings', {
      addonId: 'outreach',
      settings: settingsToSave(stored, { extensionLink: 'https://files.example.test/social.zip' }),
    });
    const seen: SetupOutput = await runAs(member, ws, 'outreach.setup', {});
    expect(seen).toMatchObject({
      playbooks: [
        {
          name: crm.name,
          template: 'crm_demos',
          niche: true,
          video: false,
          // Our template runs on every network.
          networks: ['facebook', 'linkedin', 'instagram', 'alignable'],
        },
      ],
      groups: { mine: 2, business: 3 },
      extensionLink: 'https://files.example.test/social.zip',
    });
    // The groups step lists the ones they're in, scored against the playbooks; never one they left.
    expect(seen.groups.latest.map((g) => g.name).sort()).toEqual([
      'Austin Makers',
      'Austin Trades',
    ]);
    expect(seen.groups.latest.every((g) => ['work', 'maybe', 'skip'].includes(g.verdict))).toBe(
      true,
    );
    expect((await runAs(owner, ws, 'outreach.setup', {})).groups.latest).toEqual([]);
  });

  it('is refused while the add-on is off', async () => {
    await setOutreach(ws, 'disabled');
    try {
      expect(await refused(runAs(member, ws, 'outreach.setup', {}))).toBe('addon_inactive');
      expect(await refused(runAs(member, ws, 'outreach.setup.save', { started: true }))).toBe(
        'addon_inactive',
      );
    } finally {
      await setOutreach(ws, 'enabled');
    }
  });
});
