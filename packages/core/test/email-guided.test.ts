/**
 * The guided email setup's own logic (messaging/email-guided.ts), with no database: which screens are asked, who we
 * pick to read an address from its name, which address customers hear from, what each screen still needs, the plan
 * "Set it up" writes, and the side list's answers so far.
 */
import { describe, expect, it } from 'vitest';
import {
  EmailGuidedAnswers,
  emailGuidedAnswersFrom,
  emailGuidedFirstProblemScreen,
  emailGuidedFound,
  emailGuidedIdeas,
  emailGuidedLeft,
  emailGuidedMailLabel,
  emailGuidedOldRecords,
  emailGuidedOurRecordFound,
  emailGuidedPlan,
  emailGuidedProblems,
  emailGuidedQuestionOf,
  emailGuidedReaderPick,
  emailGuidedReceive,
  emailGuidedRows,
  emailGuidedScreensFor,
  emailGuidedSender,
  emailGuidedSoFar,
  emailGuidedStep,
  EMAIL_GUIDED_WORDS,
  NO_EMAIL_SETUP,
  startingEmailGuidedAnswers,
  type EmailGuidedAnswersInput,
  type EmailSetupDomain,
  type EmailSetupState,
} from '../src';

const ME = '00000000-0000-4000-8000-000000000002';
const SOMEONE = '00000000-0000-4000-8000-000000000003';
const DOMAIN_ID = '00000000-0000-4000-8000-000000000001';
const W = EMAIL_GUIDED_WORDS;

const state = (over: Partial<EmailSetupState> = {}): EmailSetupState => ({
  ...NO_EMAIL_SETUP,
  businessName: 'Burroughs Digital',
  slug: 'burroughs-digital',
  myEmail: 'blake@gmail.com',
  myFirstName: 'Blake',
  myUserId: ME,
  aiTeammate: { name: 'Ava', on: true },
  free: {
    id: '00000000-0000-4000-8000-000000000009',
    localPart: 'burroughs-digital-a2ceda',
    address: 'burroughs-digital-a2ceda@mail.handsfreeos.com',
    displayName: 'Burroughs Digital',
    isDefault: true,
  },
  ...over,
});
const siteground = {
  domain: 'burroughs.digital',
  mailHost: 'other' as const,
  dnsHost: 'siteground',
  mxRecords: [
    { host: 'mx10.antispam.mailspamprotection.com', priority: 10 },
    { host: 'mx20.antispam.mailspamprotection.com', priority: 20 },
    { host: 'mx30.antispam.mailspamprotection.com', priority: 30 },
  ],
  lookedAt: '2026-11-22T18:00:00.000Z',
};
const domain = (over: Partial<EmailSetupDomain> = {}): EmailSetupDomain => ({
  id: DOMAIN_ID,
  domain: 'burroughs.digital',
  status: 'verified',
  receiving: 'off',
  mailHost: 'other',
  dnsHost: 'siteground',
  plan: {},
  records: [],
  mxRecords: siteground.mxRecords,
  lastCheckedAt: null,
  lastError: null,
  ...over,
});
const answers = (over: EmailGuidedAnswersInput = {}): EmailGuidedAnswers =>
  EmailGuidedAnswers.parse({
    with: 'domain',
    domain: 'burroughs.digital',
    freeLocal: 'burroughsdigital',
    name: 'Burroughs Digital',
    addresses: [
      { local: 'blake', reader: 'me' },
      { local: 'office', reader: 'team' },
    ],
    receive: true,
    by: ME,
    ...over,
  });

describe('the guided email setup’s questions', () => {
  it('asks five on the business’s own website name, and one with a free address', () => {
    expect(emailGuidedScreensFor(answers())).toHaveLength(6);
    expect(emailGuidedQuestionOf('sender', answers())).toEqual({ n: 4, of: 5 });
    expect(emailGuidedQuestionOf('review', answers())).toBeNull();
    const free = answers({ with: 'free' });
    expect(emailGuidedScreensFor(free)).toEqual(['which', 'review']);
    expect(emailGuidedQuestionOf('which', free)).toEqual({ n: 1, of: 1 });
    expect(emailGuidedStep('which', free, 1)).toBe('review');
    expect(emailGuidedStep('review', free, -1)).toBe('which');
    expect(emailGuidedStep('which', answers(), -1)).toBeNull();
    expect(emailGuidedStep('receive', answers(), 1)).toBe('review');
  });

  it('starts from the website name the business most likely owns, with one shared address', () => {
    const a = startingEmailGuidedAnswers(state({ websiteDomain: 'burroughs.digital' }));
    expect(a).toMatchObject({
      with: 'domain',
      domain: 'burroughs.digital',
      freeLocal: 'burroughsdigital',
      name: 'Burroughs Digital',
      addresses: [{ local: 'hello', reader: 'team' }],
      by: ME,
    });
    // Gmail isn't a name a business owns: the free address is the pick.
    expect(startingEmailGuidedAnswers(state())).toMatchObject({ with: 'free', addresses: [] });
  });

  it('starts from the plan when the website name is still waiting on its records', () => {
    const a = startingEmailGuidedAnswers(
      state({
        domains: [
          domain({
            status: 'pending',
            plan: {
              team: { localPart: 'office', displayName: 'Burroughs' },
              addresses: [
                { localPart: 'blake', userId: ME, aiReads: true },
                { localPart: 'pat', userId: SOMEONE },
                { localPart: 'info' },
              ],
              receive: false,
            },
          }),
        ],
      }),
    );
    expect(a).toMatchObject({ domain: 'burroughs.digital', name: 'Burroughs', sender: 'office' });
    expect(a.receive).toBe(false);
    // Someone else's planned address isn't this person's to answer for.
    expect(a.addresses.map((x) => [x.local, x.reader, x.aiReads])).toEqual([
      ['office', 'team', false],
      ['blake', 'me', true],
      ['info', 'team', false],
    ]);
  });

  it('reads saved answers forgivingly, and never someone else’s', () => {
    expect(emailGuidedAnswersFrom({ with: 'free', by: ME }, ME)?.with).toBe('free');
    expect(emailGuidedAnswersFrom({ with: 'free', by: SOMEONE }, ME)).toBeNull();
    expect(emailGuidedAnswersFrom({}, ME)).toBeNull();
    expect(emailGuidedAnswersFrom({ with: 'pigeon' }, ME)).toBeNull();
    expect(emailGuidedAnswersFrom(null, ME)).toBeNull();
  });
});

describe('the addresses', () => {
  it('picks who reads one from its name', () => {
    const s = state();
    expect(emailGuidedReaderPick('Blake', s)).toBe('me');
    expect(emailGuidedReaderPick('office', s)).toBe('team');
    expect(emailGuidedReaderPick('', s)).toBe('team');
    expect(emailGuidedReaderPick('b.burroughs', state({ myEmail: 'b.burroughs@gmail.com' }))).toBe(
      'me',
    );
  });

  it('lists the ones already set up first, and leaves out a row that repeats one', () => {
    const s = state({
      addresses: [
        {
          id: 'a1',
          address: 'office@burroughs.digital',
          localPart: 'office',
          domain: 'burroughs.digital',
          reader: 'team',
          aiReads: false,
          isDefault: true,
        },
        {
          id: 'a2',
          address: 'burroughsdigital@mail.handsfreeos.com',
          localPart: 'burroughsdigital',
          domain: null,
          reader: 'team',
          aiReads: false,
          isDefault: false,
        },
      ],
    });
    const rows = emailGuidedRows(
      answers({
        addresses: [
          { local: 'Blake ', reader: 'me', aiReads: true },
          { local: 'office' },
          { local: '' },
        ],
      }),
      s,
    );
    expect(rows.map((r) => [r.local, r.reader, r.aiReads, r.existingId, r.index])).toEqual([
      ['office', 'team', false, 'a1', null],
      ['blake', 'me', true, null, 0],
    ]);
    // Its name isn't offered again.
    expect(emailGuidedIdeas(answers(), s)).toEqual([
      'info',
      'hello',
      'bookings',
      'billing',
      'sales',
    ]);
  });

  it('has customers hear from a team address: the one picked, else today’s, else the first', () => {
    const s = state();
    expect(emailGuidedSender(answers(), s)?.local).toBe('office');
    const two = answers({
      addresses: [{ local: 'info' }, { local: 'office' }, { local: 'blake', reader: 'me' }],
    });
    expect(emailGuidedSender(two, s)?.local).toBe('info');
    expect(emailGuidedSender({ ...two, sender: 'office' }, s)?.local).toBe('office');
    // One only its person reads can't send for the business, however it was picked.
    expect(emailGuidedSender({ ...two, sender: 'blake' }, s)?.local).toBe('info');
    expect(
      emailGuidedSender(answers({ addresses: [{ local: 'blake', reader: 'me' }] }), s),
    ).toBeNull();
  });
});

describe('where the mail arrives', () => {
  it('knows the website name from its look-up, then from the business’s own records', () => {
    const looked = state({ lookup: siteground });
    expect(emailGuidedFound(looked, answers())).toMatchObject({
      mailHost: 'other',
      dnsHost: 'siteground',
      missing: false,
    });
    expect(emailGuidedMailLabel(emailGuidedFound(looked, answers()))).toBe('SiteGround');
    expect(emailGuidedFound(looked, answers({ domain: 'elsewhere.com' }))).toBeNull();
    const added = state({ lookup: null, domains: [domain({ mailHost: 'google' })] });
    expect(emailGuidedMailLabel(emailGuidedFound(added, answers()))).toBe(
      'Google Workspace (Gmail)',
    );
    expect(W.foundAt('SiteGround', 'SiteGround')).toContain('its mail goes there today');
  });

  it('is the person’s pick when mail goes somewhere today, and ours when nobody gets any', () => {
    const elsewhere = state({ lookup: siteground });
    expect(emailGuidedReceive(answers({ receive: null }), elsewhere)).toEqual({
      fixed: false,
      value: null,
    });
    expect(emailGuidedProblems('receive', answers({ receive: null }), elsewhere)).toEqual([
      { path: 'email.receive', message: W.receiveMissing },
    ]);
    const nobody = state({ lookup: { ...siteground, mailHost: 'none', mxRecords: [] } });
    expect(emailGuidedReceive(answers({ receive: null }), nobody).value).toBe(true);
    // It already comes here: nothing to pick.
    const here = state({ domains: [domain({ receiving: 'on' })] });
    expect(emailGuidedReceive(answers({ receive: false }), here)).toEqual({
      fixed: true,
      value: true,
    });
  });

  it('lists the old mail records to delete on the last step', () => {
    const s = state();
    const d = domain({
      receiving: 'pending',
      mxRecords: [{ host: 'inbound.postmarkapp.com', priority: 10 }, ...siteground.mxRecords],
    });
    expect(emailGuidedLeft(d)).toBe('mail');
    expect(emailGuidedOldRecords(d, s)).toHaveLength(3);
    expect(emailGuidedOurRecordFound(d, s)).toBe(true);
    expect(emailGuidedOurRecordFound(domain(), s)).toBe(false);
    expect(emailGuidedLeft(domain({ status: 'pending' }))).toBe('records');
    expect(emailGuidedLeft(domain({ receiving: 'on' }))).toBe('done');
    expect(emailGuidedLeft(null)).toBe('done');
  });
});

describe('what each screen needs', () => {
  const s = state({ lookup: siteground });
  const paths = (screen: Parameters<typeof emailGuidedProblems>[0], a: EmailGuidedAnswers) =>
    emailGuidedProblems(screen, a, s).map((p) => p.path);

  it('checks the email picked', () => {
    expect(paths('which', answers())).toEqual([]);
    expect(paths('which', answers({ with: null }))).toEqual(['email.with']);
    expect(paths('which', answers({ domain: 'gmail.com' }))).toEqual(['email.domain']);
    expect(paths('which', answers({ domain: 'not a name' }))).toEqual(['email.domain']);
    expect(paths('which', answers({ with: 'free', freeLocal: 'support' }))).toEqual([
      'email.freeLocal',
    ]);
  });

  it('checks the addresses, each by its own row', () => {
    expect(paths('addresses', answers({ addresses: [] }))).toEqual(['email.addresses']);
    expect(
      paths(
        'addresses',
        answers({ addresses: [{ local: 'office' }, { local: 'two words' }, { local: 'Office' }] }),
      ),
    ).toEqual(['email.addresses.1.local', 'email.addresses.2.local']);
  });

  it('needs one the team reads, and says so where it can be fixed', () => {
    const mine = answers({ addresses: [{ local: 'blake', reader: 'me' }] });
    expect(emailGuidedProblems('readers', mine, s)).toEqual([
      { path: 'email.readers', message: W.teamMissing },
    ]);
    expect(emailGuidedFirstProblemScreen(mine, s)).toBe('readers');
    expect(emailGuidedFirstProblemScreen(answers(), s)).toBeNull();
  });

  it('checks everything at once for “Set it up”, the name customers see with it', () => {
    expect(paths('review', answers())).toEqual([]);
    expect(paths('review', answers({ name: ' ', receive: null }))).toEqual([
      'email.receive',
      'email.name',
    ]);
    expect(paths('review', answers({ with: 'free', name: '' }))).toEqual(['email.name']);
  });
});

describe('“Set it up”', () => {
  it('plans the address customers hear from, the others, and where the mail arrives', () => {
    const a = answers({
      addresses: [
        { local: 'blake', reader: 'me', aiReads: true },
        { local: 'office', reader: 'team' },
        { local: 'info', reader: 'team', aiReads: true },
      ],
    });
    expect(emailGuidedPlan(a, state(), ME)).toEqual({
      team: { localPart: 'office', displayName: 'Burroughs Digital' },
      // Ava only ever reads an address one person reads.
      addresses: [{ localPart: 'blake', userId: ME, aiReads: true }, { localPart: 'info' }],
      receive: true,
    });
  });

  it('leaves alone what is already set up, and keeps someone else’s planned address', () => {
    const s = state({
      domains: [
        domain({
          receiving: 'on',
          plan: { addresses: [{ localPart: 'pat', userId: SOMEONE, aiReads: true }] },
        }),
      ],
      addresses: [
        {
          id: 'a1',
          address: 'office@burroughs.digital',
          localPart: 'office',
          domain: 'burroughs.digital',
          reader: 'team',
          aiReads: false,
          isDefault: true,
        },
      ],
    });
    expect(emailGuidedPlan(answers({ addresses: [{ local: 'sales' }] }), s, ME)).toEqual({
      team: { localPart: 'office', displayName: 'Burroughs Digital' },
      addresses: [{ localPart: 'sales' }, { localPart: 'pat', userId: SOMEONE, aiReads: true }],
    });
  });
});

describe('“Your email so far”', () => {
  it('says each answer in a few words', () => {
    expect(emailGuidedSoFar(answers(), state({ lookup: siteground }))).toEqual({
      which: ['Your own, at burroughs.digital'],
      addresses: ['blake@ and office@'],
      readers: ['blake@: only you, Ava off', 'office@: the team'],
      sender: ['office@'],
      receive: ['HandsFreeOS'],
    });
    expect(
      emailGuidedSoFar(answers({ receive: false }), state({ lookup: siteground })).receive,
    ).toEqual(['Stays at SiteGround']);
    expect(emailGuidedSoFar(answers({ with: 'free' }), state())).toMatchObject({
      which: ['A free HandsFreeOS address'],
      addresses: null,
    });
  });
});
