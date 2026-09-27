/**
 * The CRM screens' words and working out (M10 step 15): the record head, the timeline's sentences, the pipeline's
 * totals and a lead card's lines, tasks' due groups, and files. The web's record page, pipeline, tasks and files read
 * these, and so does the phone, so a test here is a test of both.
 */
import { describe, expect, it } from 'vitest';
import {
  addedLine,
  addressLine,
  archivedNotice,
  boardStages,
  customerSince,
  daysLabel,
  describeTimeline,
  dueLabel,
  fileKindLabel,
  fileLine,
  filePhoneLine,
  formatBytes,
  formatDate,
  formatDateOnly,
  initialsOf,
  inStageSince,
  lastContactWords,
  leadCardWhen,
  leadOutcomeLine,
  monthYear,
  moveChoices,
  moveToast,
  owesWords,
  PIPELINE_WORDS,
  pipelineSummary,
  possibleDuplicateWords,
  recordTabLabel,
  stageAgeWords,
  stageTotals,
  taskDueBucket,
  taskRelatedLine,
  TASK_GROUPS,
  tasksSummary,
  timelineActor,
  timelineBody,
  timelineEditable,
  timelineFormatAt,
  timelineRunId,
  timelineTone,
  totalsAfterMove,
  type TimelineEntry,
} from '../src/index';

const TZ = 'America/Chicago';

const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  entry: 'activity',
  kind: 'note',
  subtype: null,
  body: null,
  occurredAt: '2026-09-17T15:00:00.000Z',
  actor: { id: '22222222-2222-4222-8222-222222222222', fullName: 'Dale Ramsey' },
  actorType: 'user',
  personId: null,
  companyId: null,
  leadId: null,
  customRecordId: null,
  meta: {},
  ...over,
});

describe('dates, sizes and addresses', () => {
  const now = new Date('2026-09-17T12:00:00.000Z');

  it('writes a date the way the web always has, and adds the year only when it differs', () => {
    expect(formatDate('2026-09-21T15:05:00.000Z', {}, now)).toBe('Sep 21');
    expect(formatDate('2025-09-21T15:05:00.000Z', {}, now)).toBe('Sep 21, 2025');
    expect(formatDate(null, {}, now)).toBe('');
  });

  it('writes a time with a plain space before AM, so a phone and a browser match', () => {
    const withTime = formatDate('2026-09-21T15:05:00.000Z', { time: true }, now);
    expect(withTime).toMatch(/^Sep 21, \d{1,2}:\d{2} (AM|PM)$/);
    // The two spaces Intl slips in before AM/PM, written as escapes so they can be seen: U+202F and U+00A0.
    expect(/[\u202f\u00a0]/.test(withTime)).toBe(false);
  });

  it('reads a date-only value and a month', () => {
    expect(formatDateOnly('2026-09-21', now)).toBe('Sep 21');
    expect(formatDateOnly('2025-01-02', now)).toBe('Jan 2, 2025');
    expect(monthYear('2025-03-04T00:00:00.000Z')).toBe('Mar 2025');
  });

  it('says how long something has sat where it is', () => {
    const at = Date.parse('2026-09-17T12:00:00.000Z');
    expect(daysLabel('2026-09-17T09:00:00.000Z', at)).toBe('today');
    expect(daysLabel('2026-09-16T09:00:00.000Z', at)).toBe('1 day');
    expect(daysLabel('2026-09-12T09:00:00.000Z', at)).toBe('5 days');
  });

  it('sizes a file and leaves out what is missing from an address', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(6144)).toBe('6 KB');
    expect(formatBytes(2_516_582)).toBe('2.4 MB');
    expect(formatBytes(null)).toBe('');
    expect(
      addressLine({
        line1: '1410 Oak Hollow Dr',
        line2: null,
        city: 'Houston',
        state: 'TX',
        postalCode: '77006',
      }),
    ).toBe('1410 Oak Hollow Dr, Houston, TX 77006');
    expect(
      addressLine({ line1: null, line2: null, city: 'Houston', state: null, postalCode: null }),
    ).toBe('Houston');
  });
});

describe('a record’s head', () => {
  it('names a customer since the month they arrived, and what a phone says while they are new', () => {
    expect(customerSince('2025-09-14T00:00:00.000Z')).toBe('Customer since Sep 2025');
    const now = Date.parse('2026-09-17T15:00:00.000Z');
    expect(addedLine('2026-09-17T13:00:00.000Z', 'Website form', now)).toBe(
      'Added today · Website form',
    );
    expect(addedLine('2026-09-14T13:00:00.000Z', null, now)).toBe('Added Sep 14');
  });

  it('shows what they owe only when they owe something', () => {
    expect(owesWords(255188)).toBe('Owes $2,551.88');
    expect(owesWords(0)).toBeNull();
    expect(owesWords(-40)).toBeNull();
  });

  it('counts a tab only when there is a count', () => {
    expect(recordTabLabel('leads', 1)).toBe('Leads · 1');
    expect(recordTabLabel('tasks', 0)).toBe('Tasks · 0');
    expect(recordTabLabel('details', null)).toBe('Details');
  });

  it('makes initials, and words a record made with no signal that matches one already saved', () => {
    expect(initialsOf('Maria Lopez')).toBe('ML');
    expect(initialsOf('Cher')).toBe('CH');
    expect(initialsOf('')).toBe('?');
    const words = possibleDuplicateWords({
      name: 'Maria Lopez',
      matchedOn: 'phone',
      value: '(713) 555-0190',
    });
    expect(words.title).toBe('Possible duplicate of Maria Lopez');
    expect(words.body).toContain('Same phone number, (713) 555-0190.');
    expect(words.open).toBe('Open Maria Lopez');
  });

  it('says what archiving means, and only offers Restore to someone who may', () => {
    expect(archivedNotice('person', true)).toBe(
      'This person is archived: hidden from lists and searches, history kept. Restore from the menu to use it again.',
    );
    expect(archivedNotice('company', false)).toBe(
      'This company is archived: hidden from lists and searches, history kept.',
    );
  });

  it('says how a lead ended, with who and when', () => {
    expect(
      leadOutcomeLine({ status: 'open', stageEnteredAt: '2026-09-17T14:00:00.000Z' }),
    ).toBeNull();
    const won = leadOutcomeLine({
      status: 'won',
      wonAt: new Date().toISOString(),
      by: 'Dale Ramsey',
    });
    expect(won).toMatch(/^Won today at .* · Dale Ramsey$/);
  });
});

describe('the timeline', () => {
  it('names who did it: the customer, a teammate, the AI teammate, a workflow or HandsFreeOS', () => {
    expect(timelineActor(entry({ kind: 'sms', meta: { direction: 'inbound' } }), 'Maria')).toBe(
      'Maria',
    );
    expect(timelineActor(entry())).toBe('Dale Ramsey');
    expect(
      timelineActor(entry({ actorType: 'ai_employee', meta: { aiTeammate: { name: 'Ava' } } })),
    ).toBe('Ava (AI)');
    expect(
      timelineActor(entry({ actorType: 'workflow', meta: { workflow: { name: 'New lead' } } })),
    ).toBe('Workflow: New lead');
    expect(timelineActor(entry({ actorType: 'system', actor: null }))).toBe('HandsFreeOS');
    expect(timelineActor(entry({ actorType: 'user', actor: null }))).toBe('Former member');
  });

  it('says what happened, in the web’s own sentences', () => {
    expect(describeTimeline(entry(), 'person')).toBe('added a note');
    expect(describeTimeline(entry({ kind: 'sms', meta: { direction: 'inbound' } }), 'person')).toBe(
      'texted',
    );
    expect(
      describeTimeline(
        entry({ kind: 'sms', meta: { direction: 'inbound', keyword: 'stop' } }),
        'person',
      ),
    ).toBe('opted out of texts (STOP)');
    expect(describeTimeline(entry({ kind: 'system', subtype: 'created' }), 'company')).toBe(
      'added this company',
    );
    expect(
      describeTimeline(
        entry({
          kind: 'system',
          subtype: 'stage_changed',
          meta: { title: 'New AC install', from: 'New', to: 'Won' },
        }),
        'lead',
      ),
    ).toBe('moved New AC install from New to Won');
    expect(
      describeTimeline(
        entry({
          kind: 'call',
          subtype: 'outbound',
          meta: { callId: 'c1', answeredVia: 'bridge', durationSeconds: 192 },
        }),
        'person',
      ),
    ).toBe('called · 3:12 · from their cell');
  });

  it('words a change a later one overtook, from the merge’s own meta', () => {
    const words = describeTimeline(
      entry({
        kind: 'system',
        subtype: 'edit_not_applied',
        meta: {
          label: 'phone number',
          keptBy: 'Priya',
          wanted: '(713) 555-0147',
          stays: '(713) 555-0174',
        },
      }),
      'person',
    );
    expect(words).toBe(
      'tried to change the phone number to “(713) 555-0147”, but Priya’s later change to “(713) 555-0174” was kept',
    );
  });

  it('reads an appointment’s time where the business is', () => {
    expect(timelineFormatAt('2026-09-18T15:00:00.000Z', TZ)).toBe('Fri, Sep 18 at 10:00 AM');
    expect(
      describeTimeline(
        entry({
          kind: 'system',
          subtype: 'appointment_booked',
          body: 'AC tune-up',
          meta: { startsAt: '2026-09-18T15:00:00.000Z' },
        }),
        'person',
        undefined,
        TZ,
      ),
    ).toBe('booked AC tune-up for Fri, Sep 18 at 10:00 AM');
  });

  it('shows a body only where the web shows one, and colours the dot by what happened', () => {
    expect(timelineBody(entry({ body: 'Gate code 4821' }))).toBe('Gate code 4821');
    expect(timelineBody(entry({ kind: 'system', subtype: 'created', body: 'x' }))).toBeNull();
    expect(timelineBody(entry({ kind: 'system', subtype: 'lost', body: 'Lost: price' }))).toBe(
      'price',
    );
    expect(timelineTone(entry())).toBe('accent');
    expect(timelineTone(entry({ kind: 'system', subtype: 'won' }))).toBe('success');
    expect(timelineTone(entry({ kind: 'system', subtype: 'lost' }))).toBe('danger');
    expect(
      timelineTone(entry({ actorType: 'ai_employee', meta: { aiTeammate: { name: 'Ava' } } })),
    ).toBe('ai');
  });

  it('knows which entries a person may delete, and which workflow run to link to', () => {
    expect(timelineEditable(entry())).toBe(true);
    expect(timelineEditable(entry({ kind: 'sms', meta: { direction: 'outbound' } }))).toBe(false);
    expect(timelineEditable(entry({ kind: 'system', subtype: 'created' }))).toBe(false);
    expect(
      timelineRunId(entry({ actorType: 'workflow', meta: { workflow: { runId: 'run-1' } } })),
    ).toBe('run-1');
    expect(timelineRunId(entry())).toBeNull();
  });
});

describe('the pipeline', () => {
  const stages = [
    { id: 's1', name: 'New', kind: 'open' as const, position: 0 },
    { id: 's2', name: 'Contacted', kind: 'open' as const, position: 1 },
    { id: 's3', name: 'Won', kind: 'won' as const, position: 2 },
    { id: 's4', name: 'Lost', kind: 'lost' as const, position: 3 },
  ];
  const leads = [
    { id: 'l1', stageId: 's1', valueCents: 1_850_000 },
    { id: 'l2', stageId: 's1', valueCents: 240_000 },
    { id: 'l3', stageId: 's3', valueCents: 100_000 },
  ];

  it('counts and totals each stage — the one piece of arithmetic the board and the phone share', () => {
    const board = boardStages(stages, leads);
    expect(board.map((s) => [s.name, s.count, s.valueCents])).toEqual([
      ['New', 2, 2_090_000],
      ['Contacted', 0, 0],
      ['Won', 1, 100_000],
      ['Lost', 0, 0],
    ]);
    expect(stageTotals(4, 2_185_000)).toBe('4 leads · $21,850');
    expect(stageTotals(1, 0)).toBe('1 lead · $0');
    expect(pipelineSummary(4, 2_185_000)).toBe('4 open leads · $21,850');
    expect(pipelineSummary(1, 100)).toBe('1 open lead · $1');
  });

  it('takes a stage’s totals as given when the board carries only its first cards, and moves them with a lead', () => {
    const totals = new Map([['s3', { count: 250, valueCents: 9_000_000 }]]);
    const board = boardStages(stages, leads, totals);
    expect(board.map((s) => [s.name, s.count, s.valueCents, s.leads.length])).toEqual([
      ['New', 2, 2_090_000, 2],
      ['Contacted', 0, 0, 0],
      ['Won', 250, 9_000_000, 1],
      ['Lost', 0, 0, 0],
    ]);
    const moved = totalsAfterMove(board, leads[0]!, 's3');
    expect(moved.get('s1')).toEqual({ count: 1, valueCents: 240_000 });
    expect(moved.get('s3')).toEqual({ count: 251, valueCents: 10_850_000 });
    expect(totalsAfterMove(board, leads[0]!, 's1').get('s1')).toEqual({
      count: 2,
      valueCents: 2_090_000,
    });
    expect(PIPELINE_WORDS.showMore(150)).toBe('Show more · 150 not shown');
  });

  it('says how long a lead has sat in its stage, the way the card reads it', () => {
    const now = Date.parse('2026-09-17T13:15:00.000Z');
    expect(stageAgeWords('2026-09-17T12:54:00.000Z', now)).toBe('21 min ago');
    expect(stageAgeWords('2026-09-17T12:10:00.000Z', now)).toBe('1 h ago');
    expect(stageAgeWords('2026-09-15T12:00:00.000Z', now)).toBe('2 days in stage');
    expect(leadCardWhen('Website form', '2026-09-17T12:54:00.000Z', now)).toBe(
      'Website form · 21 min ago',
    );
    expect(leadCardWhen(null, '2026-09-15T12:00:00.000Z', now)).toBe('2 days in stage');
  });

  it('words a move, and the sheet says what Won and Lost do', () => {
    expect(moveToast('New AC install', { name: 'Contacted', kind: 'open' })).toBe(
      'New AC install moved to Contacted.',
    );
    expect(moveToast('New AC install', { name: 'Won', kind: 'won' })).toBe('New AC install won.');
    expect(moveToast('New AC install', { name: 'Lost', kind: 'lost' })).toBe(
      'New AC install marked lost.',
    );
    expect(moveChoices(stages, 's1').map((c) => [c.name, c.note])).toEqual([
      ['New', 'Now'],
      ['Contacted', null],
      ['Won', 'Marks it won'],
      ['Lost', 'Asks why'],
    ]);
  });

  it('says when someone last really spoke to them, and since when a lead has been here', () => {
    const now = Date.parse('2026-09-17T13:00:00.000Z');
    expect(lastContactWords(null, now)).toBe('No contact yet');
    expect(lastContactWords('2026-09-17T09:00:00.000Z', now)).toBe('Today');
    expect(lastContactWords('2026-09-16T09:00:00.000Z', now)).toBe('Yesterday');
    expect(lastContactWords('2026-09-14T09:00:00.000Z', now)).toBe('3 days ago');
    expect(inStageSince('2026-09-17T12:51:00.000Z', now)).toMatch(
      /^Since \d{1,2}:\d{2} (AM|PM) today$/,
    );
    expect(inStageSince('2026-09-14T12:51:00.000Z', now)).toBe('Since Sep 14');
  });
});

describe('tasks', () => {
  // 10:00 AM in Houston on Thursday 17 September 2026.
  const now = new Date('2026-09-17T15:00:00.000Z');

  it('puts a task in its group where the business is, not where the phone is', () => {
    const due = (iso: string | null, allDay = false) =>
      taskDueBucket({ dueAt: iso, allDay, doneAt: null }, TZ, now);
    expect(due(null)).toBe('none');
    expect(due('2026-09-17T14:00:00.000Z')).toBe('overdue');
    expect(due('2026-09-17T21:00:00.000Z')).toBe('today');
    // Midnight UTC on the 18th is still the 17th in Houston, so an all-day task then is today, not tomorrow.
    expect(due('2026-09-18T02:00:00.000Z', true)).toBe('today');
    expect(due('2026-09-20T15:00:00.000Z')).toBe('week');
    expect(due('2026-10-20T15:00:00.000Z')).toBe('later');
    expect(
      taskDueBucket(
        { dueAt: '2026-01-01T00:00:00.000Z', allDay: false, doneAt: '2026-01-02T00:00:00.000Z' },
        TZ,
        now,
      ),
    ).toBe('none');
  });

  it('an all-day task is overdue only once its own day has passed there', () => {
    expect(
      taskDueBucket({ dueAt: '2026-09-17T05:00:00.000Z', allDay: true, doneAt: null }, TZ, now),
    ).toBe('today');
    expect(
      taskDueBucket({ dueAt: '2026-09-16T05:00:00.000Z', allDay: true, doneAt: null }, TZ, now),
    ).toBe('overdue');
  });

  it('words the end of a row, with the colour the web gives it', () => {
    expect(dueLabel({ dueAt: null, allDay: false, doneAt: null, dueBucket: 'none' }, now)).toEqual({
      text: 'No due date',
      tone: 'muted',
    });
    expect(
      dueLabel(
        {
          dueAt: '2026-09-13T15:00:00.000Z',
          allDay: true,
          doneAt: '2026-09-13T15:00:00.000Z',
          dueBucket: 'none',
        },
        now,
      ),
    ).toEqual({ text: 'Done Sep 13', tone: 'muted' });
    expect(
      dueLabel(
        { dueAt: '2026-09-21T15:00:00.000Z', allDay: false, doneAt: null, dueBucket: 'overdue' },
        now,
      ).tone,
    ).toBe('danger');
    expect(
      dueLabel(
        { dueAt: '2026-09-17T19:00:00.000Z', allDay: false, doneAt: null, dueBucket: 'today' },
        now,
      ),
    ).toEqual({ text: expect.stringMatching(/^Today \d{1,2}:\d{2} (AM|PM)$/), tone: 'accent' });
    expect(
      dueLabel(
        { dueAt: '2026-09-25T15:00:00.000Z', allDay: true, doneAt: null, dueBucket: 'week' },
        now,
      ),
    ).toEqual({ text: 'Sep 25', tone: 'muted' });
  });

  it('keeps the web’s groups and their order, and its own summary line', () => {
    expect(TASK_GROUPS.map((g) => g.label)).toEqual([
      'Overdue',
      'Today',
      'This week',
      'Later',
      'No due date',
    ]);
    expect(tasksSummary(6, 'America/Chicago')).toBe('6 open · due dates in America/Chicago');
    expect(
      taskRelatedLine({
        lead: { title: 'Roof replacement' },
        person: { fullName: 'Mike Johnson' },
        company: null,
      }),
    ).toBe('Roof replacement · Mike Johnson');
  });
});

describe('files', () => {
  it('badges a file by its type, and names it the same way on both apps', () => {
    expect(fileKindLabel('application/pdf', false)).toBe('PDF');
    expect(fileKindLabel('image/jpeg', true)).toBe('IMG');
    expect(fileKindLabel(null, false)).toBe('FILE');
    expect(
      fileLine(
        {
          sizeBytes: 2_516_582,
          uploadedBy: { fullName: 'Dale Ramsey' },
          createdAt: '2026-09-17T14:40:00.000Z',
        },
        Date.parse('2026-09-17T15:00:00.000Z'),
      ),
    ).toBe('2.4 MB · Dale Ramsey · 20 min ago');
    expect(
      filePhoneLine({ by: 'Dale', createdAt: '2026-09-17T14:24:00.000Z', sizeBytes: 2_516_582 }),
    ).toMatch(/^Dale · \d{1,2}:\d{2} (AM|PM) · 2\.4 MB$/);
  });
});
