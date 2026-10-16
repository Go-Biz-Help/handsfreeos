/**
 * Social Outreach's setup, in HandsFreeOS (docs/outreach.md, decisions 36, 45 and 63): its steps and where it opens, the
 * summary beside them, the extension's link as a business setting, and each person's own progress on the database:
 * who's a first-timer, what the extension signing in does and doesn't count as, and what the steps show.
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import {
  extensionLinkProblem,
  OutreachSettingsSchema,
  outreachSettings,
  settingsToSave,
} from '../../src/addons/outreach/chat-read';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import {
  isFirstTime,
  laterStep,
  nextScreen,
  outreachPath,
  outreachSetupPath,
  previousScreen,
  previousStep,
  readSetupStep,
  setupOpenAt,
  setupSteps,
  setupSummary,
  showsSetupBanner,
  stepsDone,
  whenWords,
  type SetupOutput,
} from '../../src/addons/outreach/setup';
import { outreachBusiness, refused, runAs, setOutreach } from './outreach-fixture';

const admin = () => testDbs().admin.db;

describe('the setup’s steps', () => {
  const manager = setupSteps(true);
  const member = setupSteps(false);

  it('has the team’s rules only for owners and admins, before their own networks and settings', () => {
    expect(manager).toEqual([
      'playbooks',
      'ready',
      'rules',
      'networks',
      'settings',
      'extension',
      'groups',
    ]);
    expect(member).toEqual(['playbooks', 'ready', 'networks', 'settings', 'extension', 'groups']);
  });

  it('only moves forward, and counts a member’s steps right', () => {
    expect(laterStep(null, 'settings')).toBe('settings');
    expect(laterStep('extension', 'settings')).toBe('extension');
    expect(laterStep('settings', null)).toBe('settings');
    expect(stepsDone(null, member)).toBe(0);
    expect(stepsDone('settings', member)).toBe(4);
    expect(stepsDone('settings', manager)).toBe(5);
    expect(stepsDone('groups', member)).toBe(6);
  });

  it('goes on and back through the person’s own steps', () => {
    // Get ready comes after the playbooks, for everyone (decision 63).
    expect(nextScreen('playbooks', member)).toBe('ready');
    expect(nextScreen('ready', member)).toBe('networks');
    expect(nextScreen('ready', manager)).toBe('rules');
    expect(nextScreen('rules', manager)).toBe('networks');
    expect(nextScreen('networks', member)).toBe('settings');
    expect(nextScreen('groups', member)).toBe('done');
    expect(previousStep('settings', member)).toBe('networks');
    expect(previousStep('playbooks', member)).toBeNull();
    expect(previousStep('done', member)).toBe('groups');
    // Back from the first step is the welcome, and there's none before it.
    expect(previousScreen('playbooks', member)).toBe('welcome');
    expect(previousScreen('settings', member)).toBe('networks');
    expect(previousScreen('welcome', member)).toBeNull();
    expect(readSetupStep('extension')).toBe('extension');
    expect(readSetupStep('welcome')).toBe('welcome');
    expect(readSetupStep('nope')).toBeNull();
  });

  it('opens where the person got to', () => {
    const open = (
      reached: Parameters<typeof laterStep>[0],
      asked: string | null,
      steps = member,
      finishedAt: string | null = null,
      again = false,
    ) => setupOpenAt({ reached, finishedAt, steps }, asked, again);
    // Nothing finished yet: the welcome, before the steps; asked for, it opens any time.
    expect(open(null, null)).toBe('welcome');
    expect(open('settings', 'welcome')).toBe('welcome');
    expect(open('playbooks', null, manager)).toBe('ready');
    expect(open('ready', null, manager)).toBe('rules');
    expect(open('ready', null)).toBe('networks');
    expect(open('settings', null)).toBe('extension');
    // The last step finished but not the setup: it opens on the last.
    expect(open('groups', null)).toBe('groups');
    expect(open('groups', null, member, '2026-10-10T10:00:00Z')).toBe('done');
    // Set up again: the first, or the step asked for.
    expect(open('groups', null, member, '2026-10-10T10:00:00Z', true)).toBe('playbooks');
    expect(open('groups', 'extension', member, null, true)).toBe('extension');
    // A step asked for: not past the one they'd come back to, unless they've finished; never one that isn't theirs.
    expect(open('playbooks', 'groups')).toBe('ready');
    expect(open('playbooks', 'playbooks')).toBe('playbooks');
    expect(open(null, 'rules')).toBe('playbooks');
    expect(open('groups', 'done')).toBe('groups');
    expect(open('extension', 'settings', member, '2026-10-10T10:00:00Z')).toBe('settings');
    expect(open('settings', 'junk')).toBe('extension');
  });

  it('builds its address', () => {
    const ws = '11111111-1111-4111-8111-111111111111';
    expect(outreachSetupPath(ws)).toBe(`/app/w/${ws}/a/outreach/setup`);
    expect(outreachSetupPath(ws, { step: 'extension' })).toBe(
      `/app/w/${ws}/a/outreach/setup?step=extension`,
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

  it('sums up where things stand', () => {
    const got = {
      playbooks: [],
      extensionAt: null,
      groups: { mine: 0, business: 0, latest: [] },
    } satisfies Pick<SetupOutput, 'playbooks' | 'extensionAt' | 'groups'>;
    expect(setupSummary(got, null)).toEqual([
      'Playbooks: none yet',
      'Networks: Facebook',
      'Your settings: your business’s defaults',
      'Extension: not signed in yet',
      'Groups: none yet',
    ]);
    const more = {
      playbooks: [{ name: 'CRM demos', template: 'crm_demos' }],
      extensionAt: '2026-10-10T18:14:00Z',
      groups: { mine: 12, business: 30, latest: [] },
    } satisfies Pick<SetupOutput, 'playbooks' | 'extensionAt' | 'groups'>;
    expect(
      setupSummary(
        more,
        { ...AUTOMATION_DEFAULTS, sending: 'steps' },
        'America/Chicago',
        Date.parse('2026-10-10T20:00:00Z'),
      ),
    ).toEqual([
      'Playbooks: CRM demos',
      'Networks: Facebook',
      'On its own: Requests, likes and comments on their own; each message waits for you',
      'Extension: last checked in at 1:14 PM',
      'Groups: 12 of yours saved',
    ]);
  });

  it('says when, in the business’s time zone, around midnight there', () => {
    const chicago = 'America/Chicago';
    // 11:50 PM in Austin on Oct 9 is already Oct 10 in UTC.
    const lateThere = '2026-10-10T04:50:00Z';
    expect(whenWords(lateThere, Date.parse('2026-10-10T04:55:00Z'), chicago)).toBe('at 11:50 PM');
    expect(whenWords(lateThere, Date.parse('2026-10-10T05:10:00Z'), chicago)).toBe('on Oct 9');
    expect(whenWords(lateThere, Date.parse('2026-10-10T05:10:00Z'), 'UTC')).toBe('at 4:50 AM');
  });

  it('says who’s a first-timer and who’s reminded to finish', () => {
    const none = { reached: null, startedAt: null, finishedAt: null, bannerHiddenAt: null };
    expect(isFirstTime(null, false)).toBe(true);
    // A row the extension made by signing in isn't a start.
    expect(isFirstTime({ ...none }, false)).toBe(true);
    expect(isFirstTime({ ...none, startedAt: new Date() }, false)).toBe(false);
    expect(isFirstTime(null, true)).toBe(false);
    expect(showsSetupBanner(null, false)).toBe(true);
    // Someone who saved theirs long ago and never started isn't reminded.
    expect(showsSetupBanner(null, true)).toBe(false);
    expect(showsSetupBanner({ ...none, startedAt: new Date() }, true)).toBe(true);
    expect(
      showsSetupBanner({ ...none, startedAt: new Date(), bannerHiddenAt: new Date() }, true),
    ).toBe(false);
    expect(showsSetupBanner({ ...none, finishedAt: new Date() }, false)).toBe(false);
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

  it('starts a new person as a first-timer, with their own steps', async () => {
    const mine = await runAs(owner, ws, 'outreach.setup', {});
    expect(mine).toMatchObject({
      steps: ['playbooks', 'ready', 'rules', 'networks', 'settings', 'extension', 'groups'],
      reached: null,
      firstTime: true,
      banner: true,
      settingsSaved: false,
      canManage: true,
      extensionLink: null,
      playbooks: [],
      groups: { mine: 0, business: 0 },
    });
    const theirs = await runAs(member, ws, 'outreach.setup', {});
    expect(theirs).toMatchObject({
      steps: ['playbooks', 'ready', 'networks', 'settings', 'extension', 'groups'],
      firstTime: true,
      canManage: false,
    });
  });

  it('doesn’t count the extension signing in as starting, and says when it did', async () => {
    const signed = await runAs(member, ws, 'outreach.setup.save', { extension: true });
    expect(signed.extensionAt).not.toBeNull();
    expect(signed).toMatchObject({ firstTime: true, startedAt: null, reached: null });
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

  it('keeps how far each person got, only ever forward', async () => {
    const one = await runAs(owner, ws, 'outreach.setup.save', { reached: 'playbooks' });
    expect(one).toMatchObject({ reached: 'playbooks', firstTime: false });
    expect(one.startedAt).not.toBeNull();
    await runAs(owner, ws, 'outreach.setup.save', { reached: 'extension' });
    const back = await runAs(owner, ws, 'outreach.setup.save', { reached: 'settings' });
    expect(back.reached).toBe('extension');
    expect(back.finishedAt).toBeNull();
    const done = await runAs(owner, ws, 'outreach.setup.save', {
      reached: 'groups',
      finished: true,
    });
    expect(done.finishedAt).not.toBeNull();
    expect(done.banner).toBe(false);
    // Riley's is their own.
    const riley = await runAs(member, ws, 'outreach.setup', {});
    expect(riley).toMatchObject({ reached: null, finishedAt: null });
    expect(await refused(runAs(owner, ws, 'outreach.setup.save', {}))).toBe('validation');
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
    await runAs(other, ws, 'outreach.automation.save', { settings: AUTOMATION_DEFAULTS });
    expect(await runAs(other, ws, 'outreach.setup', {})).toMatchObject({
      settingsSaved: true,
      firstTime: false,
      banner: false,
    });
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
      runAs(both, ws, 'outreach.setup.save', { reached: 'playbooks' }),
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
      playbooks: [{ name: crm.name, template: 'crm_demos' }],
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
