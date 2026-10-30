/**
 * The person menu on someone's name (src/addons/outreach/person-menu.ts, docs/outreach.md decision 91), which the web
 * and the phone both draw from `personMenuItems`: their page first, their chat second, then the Pipeline's moves,
 * Contacts, Client, Demo booked, Later (decision 100), Don't pitch and Never contact, each as where they stand says,
 * and only the Open items with no signal. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_SKIPPED_KINDS,
  clientSetWords,
  HINT_DELAY_MS,
  isClientSkipped,
  LATER_DAYS,
  LATER_SKIPPED_KINDS,
  laterSetWords,
  mayTakeOff,
  personMenuItems,
  personMenuOfflineWords,
  type ClientSetOutput,
  type PersonMenuInput,
  type ProfileMarksOutput,
} from '../../src/addons/outreach/person-menu';
import { PARTNER_WORDS } from '../../src/addons/outreach/partners';
import { OUTREACH_WORDS } from '../../src/addons/outreach/words';
import { CLIENT_CAUSE_WORDS, CONTACTS_WORDS } from '../../src/crm/record-words';

const P = OUTREACH_WORDS.person;
const PROFILE = '00000000-0000-4000-8000-000000000001';
const PERSON = '00000000-0000-4000-8000-000000000002';

const marks = (over: Partial<ProfileMarksOutput> = {}): ProfileMarksOutput => ({
  profileId: PROFILE,
  name: 'Dana Reyes',
  platform: 'alignable',
  url: 'https://www.alignable.com/austin-tx/reyes-plumbing',
  personId: null,
  partner: false,
  demoBooked: false,
  laterUntil: null,
  client: { on: false, tagged: false, because: null },
  dontPitch: null,
  neverContact: null,
  canTakeOff: { dontPitch: false, neverContact: false },
  ...over,
});

const menu = (over: Partial<PersonMenuInput> = {}) =>
  personMenuItems({
    row: { url: 'https://www.alignable.com/austin-tx/reyes-plumbing', platform: 'alignable' },
    marks: marks(),
    contactsWrite: true,
    online: true,
    ...over,
  });
const keys = (items: ReturnType<typeof menu>) => items.map((i) => i.key);
const item = (items: ReturnType<typeof menu>, key: string) => items.find((i) => i.key === key);

describe('the person menu', () => {
  it('opens their page first, and their chat second only when it’s known', () => {
    const items = menu();
    expect(items[0]).toMatchObject({
      key: 'open-page',
      kind: 'open',
      label: 'Open on Alignable',
      url: 'https://www.alignable.com/austin-tx/reyes-plumbing',
      enabled: true,
      needsSignal: false,
      testId: 'person-open-page',
    });
    expect(keys(items)).not.toContain('open-chat');
    const fb = menu({
      row: {
        url: 'https://www.facebook.com/dana.reyes.7',
        platform: 'facebook',
        threadKey: '100077712345',
      },
    });
    expect(keys(fb).slice(0, 2)).toEqual(['open-page', 'open-chat']);
    expect(fb[1]).toMatchObject({ kind: 'open', label: 'Open in Messenger' });
    expect(fb[1]!.url).toContain('100077712345');
  });

  it('lists everything in one order, the Pipeline’s moves after the links', () => {
    const items = menu({
      row: {
        url: 'https://www.facebook.com/dana.reyes.7',
        platform: 'facebook',
        threadKey: '100077712345',
      },
      moves: [
        { key: 'ready', label: 'Ready to pitch' },
        { key: 'lost', label: 'Not a fit', danger: true },
      ],
    });
    expect(keys(items)).toEqual([
      'open-page',
      'open-chat',
      'move-to',
      'move-ready',
      'move-lost',
      'add-contact',
      'mark-client',
      'demo',
      'potential-partner',
      'later',
      'dont-pitch',
      'never-contact',
    ]);
    expect(item(items, 'move-lost')).toMatchObject({
      move: 'lost',
      danger: true,
      testId: 'pipeline-mark-lost',
    });
    expect(item(items, 'move-to')).toMatchObject({ kind: 'line', label: P.moveTo });
  });

  it('marks a client, takes the tag off, or says why Contacts counts them one', () => {
    expect(item(menu(), 'mark-client')).toMatchObject({
      label: P.markClient,
      enabled: true,
      testId: 'person-client',
    });
    const tagged = menu({
      marks: marks({ personId: PERSON, client: { on: true, tagged: true, because: null } }),
    });
    expect(item(tagged, 'not-client')).toMatchObject({ label: P.notClient, kind: 'action' });
    expect(keys(tagged)).toContain('in-contacts');
    const paid = menu({
      marks: marks({ personId: PERSON, client: { on: true, tagged: true, because: 'paid' } }),
    });
    expect(keys(paid)).not.toContain('not-client');
    expect(item(paid, 'client-line')).toMatchObject({
      kind: 'line',
      enabled: false,
      label: `A client in Contacts: ${CLIENT_CAUSE_WORDS.paid}`,
    });
    // Someone kept under the same name as a client on the same network.
    const twin = menu({ marks: marks({ client: { on: true, tagged: false, because: null } }) });
    expect(item(twin, 'client-line')?.label).toBe('Same name as a client in Contacts');
  });

  it('gives a partner no Client or Demo booked', () => {
    const items = menu({ marks: marks({ partner: true }) });
    expect(keys(items)).not.toContain('mark-client');
    expect(keys(items)).not.toContain('demo');
    expect(keys(items)).toContain('dont-pitch');
    // Before the marks come, the row says so.
    expect(
      keys(menu({ marks: null, row: { url: null, platform: 'facebook', partner: true } })),
    ).toEqual(['add-contact', 'later', 'dont-pitch', 'never-contact']);
  });

  it('offers Add to Contacts and Client only to someone who adds and edits customers', () => {
    const items = menu({ contactsWrite: false });
    expect(keys(items)).not.toContain('add-contact');
    expect(keys(items)).not.toContain('mark-client');
    // A client still says why, with nothing to press.
    const tagged = menu({
      contactsWrite: false,
      marks: marks({ client: { on: true, tagged: true, because: null } }),
    });
    expect(item(tagged, 'client-line')?.label).toBe(
      `A client in Contacts: ${CLIENT_CAUSE_WORDS.tagged}`,
    );
  });

  it('leaves Don’t pitch and Never contact to a row with its own switches', () => {
    const items = menu({ ownSwitches: true });
    expect(keys(items)).not.toContain('dont-pitch');
    expect(keys(items)).not.toContain('never-contact');
    // Later isn't one of those switches: it's there too.
    expect(keys(items)).toContain('later');
  });

  it('puts someone on Later for 2 weeks, or takes them off it with the day they’d be back', () => {
    expect(LATER_DAYS).toBe(14);
    expect(item(menu(), 'later')).toMatchObject({
      kind: 'action',
      label: 'Later: back in 2 weeks',
      danger: false,
      enabled: true,
      testId: 'person-later',
    });
    const on = menu({ marks: marks({ laterUntil: '2026-11-11T15:00:00.000Z' }) });
    expect(keys(on)).not.toContain('later');
    expect(item(on, 'not-later')).toMatchObject({
      label: 'Take off Later (back Nov 11)',
      testId: 'person-later',
      enabled: true,
    });
    // Before the marks come it waits, as the other toggles do; a partner has it too.
    expect(item(menu({ marks: null }), 'later')?.enabled).toBe(false);
    expect(keys(menu({ marks: marks({ partner: true }) }))).toContain('later');
  });

  it('explains every item that can be pressed, and never a line, which says it already', () => {
    const team = (userId: string, name: string, you: boolean) => ({ userId, name, you });
    const sets = [
      menu({
        row: {
          url: 'https://www.facebook.com/dana.reyes.7',
          platform: 'facebook',
          threadKey: '100077712345',
        },
        moves: (['ready', 'pitched', 'lost', 'open'] as const).map((key) => ({ key, label: key })),
        marks: marks({
          owner: team(PERSON, 'Ana Ortiz', false),
          moveTo: [team(PROFILE, 'Me', true), team(PERSON.replace('2', '3'), 'Ben Hale', false)],
        }),
      }),
      menu({
        marks: marks({
          personId: PERSON,
          demoBooked: true,
          laterUntil: '2026-11-11T15:00:00.000Z',
          client: { on: true, tagged: true, because: null },
          myPartner: { stage: 'found', marked: true },
          dontPitch: { by: 'Me', at: '2026-10-26T15:00:00.000Z', tagged: false },
          neverContact: { by: 'Me', at: '2026-10-26T15:00:00.000Z' },
          canTakeOff: { dontPitch: true, neverContact: true },
        }),
      }),
    ];
    const all = sets.flat();
    expect(keys(all)).toEqual(
      expect.arrayContaining(['open-chat', 'move-open', 'not-client', 'not-partner', 'not-later']),
    );
    for (const i of all) {
      if (i.kind === 'line') expect(i.hint, i.key).toBeNull();
      else expect(i.hint?.length, i.key).toBeGreaterThan(20);
    }
    expect(all.find((i) => i.label === 'Make them yours')?.hint).toBe(
      'Only you reach out to them from now on, from your Today. Whoever had them before stops, and their messages still waiting to go are skipped. Replies still go.',
    );
    expect(all.find((i) => i.label === 'Give them to Ben Hale')?.hint).toContain(
      'Only Ben Hale reaches out to them',
    );
    // The common tooltip wait: not a flash while the pointer passes, nor a wait that feels broken.
    expect(HINT_DELAY_MS).toBeGreaterThanOrEqual(500);
    expect(HINT_DELAY_MS).toBeLessThanOrEqual(1000);
  });

  it('says the same thing on the web and the phone after Later and Take off Later', () => {
    expect(laterSetWords('Dana Reyes', { until: '2026-11-11T15:00:00.000Z' })).toBe(
      'Dana Reyes is off your Today until Nov 11. Their replies still come.',
    );
    expect(laterSetWords('Dana Reyes', { until: null })).toBe('Dana Reyes is back on your Today.');
  });

  it('skips the person’s own messages waiting for an OK on Later, never a reply', () => {
    expect(LATER_SKIPPED_KINDS).not.toContain('reply');
    expect(LATER_SKIPPED_KINDS).not.toContain('partner_reply');
    for (const k of ['opener', 'pitch', 'follow_up', 'comment', 'partner_ask'] as const)
      expect(LATER_SKIPPED_KINDS).toContain(k);
  });

  it('takes someone off a list only for whoever may, and otherwise says who put them on', () => {
    const on = {
      dontPitch: { by: 'Riley Member', at: '2026-10-26T15:00:00.000Z', tagged: false },
      neverContact: { by: 'Riley Member', at: '2026-10-26T15:00:00.000Z' },
    };
    const mine = menu({
      marks: marks({ ...on, canTakeOff: { dontPitch: true, neverContact: true } }),
    });
    expect(item(mine, 'not-dont-pitch')).toMatchObject({ label: P.notDontPitch, danger: false });
    expect(item(mine, 'not-never-contact')).toMatchObject({ label: P.notNeverContact });
    const theirs = menu({ marks: marks(on) });
    expect(item(theirs, 'dont-pitch-line')?.label).toBe('Riley Member put them on Don’t pitch');
    expect(item(theirs, 'never-contact-line')?.label).toBe(
      'Riley Member put them on Never contact',
    );
    const family = menu({
      marks: marks({ dontPitch: { by: null, at: null, tagged: true } }),
    });
    expect(item(family, 'dont-pitch-line')?.label).toBe(P.taggedFamily);
  });

  it('keeps the toggles waiting for where they stand, and with no signal opens their page alone', () => {
    const loading = menu({
      marks: null,
      row: { url: 'https://www.facebook.com/dana.reyes.7', platform: 'facebook', personId: null },
    });
    expect(loading.filter((i) => i.enabled).map((i) => i.key)).toEqual([
      'open-page',
      'add-contact',
    ]);
    const offline = menu({
      online: false,
      row: {
        url: 'https://www.facebook.com/dana.reyes.7',
        platform: 'facebook',
        threadKey: '100077712345',
      },
      moves: [{ key: 'ready', label: 'Ready to pitch' }],
    });
    expect(offline.filter((i) => i.enabled).map((i) => i.key)).toEqual(['open-page', 'open-chat']);
    expect(offline.filter((i) => i.kind === 'action').every((i) => i.needsSignal)).toBe(true);
  });

  it('says with no signal what opens now, and never promises an Open item it doesn’t show', () => {
    const waits =
      'Contacts, Client, Demo booked, Potential partner, Later, Don’t pitch and Never contact need signal.';
    const offline = (row: PersonMenuInput['row']) =>
      personMenuOfflineWords(menu({ online: false, marks: null, row }));
    expect(offline({ url: 'https://www.facebook.com/dana.reyes.7', platform: 'facebook' })).toBe(
      `${waits} Opening their page works now.`,
    );
    expect(offline({ url: null, platform: 'facebook', threadKey: '100077712345' })).toBe(
      `${waits} Opening their chat works now.`,
    );
    // A chat with no page the list knows, or a comment's need: nothing opens until where they stand comes.
    expect(offline({ url: null, platform: 'facebook', threadKey: null })).toBe(
      `${waits} Try again when you’re back online.`,
    );
  });
});

describe('who counts as a client, in words', () => {
  it('says the Client tag beside Contacts’ own reasons', () => {
    expect(CONTACTS_WORDS.clientRule).toContain('or they’re tagged Client.');
    for (const words of Object.values(CLIENT_CAUSE_WORDS)) expect(words).not.toContain("'");
  });

  it('skips outreach for a client, never a reply or a partner’s message', () => {
    expect([...CLIENT_SKIPPED_KINDS].sort()).toEqual(
      ['check_in', 'follow_up', 'opener', 'pitch', 'reconnect', 'video'].sort(),
    );
    expect(isClientSkipped('reply')).toBe(false);
    expect(isClientSkipped('partner_ask')).toBe(false);
    expect(isClientSkipped('pitch')).toBe(true);
  });

  it('lets whoever put someone on a list, or an owner or admin, take them off', () => {
    expect(mayTakeOff('u1', 'u1', false)).toBe(true);
    expect(mayTakeOff('u2', 'u1', false)).toBe(false);
    expect(mayTakeOff('u2', 'u1', true)).toBe(true);
    expect(mayTakeOff(null, 'u1', false)).toBe(true);
  });

  it('refuses outreach to a client with what to do, by why they’re one', () => {
    expect(P.clientNoOutreach('Dana Reyes', 'tagged')).toBe(
      'Dana Reyes is a client, so Social Outreach doesn’t send them outreach. Their replies still come to Waiting for you. To reach out again, choose Not a client after all in their menu.',
    );
    expect(P.clientNoOutreach('Dana Reyes', 'paid')).toContain('because they paid a bill');
    expect(P.clientNoOutreach('Dana Reyes', null)).toContain('same name');
    expect(P.clientNeedsContacts('Dana Reyes')).toContain('Ask an owner of this business');
    expect(P.clientStill('Dana Reyes', 'paid')).toBe(
      'The Client tag is off Dana Reyes, but Contacts still counts them a client: they paid a bill. To change that, open them in Contacts.',
    );
  });

  it('says the same thing on the web and the phone after Mark as client and Not a client after all', () => {
    const out = (client: boolean, because: ClientSetOutput['because'] = null) => ({
      client,
      because,
    });
    expect(clientSetWords('Dana Reyes', true, out(true))).toBe(P.clientDone('Dana Reyes'));
    expect(clientSetWords('Dana Reyes', false, out(false))).toBe(P.clientOff('Dana Reyes'));
    expect(clientSetWords('Dana Reyes', false, out(true, 'paid'))).toBe(
      P.clientStill('Dana Reyes', 'paid'),
    );
    // Still a client for the same name as one on this network: a whole sentence, saying the tag came off and why.
    expect(clientSetWords('Dana Reyes', false, out(true))).toBe(
      'The Client tag is off Dana Reyes, but they have the same name on this network as a client in Contacts, so Social Outreach still leaves them alone. To change that, open that client in Contacts.',
    );
  });

  it('writes every new word with curly apostrophes', () => {
    const said = [
      P.nameHint,
      P.loading,
      P.markClient,
      P.notClient,
      P.clientLine('won'),
      P.clientDone('Dana Reyes'),
      P.clientOff('Dana Reyes'),
      P.clientStill('Dana Reyes', 'plan'),
      P.clientStill('Dana Reyes', null),
      P.clientNeedsContacts('Dana Reyes'),
      P.clientNoOutreach('Dana Reyes', 'job'),
      P.notDontPitch,
      P.later,
      P.notLater('2026-11-11T15:00:00.000Z'),
      P.laterDone('Dana Reyes', '2026-11-11T15:00:00.000Z'),
      P.laterOff('Dana Reyes'),
      P.putOnBy(P.neverContact, null),
      P.taggedFamily,
      P.needsSignal('page'),
      P.needsSignal(null),
      P.switchesNeedSignal,
      OUTREACH_WORDS.neverContactList.needsSignal,
      PARTNER_WORDS.needsSignal,
    ];
    for (const s of said) expect(s).not.toMatch(/'/);
    expect(P.putOnBy(P.neverContact, null)).toBe('On Never contact');
  });
});
