import { describe, expect, it } from 'vitest';
import {
  AUTO_MERGE_SCORE,
  CANONICAL_SCHEMA_VERSION,
  categoriesInOrder,
  countWords,
  decideMerge,
  dependencyReason,
  findingGroupOf,
  identityKey,
  IMPORTABLE_CATEGORIES,
  isImportable,
  messageFingerprint,
  namesAgree,
  MIGRATION_CATEGORIES,
  migrationCategory,
  mergeScalarFields,
  parseCanonical,
  readyToRun,
  resolveSelection,
  sharedWorkspaceFinding,
  sortFindings,
  stricterConsent,
  unionValues,
  type CanonicalEnvelope,
} from '../src/migrations/index';

describe('the category catalog', () => {
  it('never names a dependency that does not exist', () => {
    const ids = new Set(MIGRATION_CATEGORIES.map((c) => c.id));
    for (const c of MIGRATION_CATEGORIES) {
      for (const d of [...c.dependsOn, ...(c.prefers ?? [])])
        expect(ids.has(d), `${c.id} → ${d}`).toBe(true);
    }
  });

  it('never depends on something that runs later', () => {
    for (const c of MIGRATION_CATEGORIES)
      for (const d of c.dependsOn)
        expect(migrationCategory(d)!.pass, `${c.id} needs ${d}`).toBeLessThanOrEqual(c.pass);
  });

  it('says in words why anything it will not import is left out', () => {
    for (const c of MIGRATION_CATEGORIES)
      if (c.release !== 'ready') expect(c.releaseNote, c.id).toBeTruthy();
  });

  it('imports only what has an importer, and automations are never in that list', () => {
    expect(IMPORTABLE_CATEGORIES).toContain('contacts');
    expect(isImportable('workflows')).toBe(false);
    expect(isImportable('websites')).toBe(false);
    expect(migrationCategory('workflows')!.targetType).toBeNull();
  });

  it('runs in pass order, and the same order twice', () => {
    const a = categoriesInOrder(['messages', 'contacts', 'users', 'conversations']).map(
      (c) => c.id,
    );
    const b = categoriesInOrder(['conversations', 'users', 'messages', 'contacts']).map(
      (c) => c.id,
    );
    expect(a).toEqual(b);
    expect(a.indexOf('users')).toBeLessThan(a.indexOf('contacts'));
    expect(a.indexOf('contacts')).toBeLessThan(a.indexOf('conversations'));
    expect(a.indexOf('conversations')).toBeLessThan(a.indexOf('messages'));
  });
});

describe('choosing what to bring', () => {
  it('adds what a choice needs, and says who asked', () => {
    const r = resolveSelection({ chosen: ['messages'] });
    const ids = r.categories.map((c) => c.id);
    expect(ids).toContain('conversations');
    expect(ids).toContain('contacts');
    expect(ids).toContain('locations');
    const added = r.added.find((a) => a.category === 'conversations');
    expect(added?.requiredBy).toEqual(['messages']);
    expect(dependencyReason('contacts', ['conversations'])).toBe(
      'Conversations need their customers, so customers were added to this migration.',
    );
  });

  it('names both askers when two things need the same thing', () => {
    const r = resolveSelection({ chosen: ['messages', 'tasks'] });
    expect(r.added.find((a) => a.category === 'contacts')?.requiredBy).toEqual([
      'conversations',
      'tasks',
    ]);
  });

  it('drops a choice whose requirement the old system will not give, rather than half-importing it', () => {
    const r = resolveSelection({ chosen: ['opportunities'], unavailable: ['pipelines'] });
    expect(r.categories.map((c) => c.id)).not.toContain('opportunities');
    expect(r.blocked).toEqual([{ category: 'opportunities', missing: ['pipelines'] }]);
  });

  it('will not run a category before what it needs has finished', () => {
    expect(readyToRun('messages', new Set(['contacts']))).toBe(false);
    expect(readyToRun('messages', new Set(['conversations']))).toBe(true);
  });
});

describe('what a count means', () => {
  it('never shows a permission problem as a number of records', () => {
    expect(countWords(0, 'permission_limited')).toBe('not visible to this sign-in');
    expect(countWords(120, 'permission_limited')).toBe('at least 120');
    expect(countWords(0, 'complete')).toBe('0');
    expect(countWords(1500, 'estimated')).toBe('about 1,500');
    expect(countWords(0, 'not_enumerable')).toBe('not counted by the old system');
  });

  it('keeps "they will not give it" and "we cannot hold it" apart', () => {
    expect(findingGroupOf('not_available')).toBe('unreadable');
    expect(findingGroupOf('not_supported')).toBe('unsupported');
    expect(findingGroupOf('not_imported')).toBe('excluded');
    expect(findingGroupOf('action_required')).toBe('action');
  });
});

describe('one source record, one record here', () => {
  it('keys on all six parts, so two sub-accounts in one business stay apart', () => {
    const base = {
      workspaceId: 'w1',
      sourceSystem: 'gohighlevel',
      installationId: 'i1',
      sourceObjectType: 'contact',
      sourceObjectId: '42',
    };
    expect(identityKey({ ...base, sourceLocationId: 'austin' })).not.toBe(
      identityKey({ ...base, sourceLocationId: 'dallas' }),
    );
  });

  it('fingerprints a message on everything that could tell two apart', () => {
    const parts = {
      locationId: 'l1',
      conversationId: 'c1',
      channel: 'sms',
      direction: 'inbound',
      participants: ['+15125551212', '+15125551213'],
      sentAt: '2026-03-01T10:00:00.000Z',
      bodyHash: 'abc',
    };
    expect(messageFingerprint(parts)).toBe(
      messageFingerprint({ ...parts, participants: ['+15125551213', '+15125551212'] }),
    );
    expect(messageFingerprint(parts)).not.toBe(
      messageFingerprint({ ...parts, sentAt: '2026-03-01T10:00:01.000Z' }),
    );
    expect(messageFingerprint(parts)).not.toBe(messageFingerprint({ ...parts, bodyHash: 'abd' }));
  });
});

describe('is this the same person', () => {
  const dave = { id: 'here-1', email: 'dave@example.com', phoneE164: '+15125551212' };

  it('merges on the phone number', () => {
    const d = decideMerge({ phone: '(512) 555-1212' }, [dave]);
    expect(d).toMatchObject({ kind: 'merge', targetId: 'here-1', rule: 'phone' });
    expect(d.kind === 'merge' && d.score >= AUTO_MERGE_SCORE).toBe(true);
  });

  it('never merges two people on a name alone', () => {
    const d = decideMerge({ firstName: 'Dave', lastName: 'Smith' }, [
      { id: 'here-1' },
      { id: 'here-2' },
    ]);
    expect(d).toEqual({ kind: 'create', reason: 'no_match' });
  });

  it('asks a person when the email says one and the phone says another', () => {
    const d = decideMerge({ email: 'dave@example.com', phone: '+15125559999' }, [
      { id: 'here-1', email: 'dave@example.com' },
      { id: 'here-2', phoneE164: '+15125559999' },
    ]);
    expect(d.kind).toBe('review');
    expect(d.kind === 'review' && d.rule).toBe('conflict');
    expect(d.kind === 'review' && [...d.targetIds].sort()).toEqual(['here-1', 'here-2']);
  });

  it('asks a person when the same number is on two records here', () => {
    const d = decideMerge({ phone: '+15125551212' }, [
      { id: 'here-1', phoneE164: '+15125551212' },
      { id: 'here-2', phoneE164: '+15125551212' },
    ]);
    expect(d.kind).toBe('review');
  });

  it('will not weld two different people onto one shared phone line', () => {
    const d = decideMerge({ firstName: 'Dave', lastName: 'Smith', phone: '+15125551212' }, [
      { id: 'here-1', firstName: 'Chris', lastName: 'Doyle', phoneE164: '+15125551212' },
    ]);
    expect(d.kind).toBe('review');
    expect(d.kind === 'review' && d.rule).toBe('name_disagrees');
  });

  it('still merges when the name is only spelled shorter, or is missing', () => {
    expect(
      decideMerge({ firstName: 'Dave', lastName: 'Smith', phone: '+15125551212' }, [
        { id: 'here-1', firstName: 'David', lastName: 'Smith', phoneE164: '+15125551212' },
      ]).kind,
    ).toBe('merge');
    expect(
      decideMerge({ phone: '+15125551212' }, [
        { id: 'here-1', firstName: 'Chris', lastName: 'Doyle', phoneE164: '+15125551212' },
      ]).kind,
    ).toBe('merge');
  });

  it('knows when two names could be one person', () => {
    expect(
      namesAgree(
        { firstName: 'Dave', lastName: 'Smith' },
        { firstName: 'Dave', lastName: 'Smith' },
      ),
    ).toBe(true);
    // Somebody married and changed their surname: the first name still matches exactly, so it agrees.
    expect(
      namesAgree(
        { firstName: 'Ana', lastName: 'Ruiz' },
        { firstName: 'Ana', lastName: 'Ruiz-Bao' },
      ),
    ).toBe(true);
    // Different first name and different surname: two people.
    expect(
      namesAgree(
        { firstName: 'Dave', lastName: 'Smith' },
        { firstName: 'Chris', lastName: 'Doyle' },
      ),
    ).toBe(false);
    expect(
      namesAgree({ firstName: 'Kim', lastName: 'Bao' }, { firstName: 'Kimberly', lastName: 'Bao' }),
    ).toBe(true);
    expect(namesAgree({ lastName: 'Smith' }, { firstName: 'Chris', lastName: 'Smith' })).toBe(true);
    expect(namesAgree({}, { firstName: 'Chris', lastName: 'Doyle' })).toBe(true);
  });

  it('a second number is a hint, not a decision', () => {
    const d = decideMerge({ extraPhones: ['+15125551212'] }, [
      { id: 'here-1', phoneE164: '+15125551212' },
    ]);
    expect(d.kind).toBe('review');
    expect(d.kind === 'review' && d.rule).toBe('extra_phone');
  });
});

describe('what a merge writes', () => {
  it('fills a blank here, keeps what is here, and remembers what the old system said', () => {
    const r = mergeScalarFields(
      { email: 'here@example.com', phone: '', source: null },
      { email: 'there@example.com', phone: '+15125551212', source: 'Google' },
      ['email', 'phone', 'source'],
    );
    expect(r.updates).toEqual({ phone: '+15125551212', source: 'Google' });
    expect(r.kept).toEqual({ email: { here: 'here@example.com', there: 'there@example.com' } });
  });

  it('adds to tags rather than replacing them', () => {
    expect(unionValues(['VIP', 'Repeat'], ['repeat', 'Warranty'])).toEqual([
      'VIP',
      'Repeat',
      'Warranty',
    ]);
  });

  it('never texts someone who opted out of either system, and keeps a real yes', () => {
    expect(stricterConsent('opted_in', 'opted_out')).toBe('opted_out');
    expect(stricterConsent('opted_out', 'opted_in')).toBe('opted_out');
    expect(stricterConsent('opted_in', 'unknown')).toBe('opted_in');
    expect(stricterConsent('unknown', 'unknown')).toBe('unknown');
  });
});

describe('the canonical envelope', () => {
  const envelope = (over: Partial<CanonicalEnvelope>): CanonicalEnvelope =>
    ({
      canonicalType: 'contact',
      canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
      category: 'contacts',
      source: {
        system: 'gohighlevel',
        adapterVersion: '1',
        installationId: '11111111-1111-1111-1111-111111111111',
        locationId: 'austin',
        objectType: 'contact',
        objectId: '42',
        retrievedAt: '2026-03-01T10:00:00.000Z',
        payloadChecksum: 'deadbeef',
        payloadVersion: 1,
      },
      relationships: [],
      data: { firstName: 'Dave', lastName: 'Smith' },
      extensions: {},
      warnings: [],
      ...over,
    }) as CanonicalEnvelope;

  it('checks a record against the shape for its type', () => {
    expect(parseCanonical(envelope({})).ok).toBe(true);
  });

  it('refuses a type it does not know rather than guessing', () => {
    const r = parseCanonical(envelope({ canonicalType: 'spaceship' }));
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain('spaceship');
  });

  it('refuses a company with no name', () => {
    expect(parseCanonical(envelope({ canonicalType: 'company', data: {} })).ok).toBe(false);
  });
});

describe('findings', () => {
  it('says plainly what two sub-accounts in one business mixes', () => {
    const f = sharedWorkspaceFinding({
      workspaceName: 'Lone Star HVAC',
      scopeNames: ['Dallas', 'Austin'],
    });
    expect(f.summary).toBe('2 sub-accounts will land in Lone Star HVAC.');
    expect(f.whatChanges).toContain('joined into one customer');
    expect(f.detail).toEqual({ scopes: ['Austin', 'Dallas'], workspace: 'Lone Star HVAC' });
  });

  it('shows what blocks before what merely differs', () => {
    const sorted = sortFindings([
      { code: 'c', severity: 'info' as const },
      { code: 'b', severity: 'blocking' as const },
      { code: 'a', severity: 'review' as const },
    ]);
    expect(sorted.map((f) => f.code)).toEqual(['b', 'a', 'c']);
  });
});

describe('what the inventory promises', () => {
  /**
   * "Almost everything says Not yet — why?" was a fair question, and the answer had to stop being a
   * promise. A category is now one of three things a business can act on: it comes across; it is left
   * behind on purpose and says why; or this system has nowhere to put it and says that instead. Nothing
   * is owed to a later release, because a screen full of "later" is a screen nobody can plan around.
   */
  it('never tells a business to wait for a later release', () => {
    const waiting = MIGRATION_CATEGORIES.filter(
      (c) => c.release === 'next' || c.release === 'deferred',
    );
    expect(waiting.map((c) => c.id)).toEqual([]);
  });

  it('says why, wherever something is not coming across', () => {
    for (const category of MIGRATION_CATEGORIES) {
      if (category.release === 'ready') continue;
      // In words, and enough of them to be a reason rather than a shrug.
      expect(category.releaseNote?.length ?? 0).toBeGreaterThan(40);
      // Nothing that is not coming across claims to write anything here.
      expect(category.targetType).toBeNull();
    }
  });

  it('gives everything that is ready somewhere to land', () => {
    for (const category of MIGRATION_CATEGORIES) {
      if (category.release !== 'ready') continue;
      expect(category.targetType).not.toBeNull();
    }
  });
});
