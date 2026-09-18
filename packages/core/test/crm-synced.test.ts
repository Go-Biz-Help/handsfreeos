/**
 * A phone's own copy turned into what the web's queries answer (M10 step 15). Every column arrives as text and any of
 * them can be null, so these check that a customer, a company, a lead, a task, a file and a timeline entry come out
 * the same shape the server sends — which is what lets the phone run the web's very words over them.
 */
import { describe, expect, it } from 'vitest';
import {
  companyOfSynced,
  fileOfSynced,
  leadCardOfSynced,
  NO_NAMES,
  personOfSynced,
  taskOfSynced,
  timelineEntryOfSynced,
  timelineOrder,
  type SyncedNames,
} from '../src/index';

const TZ = 'America/Chicago';

const names: SyncedNames = {
  person: (id) => (id === 'p1' ? { fullName: 'Maria Lopez', archived: false } : null),
  company: (id) => (id === 'c1' ? { name: 'ABC Dental', archived: false } : null),
  lead: (id) => (id === 'l1' ? { title: 'New AC install' } : null),
  user: (id) => (id === 'u1' ? 'Dale Ramsey' : null),
  tags: (recordId) =>
    recordId === 'p1' ? [{ id: 't1', name: 'Residential', color: '#2d69d8' }] : [],
};

describe('a customer from the copy', () => {
  it('reads like person.get, with their tags, their address and what they may duplicate', () => {
    const person = personOfSynced(
      {
        id: 'p1',
        first_name: 'Maria',
        last_name: 'Lopez',
        email: 'maria.lopez@example.com',
        phone: '(713) 555-0174',
        phone_e164: '+17135550174',
        phone_alt: null,
        address_line1: '1410 Oak Hollow Dr',
        address_line2: null,
        city: 'Houston',
        state: 'TX',
        postal_code: '77006',
        country: 'US',
        notes: 'Gate code 4821',
        source: 'Website form',
        company_id: 'c1',
        owner_user_id: 'u1',
        archived_at: null,
        possible_duplicate_of: 'p9',
        created_at: '2026-09-17T13:00:00.000Z',
        updated_at: '2026-09-17T14:00:00.000Z',
      },
      names,
      { openLeads: 1, lastActivityAt: '2026-09-17T14:00:00.000Z' },
    );
    expect(person.fullName).toBe('Maria Lopez');
    expect(person.phone).toBe('(713) 555-0174');
    expect(person.company).toEqual({ id: 'c1', name: 'ABC Dental', archived: false });
    expect(person.owner).toEqual({ id: 'u1', fullName: 'Dale Ramsey' });
    expect(person.tags).toEqual([{ id: 't1', name: 'Residential', color: '#2d69d8' }]);
    expect(person.openLeads).toBe(1);
    expect(person.notes).toBe('Gate code 4821');
    expect(person.possibleDuplicateOf).toBe('p9');
    expect(person.address.city).toBe('Houston');
  });

  it('survives a row where everything but the id is missing', () => {
    const person = personOfSynced(
      {
        id: 'p2',
        first_name: null,
        last_name: null,
        email: null,
        phone: null,
        phone_e164: null,
        phone_alt: null,
        address_line1: null,
        address_line2: null,
        city: null,
        state: null,
        postal_code: null,
        country: null,
        notes: null,
        source: null,
        company_id: null,
        owner_user_id: null,
        archived_at: null,
        possible_duplicate_of: null,
        created_at: null,
        updated_at: null,
      },
      NO_NAMES,
    );
    expect(person.fullName).toBe('');
    expect(person.company).toBeNull();
    expect(person.owner).toBeNull();
    expect(person.tags).toEqual([]);
    expect(person.address.country).toBe('US');
  });

  it('formats a number the copy only has in E.164', () => {
    const person = personOfSynced(
      {
        id: 'p3',
        first_name: 'Rosa',
        last_name: 'Delgado',
        email: null,
        phone: null,
        phone_e164: '+17135550156',
        phone_alt: null,
        address_line1: null,
        address_line2: null,
        city: null,
        state: null,
        postal_code: null,
        country: null,
        notes: null,
        source: null,
        company_id: null,
        owner_user_id: null,
        archived_at: null,
        possible_duplicate_of: null,
        created_at: '2026-09-17T13:00:00.000Z',
        updated_at: null,
      },
      NO_NAMES,
    );
    expect(person.phone).toBe('(713) 555-0156');
  });
});

describe('a company from the copy', () => {
  it('reads like company.get', () => {
    const company = companyOfSynced(
      {
        id: 'c1',
        name: 'ABC Dental',
        email: null,
        phone: null,
        phone_e164: '+17135550100',
        website: 'abcdental.test',
        address_line1: null,
        address_line2: null,
        city: 'Houston',
        state: 'TX',
        postal_code: null,
        country: null,
        notes: null,
        source: 'Referral',
        owner_user_id: 'u1',
        archived_at: null,
        created_at: '2026-01-02T00:00:00.000Z',
        updated_at: null,
      },
      names,
    );
    expect(company.name).toBe('ABC Dental');
    expect(company.phone).toBe('(713) 555-0100');
    expect(company.owner?.fullName).toBe('Dale Ramsey');
    expect(company.website).toBe('abcdental.test');
  });
});

describe('a lead from the copy', () => {
  const row = {
    id: 'l1',
    pipeline_id: 'pl1',
    stage_id: 's1',
    person_id: 'p1',
    company_id: null,
    title: 'New AC install',
    value_cents: 1_850_000,
    source: 'Website form',
    assignee_user_id: 'u1',
    expected_close_on: '2026-09-30',
    next_action: null,
    next_action_at: null,
    status: 'open',
    won_at: null,
    lost_at: null,
    lost_reason: null,
    position: 1,
    stage_entered_at: '2026-09-17T12:51:00.000Z',
    last_contact_at: '2026-09-17T12:54:00.000Z',
    archived_at: null,
    created_at: '2026-09-17T12:51:00.000Z',
    updated_at: '2026-09-17T12:54:00.000Z',
  };
  const stage = { id: 's1', pipeline_id: 'pl1', name: 'New', kind: 'open', position: 0 };

  it('reads like a board card, its customer and its stage joined in', () => {
    const lead = leadCardOfSynced(row, stage, names);
    expect(lead.title).toBe('New AC install');
    expect(lead.stageName).toBe('New');
    expect(lead.stageKind).toBe('open');
    expect(lead.person).toEqual({ id: 'p1', fullName: 'Maria Lopez', archived: false });
    expect(lead.assignee?.fullName).toBe('Dale Ramsey');
    expect(lead.valueCents).toBe(1_850_000);
    expect(lead.needsNextAction).toBe(true);
    expect(lead.nextActionOverdue).toBe(false);
  });

  it('marks an open lead whose next action has passed, and never a won one', () => {
    const now = Date.parse('2026-09-17T15:00:00.000Z');
    const overdue = leadCardOfSynced(
      { ...row, next_action: 'Call Maria', next_action_at: '2026-09-17T14:00:00.000Z' },
      stage,
      names,
      now,
    );
    expect(overdue.nextActionOverdue).toBe(true);
    expect(overdue.needsNextAction).toBe(false);
    const won = leadCardOfSynced(
      {
        ...row,
        status: 'won',
        won_at: '2026-09-17T14:40:00.000Z',
        next_action: 'Call Maria',
        next_action_at: '2026-09-17T14:00:00.000Z',
      },
      { ...stage, kind: 'won', name: 'Won' },
      names,
      now,
    );
    expect(won.status).toBe('won');
    expect(won.nextActionOverdue).toBe(false);
  });

  it('falls back to when it was made when nothing says when it entered its stage', () => {
    const lead = leadCardOfSynced({ ...row, stage_entered_at: null }, stage, names);
    expect(lead.stageEnteredAt).toBe('2026-09-17T12:51:00.000Z');
  });
});

describe('a task, a file and a timeline entry from the copy', () => {
  it('reads a task like task.list, its bucket worked out where the business is', () => {
    const task = taskOfSynced(
      {
        id: 'tk1',
        title: 'Call Mike Johnson about the estimate',
        notes: null,
        due_at: '2026-09-21T15:00:00.000Z',
        all_day: 0,
        assignee_user_id: 'u1',
        person_id: 'p1',
        company_id: null,
        lead_id: 'l1',
        done_at: null,
        done_by: null,
        created_by: 'u1',
        created_at: '2026-09-14T00:00:00.000Z',
        updated_at: null,
      },
      names,
      TZ,
      new Date('2026-09-22T15:00:00.000Z'),
    );
    expect(task.dueBucket).toBe('overdue');
    expect(task.assignee?.fullName).toBe('Dale Ramsey');
    expect(task.person?.fullName).toBe('Maria Lopez');
    expect(task.lead).toEqual({ id: 'l1', title: 'New AC install' });
    expect(task.allDay).toBe(false);
  });

  it('reads a file like file.list, and knows a picture from a document', () => {
    const file = fileOfSynced(
      {
        id: 'f1',
        record_type: 'person',
        record_id: 'p1',
        bucket: 'files',
        object_path: 'w/1/old-condenser.jpg',
        name: 'Old condenser.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 2_516_582,
        status: 'ready',
        created_by: 'u1',
        created_at: '2026-09-17T14:24:00.000Z',
      },
      names,
    );
    expect(file.isImage).toBe(true);
    expect(file.uploadedBy?.fullName).toBe('Dale Ramsey');
    expect(file.sizeBytes).toBe(2_516_582);
  });

  it('reads a timeline entry, parsing its meta, and orders a timeline newest first', () => {
    const one = timelineEntryOfSynced(
      {
        id: 'a1',
        kind: 'system',
        subtype: 'stage_changed',
        person_id: 'p1',
        company_id: null,
        lead_id: 'l1',
        body: null,
        occurred_at: '2026-09-17T14:40:00.000Z',
        author_user_id: 'u1',
        actor_type: 'user',
        meta: '{"title":"New AC install","from":"New","to":"Won"}',
        created_at: '2026-09-17T15:57:00.000Z',
      },
      names,
    );
    expect(one.meta.to).toBe('Won');
    expect(one.actor?.fullName).toBe('Dale Ramsey');
    // What someone did in a customer's house is filed when they did it, not when the phone reached HandsFreeOS.
    expect(one.occurredAt).toBe('2026-09-17T14:40:00.000Z');

    const two = timelineEntryOfSynced(
      {
        id: 'a2',
        kind: 'note',
        subtype: null,
        person_id: 'p1',
        company_id: null,
        lead_id: null,
        body: 'Old 2.5-ton unit',
        occurred_at: '2026-09-17T14:20:00.000Z',
        author_user_id: 'u1',
        actor_type: 'user',
        meta: 'not json',
        created_at: null,
      },
      names,
    );
    expect(two.meta).toEqual({});
    expect(timelineOrder([two, one]).map((e) => e.id)).toEqual(['a1', 'a2']);
  });
});
