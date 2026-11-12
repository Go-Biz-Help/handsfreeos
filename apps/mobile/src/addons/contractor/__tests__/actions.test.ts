import {
  phoneDayVisits,
  phoneJob,
  phoneJobList,
  phoneMaterials,
  phoneNotes,
  phoneTime,
  phoneWorkOrder,
} from '@hfos/core/addons/contractor/views/phone';

import { PHONE_COMMANDS } from '@/changes/commands';
import { describe as describeChange, loadNames } from '@/changes/describe';
import { describeContractor, NO_CONTRACTOR_NAMES } from '@/changes/describe-contractor';
import type { OutboxRow } from '@/changes/outbox';
import { DALE, LONE_STAR, phone, START, type Phone } from '@/changes/__tests__/harness';

import {
  addNote,
  countMaterial,
  keepJobFile,
  removeNote,
  setBreak,
  setItem,
  setJobStatus,
  setPercent,
  setPhaseStatus,
} from '../actions';
import {
  id,
  ITEM_COIL,
  ITEM_PHOTO,
  JOB_AC,
  JOB_KITCHEN,
  MATERIAL_FILTER,
  NOTE_GATE,
  PHASE_ROUGH,
  readCopy,
  seed,
  TIME_WORK,
  TODAY,
  VISIT_NOW,
  VISIT_TOMORROW,
} from './fixtures';

/**
 * Contractor Operations' changes from the phone, on the phone's own SQLite (docs/contractor.md, "On the phone"): the
 * screens' SQL reads the business as core's views need it; a tick, a count, a break, a note and progress show at
 * once and wait on the phone; a photo item's tick waits for its photo; a job's status and taking a note off go
 * straight to HandsFreeOS; and each change waiting says what it is, under its job.
 */

let mockPhone: Phone;
let mockIds = 0;
jest.mock('@/changes', () => ({
  change: (...args: unknown[]) =>
    (mockPhone.changes.change as (...a: unknown[]) => unknown)(...args),
  changes: {
    addPhoto: (...args: unknown[]) =>
      (mockPhone.changes.addPhoto as (...a: unknown[]) => unknown)(...args),
  },
  newId: () => {
    mockIds += 1;
    return `00000000-0000-4000-a000-${String(mockIds).padStart(12, '0')}`;
  },
}));

const at = { today: TODAY, now: START };
const DAY = {
  from: Date.parse('2026-09-16T05:00:00.000Z'),
  to: Date.parse('2026-09-17T05:00:00.000Z'),
};
const outbox = (p: Phone) => p.db.rows<OutboxRow>('SELECT * FROM outbox ORDER BY seq');

beforeEach(() => {
  mockPhone = phone();
  seed(mockPhone);
});

describe('the phone’s copy, read with the screens’ SQL', () => {
  it('lists my jobs, the late ones and today’s visits as the web does', () => {
    const copy = readCopy(mockPhone);
    const mine = phoneJobList(copy, { filter: 'mine', me: DALE }, at);
    expect(mine.jobs.map((j) => [j.name, j.percentDone, j.daysLate])).toEqual([
      // A project's % is the average of its phases'; it was due on the 10th.
      ['Hart kitchen remodel', 50, 6],
      ['Lopez AC tune-up', 40, null],
    ]);
    expect(mine.jobs[1]).toMatchObject({
      customer: { name: 'Maria Lopez' },
      property: { name: '418 Maple Ave, Houston' },
      lead: { name: 'Dale Carter' },
    });
    expect(phoneJobList(copy, { filter: 'late', me: DALE }, at).jobs.map((j) => j.name)).toEqual([
      'Hart kitchen remodel',
    ]);
    expect(
      phoneJobList(copy, { filter: 'all', includeClosed: true, search: 'roof', me: DALE }, at).jobs,
    ).toHaveLength(1);

    const today = phoneDayVisits(copy, { ...DAY, me: DALE });
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({
      appointmentId: VISIT_NOW,
      stage: 'in_progress',
      job: { name: 'Lopez AC tune-up' },
      crew: 'Crew A',
      checklist: { total: 3, done: 0, requiredLeft: 2 },
      // The refrigerant, needed on any visit, isn't all here.
      materialsMissing: 1,
    });
    expect(phoneDayVisits(copy, DAY)).toHaveLength(1);
  });

  it('reads one job whole, and a visit’s work order from the visit alone', () => {
    const job = phoneJob(readCopy(mockPhone, { kind: 'job', jobId: JOB_KITCHEN }), JOB_KITCHEN, at);
    expect(job?.phaseList.map((p) => [p.name, p.status, p.daysLate])).toEqual([
      ['Demo', 'done', null],
      ['Rough-in', 'in_progress', 4],
      ['Finish', 'not_started', null],
    ]);
    expect(job?.team).toEqual([{ userId: DALE, name: 'Dale Carter' }]);
    expect(job?.visits.map((v) => v.appointmentId)).toEqual([VISIT_TOMORROW]);

    const copy = readCopy(mockPhone, { kind: 'visit', appointmentId: VISIT_NOW });
    const order = phoneWorkOrder(copy, VISIT_NOW);
    expect(order).toMatchObject({
      visit: { title: 'AC tune-up', stage: 'in_progress' },
      job: { id: JOB_AC, name: 'Lopez AC tune-up' },
      crew: { name: 'Crew A' },
      people: [{ name: 'Dale Carter' }],
      instructions: 'Park on the street.',
    });
    expect(order?.items.map((i) => [i.label, i.kind, i.required])).toEqual([
      ['Clean the condenser coil', 'check', true],
      ['Photo of the data plate', 'photo', true],
      ['Tidy up', 'check', false],
    ]);
    expect(order?.materials.map((m) => [m.name, m.short])).toEqual([
      ['Filter 20x25', 0],
      ['Refrigerant', 2],
    ]);
    // The other job's rows aren't read for this screen.
    expect(copy.jobs.has(JOB_KITCHEN)).toBe(false);
    expect(phoneWorkOrder(copy, id(999))).toBeNull();
  });
});

describe('changes from the field', () => {
  it('show at once in the phone’s copy, wait on the phone, then go in the order they were made', async () => {
    const p = mockPhone;
    await setItem({ workspaceId: LONE_STAR, itemId: ITEM_COIL, done: true, userId: DALE });
    await countMaterial({
      workspaceId: LONE_STAR,
      materialId: MATERIAL_FILTER,
      used: 1,
      wasted: 0.5,
    });
    await setBreak({
      workspaceId: LONE_STAR,
      jobId: JOB_AC,
      appointmentId: VISIT_NOW,
      userId: DALE,
      onBreak: true,
      running: { entryId: TIME_WORK },
    });
    await addNote({
      workspaceId: LONE_STAR,
      jobId: JOB_AC,
      userId: DALE,
      appointmentId: VISIT_NOW,
      body: ' Coil was filthy. ',
    });
    await setPercent(LONE_STAR, JOB_AC, 70);
    await setPhaseStatus({
      workspaceId: LONE_STAR,
      phaseId: PHASE_ROUGH,
      status: 'done',
      percentDone: 50,
    });

    const copy = readCopy(p, { kind: 'visit', appointmentId: VISIT_NOW });
    const order = phoneWorkOrder(copy, VISIT_NOW)!;
    expect(order.items[0]).toMatchObject({ done: true, doneBy: 'Dale Carter' });
    expect(order.progress).toEqual({ total: 3, done: 1, requiredLeft: 1 });
    expect(phoneMaterials(copy, JOB_AC, VISIT_NOW).materials[0]).toMatchObject({
      used: 1,
      wasted: 0.5,
      left: 0.5,
    });
    const time = phoneTime(copy, JOB_AC, { appointmentId: VISIT_NOW, me: DALE, now: START });
    expect(time.mine).toMatchObject({ kind: 'break', appointmentId: VISIT_NOW });
    expect(time.entries.find((e) => e.id === TIME_WORK)?.endedAt).not.toBeNull();
    expect(time.totals.running).toBe(1);
    const [newest] = phoneNotes(copy, JOB_AC, VISIT_NOW).notes;
    expect(newest).toMatchObject({ body: 'Coil was filthy.', by: { name: 'Dale Carter' } });
    expect(phoneJob(copy, JOB_AC, at)?.percentDone).toBe(70);
    // The phase done moves its project along at once: two of three phases done.
    const kitchen = phoneJob(readCopy(p), JOB_KITCHEN, at)!;
    expect([kitchen.percentDone, kitchen.phases.done]).toEqual([67, 2]);

    const names = [
      'contractor.work_order.item_set',
      'contractor.material.count',
      'contractor.time.set_break',
      'contractor.note.add',
      'contractor.job.set_percent',
      'contractor.phase.update',
    ];
    expect(outbox(p).map((r) => r.name)).toEqual(names);
    expect(p.api.requests).toHaveLength(0);
    // The note takes the phone's id, so the note on the phone and on HandsFreeOS are one.
    expect(JSON.parse(outbox(p)[3]!.input)).toEqual({
      workspaceId: LONE_STAR,
      jobId: JOB_AC,
      id: newest!.id,
      appointmentId: VISIT_NOW,
      body: 'Coil was filthy.',
    });

    await p.sync();
    expect(p.api.ran()).toEqual(names);
  });

  it('unticks an item, and never counts a material under nothing', async () => {
    await setItem({ workspaceId: LONE_STAR, itemId: ITEM_COIL, done: true, userId: DALE });
    await setItem({ workspaceId: LONE_STAR, itemId: ITEM_COIL, done: false, userId: DALE });
    await countMaterial({ workspaceId: LONE_STAR, materialId: MATERIAL_FILTER, used: -3 });
    const copy = readCopy(mockPhone, { kind: 'visit', appointmentId: VISIT_NOW });
    expect(phoneWorkOrder(copy, VISIT_NOW)!.items[0]).toMatchObject({ done: false, doneBy: null });
    expect(phoneMaterials(copy, JOB_AC).materials[0]).toMatchObject({ used: 0, left: 2 });
  });

  it('holds a photo item’s tick until its photo is uploaded', async () => {
    const p = mockPhone;
    const fileId = id(900);
    p.storage.keep(`${fileId}.jpg`, 2_000_000);
    const upload = await keepJobFile(LONE_STAR, JOB_AC, {
      fileId,
      localName: `${fileId}.jpg`,
      sizeBytes: 2_000_000,
    });
    await setItem({
      workspaceId: LONE_STAR,
      itemId: ITEM_PHOTO,
      done: true,
      userId: DALE,
      fileId,
      dependsOn: [upload],
    });
    const tick = outbox(p).find((r) => r.name === 'contractor.work_order.item_set')!;
    expect(JSON.parse(tick.depends_on ?? '[]')).toEqual([upload]);
    expect(JSON.parse(tick.input)).toMatchObject({ itemId: ITEM_PHOTO, done: true, fileId });
    // Done on the phone at once; its photo isn't in the phone's copy of the job's files until it's uploaded.
    const item = phoneWorkOrder(
      readCopy(p, { kind: 'visit', appointmentId: VISIT_NOW }),
      VISIT_NOW,
    )!.items[1]!;
    expect(item).toMatchObject({ done: true, file: null });

    await p.settle();
    await p.sync();
    const ran = p.api.ran();
    expect(ran).toEqual(expect.arrayContaining(['file.confirm', 'contractor.work_order.item_set']));
    expect(ran.indexOf('contractor.work_order.item_set')).toBeGreaterThan(
      ran.indexOf('file.confirm'),
    );
  });

  it('sends a job’s status and a note’s removal straight away, and refuses both with no signal', async () => {
    const p = mockPhone;
    await setJobStatus({
      workspaceId: LONE_STAR,
      jobId: JOB_AC,
      status: 'on_hold',
      reason: ' Waiting on the part ',
    });
    await removeNote(LONE_STAR, NOTE_GATE);
    expect(p.api.requests.map((r) => [r.name, JSON.parse(r.input)])).toEqual([
      [
        'contractor.job.set_status',
        { workspaceId: LONE_STAR, jobId: JOB_AC, status: 'on_hold', reason: 'Waiting on the part' },
      ],
      ['contractor.note.remove', { workspaceId: LONE_STAR, noteId: NOTE_GATE }],
    ]);

    p.setOnline(false);
    await expect(
      setJobStatus({ workspaceId: LONE_STAR, jobId: JOB_AC, status: 'done' }),
    ).rejects.toMatchObject({ message: 'This needs signal.' });
    await expect(removeNote(LONE_STAR, NOTE_GATE)).rejects.toMatchObject({
      message: 'This needs signal.',
    });
    expect(outbox(p)).toHaveLength(0);
  });
});

describe('Contractor Operations’ changes, in words', () => {
  it('each say what they did: none is just “a change”', () => {
    const names = Object.keys(PHONE_COMMANDS).filter((n) => n.startsWith('contractor.'));
    expect(names).toHaveLength(8);
    for (const name of names) {
      const words = describeContractor(name, { workspaceId: LONE_STAR }, NO_CONTRACTOR_NAMES)!;
      expect({ name, title: words.title }).not.toEqual({
        name,
        title: expect.stringMatching(/^A change/),
      });
      expect(words.part).not.toBe('a change');
    }
    expect(describeContractor('realestate.duty.done', {}, NO_CONTRACTOR_NAMES)).toBeNull();
  });

  it('name what they point at from the phone’s copy, under their job', async () => {
    const p = mockPhone;
    await setItem({ workspaceId: LONE_STAR, itemId: ITEM_COIL, done: true, userId: DALE });
    await countMaterial({ workspaceId: LONE_STAR, materialId: MATERIAL_FILTER, used: 1 });
    await setBreak({
      workspaceId: LONE_STAR,
      jobId: JOB_AC,
      appointmentId: VISIT_NOW,
      userId: DALE,
      onBreak: true,
      running: { entryId: TIME_WORK },
    });
    await addNote({
      workspaceId: LONE_STAR,
      jobId: JOB_AC,
      userId: DALE,
      body: 'Coil was filthy.',
    });
    await addNote({ workspaceId: LONE_STAR, jobId: JOB_AC, userId: DALE, audioFileId: id(901) });
    await setPercent(LONE_STAR, JOB_AC, 70);
    await setPhaseStatus({
      workspaceId: LONE_STAR,
      phaseId: PHASE_ROUGH,
      status: 'done',
      percentDone: 50,
    });
    const fileId = id(902);
    p.storage.keep(`${fileId}.jpg`, 1_000);
    await keepJobFile(LONE_STAR, JOB_AC, { fileId, localName: `${fileId}.jpg`, sizeBytes: 1_000 });

    const rows = outbox(p);
    const names = await loadNames(p.db, rows);
    expect(
      rows.map((r) => {
        const w = describeChange(r, names);
        return [w.title, w.about?.name ?? null];
      }),
    ).toEqual([
      ['Ticked “Clean the condenser coil”', 'Lopez AC tune-up'],
      ['Counted Filter 20x25', 'Lopez AC tune-up'],
      ['Started a break', 'Lopez AC tune-up'],
      ['Note from the field', 'Lopez AC tune-up'],
      ['Voice note from the field', 'Lopez AC tune-up'],
      ['Marked 70% done', 'Lopez AC tune-up'],
      ['“Rough-in” marked done', 'Hart kitchen remodel'],
      // A photo kept for a job is named for it.
      ['Photo for Lopez AC tune-up', null],
    ]);
    expect(describeChange(rows[3]!, names).quote).toBe('Coil was filthy.');
  });
});
