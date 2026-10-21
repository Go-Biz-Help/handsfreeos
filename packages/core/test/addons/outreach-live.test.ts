/**
 * Social Outreach: live status and control (docs/outreach.md, decision 41). The extension's beat makes each install a
 * computer of the person's, only the most recently used one works, and a beat that changes nothing tells nobody and
 * keeps no receipt; Start my day and Stop for today are kept in HandsFreeOS, newer news winning, and a Facebook
 * warning stops the day whatever was pressed; the live view counts as Today does, and owners and admins see their
 * team's status without any line, feed or message.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import {
  BEAT_MINUTES,
  clipLine,
  COMPUTER_NAME_MOST,
  computerName,
  dayLine,
  dayWords,
  isOffline,
  LINE_MOST,
  LIVE_REFETCH_SECONDS,
  numberedName,
  OFFLINE_MINUTES,
  offlineWords,
  preDayNow,
  seenWords,
  sendingOffWords,
  shownState,
  standDownWords,
  warningLine,
  warningPushWords,
} from '../../src/addons/outreach/live';
import { NETWORKS, type NetworkKit } from '../../src/addons/outreach/networks';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { zonedParts } from '../../src/calendar/engine/zoned';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const crmPlaybook = {
  name: 'CRM demos',
  template: 'crm_demos',
  details: PLAYBOOK_TEMPLATES.crm_demos.details,
};

const admin = () => testDbs().admin.db;
const MIN = 60_000;
const DAY = 86_400_000;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});
/**
 * Where the business is: Chicago, or Tokyo (14 or 15 hours ahead) when it's within 3 hours of midnight in Chicago. The
 * moments these tests set a few minutes back, and the whole run, then fall on the business's today at any hour.
 */
const awayFromMidnight = (now = Date.now()) => {
  const { hour } = zonedParts(now, 'America/Chicago');
  return hour >= 3 && hour < 21 ? 'America/Chicago' : 'Asia/Tokyo';
};

describe('the live view’s words', () => {
  // Friday 9 October 2026, 2:14 PM in Chicago.
  const at = Date.UTC(2026, 9, 9, 19, 14);
  const tz = 'America/Chicago';

  it('say when a computer was last seen, and that it’s offline, in the owner’s words', () => {
    expect(isOffline(at, at + 2 * MIN)).toBe(false);
    expect(isOffline(at, at + 4 * MIN)).toBe(true);
    expect(offlineWords(new Date(at), tz, at + 10 * MIN)).toBe(
      'Your computer is offline: nothing runs until Chrome is open. Last seen 2:14 PM.',
    );
    expect(seenWords(at, tz, at + 24 * 60 * MIN)).toBe('yesterday at 2:14 PM');
    expect(seenWords(at, tz, at + 4 * 24 * 60 * MIN)).toBe('Fri, Oct 9 at 2:14 PM');
  });

  it('show what a person’s computer is doing: none, signed out, offline, stopped, off, or as it said', () => {
    const seen = new Date(at).toISOString();
    const base = { day: { state: 'none' as const }, sending: 'steps' as const, now: at + MIN };
    expect(shownState({ ...base, computer: null })).toBe('none');
    expect(shownState({ ...base, computer: { state: 'waiting', lastSeenAt: seen } })).toBe(
      'waiting',
    );
    expect(
      shownState({ ...base, now: at + 5 * MIN, computer: { state: 'working', lastSeenAt: seen } }),
    ).toBe('offline');
    expect(
      shownState({
        ...base,
        now: at + 5 * MIN,
        computer: { state: 'signed_out', lastSeenAt: seen },
      }),
    ).toBe('signed_out');
    expect(
      shownState({
        ...base,
        day: { state: 'stopped' },
        computer: { state: 'idle', lastSeenAt: seen },
      }),
    ).toBe('stopped');
    expect(
      shownState({ ...base, sending: 'off', computer: { state: 'idle', lastSeenAt: seen } }),
    ).toBe('off');
  });

  it('say where the day stands and name computers plainly', () => {
    const started = {
      date: '2026-10-09',
      state: 'started' as const,
      why: null,
      via: 'web' as const,
      at: new Date(Date.UTC(2026, 9, 9, 14, 2)).toISOString(),
    };
    expect(dayWords(started, tz)).toBe('Started at 9:02 AM in HandsFreeOS.');
    expect(dayWords({ ...started, state: 'stopped', why: 'person', via: 'mobile' }, tz)).toBe(
      'Stopped for today at 9:02 AM on your phone.',
    );
    expect(dayWords({ ...started, state: 'stopped', why: 'warning' }, tz)).toBe(
      'Stopped for today: Facebook showed a warning.',
    );
    expect(dayWords({ ...started, state: 'none', via: null, at: null }, tz)).toBe('');
    expect(dayLine('stopped', 'extension')).toBe('You pressed Stop for today in the extension.');
    expect(warningLine('You can’t use this feature right now')).toContain(
      '(“You can’t use this feature right now”). The extension stopped on Facebook for today',
    );
    expect(warningPushWords()).toEqual({
      title: 'Facebook showed a warning.',
      body: 'The extension stopped on Facebook for today.',
    });
    // A warning names its network: the others go on.
    expect(warningLine('Slow down', 'linkedin')).toBe(
      'LinkedIn showed a warning (“Slow down”). The extension stopped on LinkedIn for today, and your LinkedIn limits are halved for a week.',
    );
    expect(warningPushWords('linkedin').title).toBe('LinkedIn showed a warning.');
    expect(standDownWords('Chrome on Mac')).toBe(
      'Chrome on Mac is working for you now, so this one stands by. Open the panel here to work from this computer instead.',
    );
    expect(computerName('win')).toBe('Chrome on Windows');
    expect(computerName('cros')).toBe('Chrome on a Chromebook');
    expect(computerName('android')).toBe('Chrome');
    expect(numberedName('Chrome on Mac', ['Chrome on Windows'])).toBe('Chrome on Mac');
    expect(numberedName('Chrome on Mac', ['chrome on mac', 'Chrome on Mac 2'])).toBe(
      'Chrome on Mac 3',
    );
    expect(sendingOffWords(false)).toContain('Ask an owner of this business');
    expect(sendingOffWords(true)).toContain('Settings → Facebook');
    // A network with no runner yet (Instagram's before its part 14, stood in for): nothing to pick and nobody to ask;
    // its list is the person's own to do.
    const kit = NETWORKS.instagram as { runs: NetworkKit['runs'] };
    const runs = kit.runs;
    kit.runs = { auto: [], ticks: [] };
    try {
      expect(sendingOffWords(true, 'instagram')).toBe(
        'Your computer doesn’t work on Instagram on its own yet, so there’s no day to start there. Today’s list on Instagram is yours to do, and it notes each step you take.',
      );
      expect(sendingOffWords(false, 'instagram')).not.toContain('Ask an owner');
    } finally {
      kit.runs = runs;
    }
    // Instagram has its runner (part 14): its Sending choice is picked on its own page.
    expect(sendingOffWords(true, 'instagram')).toContain('Settings → Instagram');
    // Alignable has its runner (part 5): its Sending choice is picked on its own page.
    expect(sendingOffWords(true, 'alignable')).toContain('Settings → Alignable');
    expect(sendingOffWords(true, 'linkedin')).toContain('Settings → LinkedIn');
    expect(sendingOffWords(false)).toContain('Settings → General');
  });

  it('cut long lines and names short rather than refuse them', () => {
    expect(clipLine('Liked a post')).toBe('Liked a post');
    const long = clipLine('x'.repeat(400));
    expect(long).toHaveLength(LINE_MOST);
    expect(long.endsWith('…')).toBe(true);
    // Facebook's longest words still make a line the feed keeps.
    const warned = warningLine('w'.repeat(300));
    expect(warned.length).toBeLessThanOrEqual(LINE_MOST);
    expect(warned).toContain(
      'The extension stopped on Facebook for today, and your Facebook limits are halved for a week.',
    );
    // A numbered name stays within the most a name may be.
    const name = 'n'.repeat(COMPUTER_NAME_MOST);
    expect(numberedName(name, [name])).toHaveLength(COMPUTER_NAME_MOST);
    expect(numberedName(name, [name]).endsWith(' 2')).toBe(true);
  });

  it('say when the next step is, tomorrow included', () => {
    expect(seenWords(at + 19 * 60 * MIN, tz, at)).toBe('tomorrow at 9:14 AM');
  });

  it('never call a computer that beats every minute offline while the Live tab asks again on its clock', () => {
    // The worst case: the tab's answer came just before a beat, and the next answer is a whole refetch away.
    const lastSeen = at;
    for (let shown = 0; shown <= LIVE_REFETCH_SECONDS * 1000; shown += 1000)
      expect(isOffline(lastSeen, at + BEAT_MINUTES * MIN + shown)).toBe(false);
    expect(LIVE_REFETCH_SECONDS * 1000 + BEAT_MINUTES * MIN).toBeLessThan(OFFLINE_MINUTES * MIN);
  });
});

describe('live status and control', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const home = randomUUID();
  const office = randomUUID();

  const status = (state: string, line: string | null = null, nextAt: string | null = null) => ({
    state,
    line,
    lineAt: line ? new Date().toISOString() : null,
    nextAt,
  });
  const beat = (
    u: TestUser,
    installId: string,
    more: Record<string, unknown> = {},
    meta: Record<string, unknown> = {},
  ) =>
    runWith(
      u,
      ws,
      'outreach.live.beat',
      {
        computer: { id: installId, name: 'Chrome on Windows', version: '0.17.0' },
        status: status('idle'),
        ...more,
      },
      {
        channel: 'extension',
        commandId: randomUUID(),
        occurredAt: new Date(),
        sentAt: new Date(),
        ...meta,
      },
    );
  const told = async (type = 'outreach.live.changed') =>
    (
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events where workspace_id = ${ws} and event_type = ${type}`,
      )
    )[0]!.n;
  const computerRow = async (installId: string) =>
    (
      await rows<{ id: string; state: string; line: string | null; told_at: Date | null }>(
        admin(),
        sql`select id, state, line, told_at from addon_outreach.computers
            where workspace_id = ${ws} and install_id = ${installId}`,
      )
    )[0]!;
  const steps = (s: { id: string; at: string; kind: string; line: string }[]) => ({ steps: s });

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outl-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outl-member', { fullName: 'Riley Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Live Co', { timezone: awayFromMidnight() });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    // A playbook with a niche: one of the things a person needs before their day starts (decision 63).
    await runAs(owner, ws, 'outreach.playbook.save', crmPlaybook);
  }, 60_000);
  afterAll(closeTestDbs);

  it('makes each install a computer, and only the most recently used one works', async () => {
    const first = await beat(owner, home, { active: true });
    expect(first).toMatchObject({
      name: 'Chrome on Windows',
      working: true,
      workingName: null,
      day: { state: 'none' },
    });
    // A second install of the same person, not used yet: it stands by, named apart.
    const second = await beat(owner, office);
    expect(second).toMatchObject({
      name: 'Chrome on Windows 2',
      working: false,
      workingName: 'Chrome on Windows',
    });
    expect((await computerRow(office)).state).toBe('standby');
    // The person opens the panel there: it works, and the first stands by from its next beat.
    expect(await beat(owner, office, { active: true })).toMatchObject({ working: true });
    expect(await beat(owner, home, { status: status('waiting') })).toMatchObject({
      working: false,
      workingName: 'Chrome on Windows 2',
    });
    expect((await computerRow(home)).state).toBe('standby');
    // Renaming: their own, never someone else's.
    const officeId = (await computerRow(office)).id;
    expect(
      await runAs(owner, ws, 'outreach.computer.rename', {
        computerId: officeId,
        name: ' Office Chrome ',
      }),
    ).toEqual({ computerId: officeId, name: 'Office Chrome' });
    expect(await beat(owner, home)).toMatchObject({ workingName: 'Office Chrome' });
    expect(
      await refused(
        runAs(member, ws, 'outreach.computer.rename', { computerId: officeId, name: 'Mine' }),
      ),
    ).toBe('not_found');
  });

  it('tells nobody of a heartbeat, keeps no receipt, and tells the app of a real change once', async () => {
    const pc = randomUUID();
    await beat(member, pc, { active: true, status: status('waiting', 'Next: Dana Cole') });
    const quiet = await told();
    const commandId = randomUUID();
    await beat(member, pc, { status: status('waiting', 'Next: Dana Cole') }, { commandId });
    expect(await told()).toBe(quiet);
    const receipts = await rows(
      admin(),
      sql`select 1 from app.command_receipts where user_id = ${member.id} and command_id = ${commandId}`,
    );
    expect(receipts).toEqual([]);
    // A new state tells at once.
    await beat(member, pc, { status: status('working', 'Sending a friend request to Dana Cole…') });
    expect(await told()).toBe(quiet + 1);
    // Ten new lines alone within a minute (a job's progress) tell at most once.
    for (let i = 0; i < 10; i++)
      await beat(member, pc, { status: status('working', `Reading chat ${i + 1} of 60…`) });
    expect(await told()).toBeLessThanOrEqual(quiet + 2);
    const afterLines = await told();
    // The newest line is kept every time, all the same.
    expect((await computerRow(pc)).line).toBe('Reading chat 10 of 60…');
    // A minute on, a new line tells again.
    await rows(
      admin(),
      sql`update addon_outreach.computers set told_at = now() - interval '2 minutes'
          where workspace_id = ${ws} and install_id = ${pc}`,
    );
    await beat(member, pc, { status: status('working', 'Reading chat 11 of 60…') });
    expect(await told()).toBe(afterLines + 1);
    // A step taken tells at once.
    await beat(member, pc, {
      status: status('working', 'Reading chat 11 of 60…'),
      ...steps([
        { id: randomUUID(), at: new Date().toISOString(), kind: 'job', line: 'Read my chats: 60' },
      ]),
    });
    expect(await told()).toBe(afterLines + 2);
    // Back after being offline tells at once.
    await rows(
      admin(),
      sql`update addon_outreach.computers set last_seen_at = now() - interval '10 minutes'
          where workspace_id = ${ws} and install_id = ${pc}`,
    );
    await beat(member, pc, { status: status('working', 'Reading chat 11 of 60…') });
    expect(await told()).toBe(afterLines + 3);
  });

  it('keeps a step sent twice once, on the server’s clock', async () => {
    const pc = randomUUID();
    const id = randomUUID();
    // The computer's clock is 10 minutes behind: what it says took a minute ago, did.
    const behind = new Date(Date.now() - 10 * MIN);
    const sent = steps([
      {
        id,
        at: new Date(behind.getTime() - MIN).toISOString(),
        kind: 'done',
        line: 'Sent Gray Lund a friend request',
      },
    ]);
    const first = await beat(owner, pc, sent, { sentAt: behind });
    const again = await beat(owner, pc, sent, { sentAt: behind });
    expect(first.stepsKept).toEqual([id]);
    expect(again.stepsKept).toEqual([id]);
    const kept = await rows<{ at: Date }>(
      admin(),
      sql`select at from addon_outreach.live_steps where workspace_id = ${ws} and client_id = ${id}`,
    );
    expect(kept).toHaveLength(1);
    expect(Math.abs(Date.now() - MIN - new Date(kept[0]!.at).getTime())).toBeLessThan(10_000);
  });

  it('keeps the person’s day, newer news winning, from the web or the extension', async () => {
    expect(await refused(runAs(member, ws, 'outreach.day.start', {}))).toBe('outreach_sending_off');
    await runAs(member, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
    });
    const days = await told('outreach.day.started');
    const started = await runWith(member, ws, 'outreach.day.start', {}, { channel: 'web' });
    expect(started).toMatchObject({ state: 'started', why: null, via: 'web' });
    expect(await told('outreach.day.started')).toBe(days + 1);
    // Pressed again: nothing changes, and nobody is told.
    await runWith(member, ws, 'outreach.day.start', {}, { channel: 'web' });
    expect(await told('outreach.day.started')).toBe(days + 1);
    const stopped = await runAs(member, ws, 'outreach.day.stop', {});
    expect(stopped).toMatchObject({ state: 'stopped', why: 'person', via: 'extension' });
    // A Start pressed earlier, which waited offline, never undoes the later Stop.
    expect(
      await runAs(member, ws, 'outreach.day.start', {}, new Date(Date.now() - 5 * MIN)),
    ).toMatchObject({ state: 'stopped' });
    expect(await told('outreach.day.started')).toBe(days + 1);
    const lines = await rows<{ kind: string; line: string }>(
      admin(),
      sql`select kind, line from addon_outreach.live_steps
          where workspace_id = ${ws} and user_id = ${member.id} and kind = 'day' order by at`,
    );
    expect(lines.map((l) => l.line)).toEqual([
      'You pressed Start my day in HandsFreeOS.',
      'You pressed Stop for today in the extension.',
    ]);
    // Pressed in the extension on a computer of theirs: it becomes the one that works.
    const desk = randomUUID();
    const laptop = randomUUID();
    await beat(member, desk, { active: true });
    await beat(member, laptop, { active: true });
    expect(await beat(member, desk)).toMatchObject({ working: false });
    await runAs(member, ws, 'outreach.day.start', { installId: desk });
    expect(await beat(member, desk)).toMatchObject({
      working: true,
      day: { state: 'started', via: 'extension' },
    });
  });

  it('says who can let it work on its own when the business allows nothing else', async () => {
    const solo = await createTestUser('outl-solo', { fullName: 'Sky Solo' });
    const soloWs = await outreachBusiness(solo, 'Outreach Solo Co');
    await runAs(solo, soloWs, 'outreach.playbook.save', crmPlaybook);
    await rows(
      admin(),
      sql`update app.addon_installations
          set settings = jsonb_build_object('rules', jsonb_build_object('sendingAllowed', '[]'::jsonb))
          where workspace_id = ${soloWs} and addon_id = 'outreach'`,
    );
    const said = await runAs(solo, soloWs, 'outreach.day.start', {}).catch(
      (e: { rule?: string; message: string }) => e,
    );
    expect(said).toMatchObject({ rule: 'outreach_sending_off' });
    expect((said as { message: string }).message).toContain('Ask an owner of this business');
    // Pressed the day before, and waiting on the phone since: passed over quietly, never refused.
    expect(
      await runAs(solo, soloWs, 'outreach.day.start', {}, new Date(Date.now() - 2 * DAY)),
    ).toMatchObject({ state: 'none' });
  });

  it('stops the day on a Facebook warning, whatever was pressed after it was seen', async () => {
    const pc = randomUUID();
    await beat(owner, pc, { active: true });
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
    });
    // Start pressed at 10:30; the warning, seen offline at 10:00, arrives at 10:45.
    await runAs(owner, ws, 'outreach.day.start', {}, new Date(Date.now() - 2 * MIN));
    const before = await told('outreach.warning.seen');
    await runAs(
      owner,
      ws,
      'outreach.warning.note',
      { words: ['You’re temporarily blocked from sending friend requests'] },
      new Date(Date.now() - 10 * MIN),
    );
    expect(await told('outreach.warning.seen')).toBe(before + 1);
    const [seen] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${ws}
            and event_type = 'outreach.warning.seen' order by created_at desc limit 1`,
    );
    expect(seen!.payload.userId).toBe(owner.id);
    expect(await beat(owner, pc)).toMatchObject({
      day: { state: 'stopped', why: 'warning' },
    });
    // Start is refused for the rest of the day, and Stop leaves it stopped for the warning.
    expect(await refused(runAs(owner, ws, 'outreach.day.start', {}))).toBe('outreach_warned_today');
    // A Start from the day before, waiting on the phone since, changes nothing and isn't refused.
    expect(
      await runAs(owner, ws, 'outreach.day.start', {}, new Date(Date.now() - 2 * DAY)),
    ).toMatchObject({ state: 'stopped', why: 'warning' });
    expect(await runAs(owner, ws, 'outreach.day.stop', {})).toMatchObject({ why: 'warning' });
    const lines = await rows<{ line: string }>(
      admin(),
      sql`select line from addon_outreach.live_steps
          where workspace_id = ${ws} and user_id = ${owner.id} and kind = 'stopped'`,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toContain('Facebook showed a warning');
  });

  it('keeps a warning of Facebook’s longest words: the warning, the day stopped and the feed line', async () => {
    const warned = await createTestUser('outl-warned', { fullName: 'Dana Reyes' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: warned.id, role: 'member' });
    const words = `${'You’re temporarily blocked '.repeat(12)}`.slice(0, 300);
    expect(words).toHaveLength(300);
    await runAs(warned, ws, 'outreach.warning.note', { words: [words] });
    const kept = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.warnings
          where workspace_id = ${ws} and user_id = ${warned.id}`,
    );
    expect(kept[0]!.n).toBe(1);
    const [day] = await rows<{ state: string; why: string }>(
      admin(),
      sql`select state, why from addon_outreach.days where workspace_id = ${ws} and user_id = ${warned.id}`,
    );
    expect(day).toEqual({ state: 'stopped', why: 'warning' });
    const [line] = await rows<{ line: string }>(
      admin(),
      sql`select line from addon_outreach.live_steps
          where workspace_id = ${ws} and user_id = ${warned.id} and kind = 'stopped'`,
    );
    expect(line!.line.length).toBeLessThanOrEqual(300);
    expect(line!.line).toContain('your Facebook limits are halved for a week');
    // Out of the business again, so the team below is as it was.
    await rows(
      admin(),
      sql`delete from app.workspace_memberships where workspace_id = ${ws} and user_id = ${warned.id}`,
    );
  });

  it('cuts a long line, step or name short, and never refuses a beat for it', async () => {
    const pc = randomUUID();
    const long = `Dana Reyes: ${'HandsFreeOS couldn’t save that step. '.repeat(12)}`;
    expect(long.length).toBeGreaterThan(400);
    const answer = await beat(owner, pc, {
      computer: { id: pc, name: `Chrome on a computer with a very long name ${'x'.repeat(30)}` },
      status: status('trouble', long),
      ...steps([{ id: randomUUID(), at: new Date().toISOString(), kind: 'passed', line: long }]),
    });
    expect(answer.name.length).toBeLessThanOrEqual(COMPUTER_NAME_MOST);
    expect((await computerRow(pc)).line).toHaveLength(300);
    const [step] = await rows<{ line: string }>(
      admin(),
      sql`select line from addon_outreach.live_steps
          where workspace_id = ${ws} and computer_id = ${(await computerRow(pc)).id}`,
    );
    expect(step!.line).toHaveLength(300);
  });

  it('tells the app later of a line it kept without telling', async () => {
    const pc = randomUUID();
    await beat(member, pc, { active: true, status: status('working', 'Reading chat 1 of 60…') });
    await beat(member, pc, { status: status('working', 'Reading chat 2 of 60…') });
    // Told just now, so line 2 was kept without telling.
    const before = await told();
    await beat(member, pc, { status: status('working', 'Reading chat 2 of 60…') });
    expect(await told()).toBe(before);
    await rows(
      admin(),
      sql`update addon_outreach.computers set told_at = told_at - interval '2 minutes',
            line_at = now() - interval '30 seconds'
          where workspace_id = ${ws} and install_id = ${pc}`,
    );
    // The same line again, after the wait: the app hears it once, and not again.
    await beat(member, pc, { status: status('working', 'Reading chat 2 of 60…') });
    expect(await told()).toBe(before + 1);
    await beat(member, pc, { status: status('working', 'Reading chat 2 of 60…') });
    expect(await told()).toBe(before + 1);
  });

  it('tells the other computers at once when a press in the extension moves the work, day changed or not', async () => {
    const one = randomUUID();
    const two = randomUUID();
    await beat(member, one, { active: true });
    await beat(member, two);
    await runAs(member, ws, 'outreach.day.stop', {});
    const before = await told();
    // Stop again, from the second computer's panel: the day stays as it is, but that computer works now.
    await runWith(
      member,
      ws,
      'outreach.day.stop',
      { installId: two },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
    expect(await told()).toBe(before + 1);
    expect(await beat(member, one)).toMatchObject({ working: false });
    // The member's day goes back to nothing pressed, for the tests after this one.
    await rows(
      admin(),
      sql`delete from addon_outreach.days where workspace_id = ${ws} and user_id = ${member.id}`,
    );
  });

  it('shows the person’s own live view, counted as Today counts', async () => {
    await runAs(member, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      profile: fb('dana.cole.7'),
      name: 'Dana Cole',
      at: new Date().toISOString(),
    });
    const [dana] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = 'dana.cole.7'`,
    );
    await runAs(member, ws, 'outreach.send.queue', {
      profileId: dana!.id,
      kind: 'opener',
      text: 'Hi Dana! How do you keep track of customers?',
    });
    // A line from yesterday isn't today's.
    await rows(
      admin(),
      sql`insert into addon_outreach.live_steps (workspace_id, user_id, at, kind, line)
          values (${ws}, ${member.id}, now() - interval '2 days', 'done', 'An old line')`,
    );
    const pc = randomUUID();
    await beat(member, pc, {
      active: true,
      status: status('waiting', 'Next: Eli Brook', new Date(Date.now() + 20 * MIN).toISOString()),
      ...steps([
        {
          id: randomUUID(),
          at: new Date().toISOString(),
          kind: 'done',
          line: 'Sent Dana Cole a friend request',
        },
      ]),
    });
    const shown = await runAs(member, ws, 'outreach.live', {});
    const today = await runAs(member, ws, 'outreach.today', {});
    expect(shown.limits).toEqual(today.limits);
    expect(shown.limits.friend_request.done).toBe(1);
    expect(shown.waiting).toBe(1);
    expect(shown.computer).toMatchObject({ working: true });
    expect(shown.status).toMatchObject({ state: 'waiting', line: 'Next: Eli Brook' });
    expect(shown.computers.length).toBeGreaterThanOrEqual(2);
    expect(shown.computers[0].working).toBe(true);
    const said = shown.steps.map((s: { line: string }) => s.line);
    expect(said).toContain('Sent Dana Cole a friend request');
    expect(said).not.toContain('An old line');
    // Another person's computers and steps are never in it.
    const theirs = await runAs(owner, ws, 'outreach.live', {});
    expect(theirs.steps.map((s: { line: string }) => s.line)).not.toContain(
      'Sent Dana Cole a friend request',
    );
    expect(theirs.computers.map((c: { id: string }) => c.id)).not.toContain(shown.computer.id);
  });

  it('shows owners and admins their team’s status, counts and waiting, never a line or message', async () => {
    expect(await refused(runAs(member, ws, 'outreach.live.team', {}))).toBe('forbidden');
    const team = await runAs(owner, ws, 'outreach.live.team', {});
    expect(team.people.map((p: { name: string }) => p.name)).toEqual([
      'Morgan Owner',
      'Riley Member',
    ]);
    const riley = team.people.find((p: { name: string }) => p.name === 'Riley Member');
    expect(riley).toMatchObject({
      state: 'waiting',
      waiting: 1,
      computer: { state: 'waiting' },
      limits: { friend_request: { done: 1 } },
    });
    const morgan = team.people.find((p: { name: string }) => p.name === 'Morgan Owner');
    expect(morgan).toMatchObject({ warned: true, day: { why: 'warning' }, state: 'stopped' });
    const json = JSON.stringify(team);
    expect(json).not.toContain('"line":');
    expect(json).not.toContain('"steps":');
    expect(json).not.toContain('Dana Cole');
    expect(json).not.toContain('Next: Eli Brook');
  });
  it('keeps when the person’s own lists were saved, and the live view says a first day waits for them', async () => {
    const before = await runAs(member, ws, 'outreach.lists', {});
    expect(before).toEqual({
      friendsAt: null,
      requestsAt: null,
      sentAt: null,
      groupsAt: null,
      groupChecksAt: null,
      tidyAt: null,
      checksAt: null,
    });
    await runAs(member, ws, 'outreach.lists.saved', { list: 'friends' });
    const after = await runAs(member, ws, 'outreach.lists.saved', { list: 'sent' });
    expect(after.friendsAt).not.toBeNull();
    expect(after.sentAt).not.toBeNull();
    expect(after.requestsAt).toBeNull();
    expect((await runAs(member, ws, 'outreach.live', {})).lists).toEqual(after);
    // Each person's own: the owner's are still unsaved.
    expect((await runAs(owner, ws, 'outreach.lists', {})).friendsAt).toBeNull();
  });

  it('keeps the step before the first day a computer is doing, and tells its count every few seconds', async () => {
    const pc = randomUUID();
    const reading = (n: number) => ({
      status: {
        ...status('working', `Reading your friends… ${n} friends so far.`),
        doing: 'friends',
      },
    });
    await beat(member, pc, { active: true, ...reading(40) });
    let live = await runAs(member, ws, 'outreach.live', {});
    expect(live.status).toMatchObject({ doing: 'friends' });
    expect(preDayNow(live, Date.now())).toEqual({
      doing: 'friends',
      line: 'Reading your friends… 40 friends so far.',
    });
    // Told just now: the next count waits a few seconds, not 45.
    const before = await told();
    await beat(member, pc, reading(80));
    expect(await told()).toBe(before);
    await rows(
      admin(),
      sql`update addon_outreach.computers set told_at = now() - interval '5 seconds'
          where workspace_id = ${ws} and install_id = ${pc}`,
    );
    await beat(member, pc, reading(120));
    expect(await told()).toBe(before + 1);
    // On to other work: told at once, and no line shows under a step.
    await beat(member, pc, { status: status('working', 'Liking a post of Dana Cole’s…') });
    expect(await told()).toBe(before + 2);
    live = await runAs(member, ws, 'outreach.live', {});
    expect(live.status).toMatchObject({ doing: null });
    expect(preDayNow(live, Date.now())).toEqual({ doing: null, line: null });
    // An older extension that doesn't say: nothing under a step either.
    await beat(member, pc, {
      status: status('working', 'Reading your friends… 9 friends so far.'),
    });
    expect((await runAs(member, ws, 'outreach.live', {})).status).toMatchObject({ doing: null });
  });

  it('keeps when the person’s groups were saved and first checked, before their first day', async () => {
    await runAs(member, ws, 'outreach.lists.saved', { list: 'groups' });
    const after = await runAs(member, ws, 'outreach.lists.saved', { list: 'group_checks' });
    expect(after.groupsAt).not.toBeNull();
    expect(after.groupChecksAt).not.toBeNull();
    expect((await runAs(member, ws, 'outreach.live', {})).lists).toEqual(after);
    expect((await runAs(owner, ws, 'outreach.lists', {})).groupsAt).toBeNull();
  });
});
