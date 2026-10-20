/**
 * The grey lines under a result (search/lines.ts), with no database: the last contact reads through
 * `lastContactWords` within a week and as a date after, only real contact counts as contact, and each kind's line
 * comes out of its facts. Then one kind's words: its count in its own nouns, Show more and how far back.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binLeftLine } from '../../src/bin-words';
import type { SearchHit } from '../../src/schemas/search';
import { CONTACT_LINES, countsAsContact, hitLines, lastContactLine } from '../../src/search/lines';
import { CONTACTS_WORDS } from '../../src/crm/record-words';
import {
  badgeLabel,
  callTitle,
  kindNoun,
  messageTitle,
  SEARCH_WORDS,
  threadTitle,
  whyLabel,
} from '../../src/search/words';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-10-20T15:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const w = { now: NOW, timeZone: TZ };

const hit = (kind: string, over: Partial<SearchHit> = {}): SearchHit => ({
  kind,
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Dana Smith',
  subtitle: null,
  badges: [],
  why: { field: 'name', label: null, snippet: null, page: null },
  tier: 1,
  exact: false,
  at: null,
  href: '/',
  contact: null,
  amount: null,
  facts: {},
  duplicateOf: null,
  ...over,
});

describe('the last contact', () => {
  it('reads "Texted 2 days ago" through lastContactWords within a week, then the date', () => {
    expect(lastContactLine({ kind: 'sms', subtype: 'inbound', at: daysAgo(2) }, w)).toBe(
      'Texted 2 days ago',
    );
    expect(lastContactLine({ kind: 'call', subtype: null, at: daysAgo(1) }, w)).toBe(
      'Called yesterday',
    );
    expect(lastContactLine({ kind: 'call', subtype: 'missed', at: daysAgo(0) }, w)).toBe(
      'Missed call today',
    );
    expect(
      lastContactLine({ kind: 'system', subtype: 'appointment_booked', at: daysAgo(1) }, w),
    ).toBe('Booked yesterday');
    expect(
      lastContactLine({ kind: 'email', subtype: 'outbound', at: '2026-10-09T15:00:00.000Z' }, w),
    ).toBe('Emailed Oct 9');
    expect(
      lastContactLine({ kind: 'paid', subtype: null, at: '2026-09-30T15:00:00.000Z' }, w),
    ).toBe('Paid Sep 30');
  });
});

/** Every subtype core writes a timeline line with, read from its source. */
function subtypesWritten(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const m of text.matchAll(/subtype: '([a-z_]+)'/g)) found.add(m[1]!);
        for (const m of text.matchAll(/logAppointmentActivity\(\s*ctx,\s*[\w!.]+,\s*'([a-z_]+)'/g))
          found.add(m[1]!);
      }
    }
  };
  walk(join(__dirname, '../../src'));
  return found;
}

describe('what counts as contact', () => {
  it('is a message, a call, a note or a visit either way, or a booking; never a bookkeeping line', () => {
    for (const kind of CONTACT_LINES.kinds)
      expect(countsAsContact(kind, 'inbound'), kind).toBe(true);
    const written = subtypesWritten();
    // The list the scan finds holds the lines that matter here.
    for (const s of [
      'file_added',
      'intake',
      'created',
      'archived',
      'addon_line',
      'appointment_booked',
    ])
      expect(written.has(s), s).toBe(true);
    for (const subtype of written)
      expect(countsAsContact('system', subtype), subtype).toBe(
        subtype.startsWith('appointment_booked'),
      );
  });
});

describe('each kind’s line', () => {
  it('prints a contact’s phone, email and last contact, and the open lead under the name', () => {
    const lines = hitLines(
      hit('contacts', {
        facts: {
          phone: '(504) 555-0142',
          email: 'dana.smith@gmail.com',
          lastContact: { kind: 'sms', subtype: 'outbound', at: daysAgo(2) },
          openLead: { title: 'Water heater', stage: 'Quote sent' },
        },
      }),
      w,
    );
    expect(lines.line).toBe('(504) 555-0142 · dana.smith@gmail.com · Texted 2 days ago');
    expect(lines.under).toBe('Water heater · Quote sent');
    expect(
      hitLines(hit('contacts', { facts: { company: 'Smithfield Property Mgmt' } }), w).under,
    ).toBe('Works at Smithfield Property Mgmt');
  });

  it('prints a company’s people and open leads, a lead’s customer and stage, money’s standing', () => {
    expect(hitLines(hit('companies', { facts: { people: 12, openLeads: 4 } }), w).line).toBe(
      '12 people · 4 open leads',
    );
    expect(
      hitLines(
        hit('leads', {
          facts: { customer: 'Dana Smith', pipeline: 'Installs', stage: 'Quote sent' },
        }),
        w,
      ).line,
    ).toBe('Dana Smith · Installs › Quote sent');
    const payment = hitLines(
      hit('money', {
        facts: {
          docKind: 'payment',
          customer: 'Marcus Smith',
          invoiceNumber: '1031',
          paidAt: '2026-09-30T15:00:00.000Z',
        },
      }),
      w,
    );
    expect(payment).toMatchObject({ line: 'Marcus Smith · Invoice #1031', chip: 'Paid Sep 30' });
    expect(
      hitLines(
        hit('money', {
          facts: {
            docKind: 'estimate',
            status: 'sent',
            customer: 'Dana Smith',
            sentAt: '2026-10-17T15:00:00.000Z',
            openedAt: null,
          },
        }),
        w,
      ).line,
    ).toBe('Dana Smith · Sent Oct 17 · Not opened yet');
    expect(
      hitLines(
        hit('money', {
          facts: {
            docKind: 'invoice',
            status: 'overdue',
            customer: 'Marcus Smith',
            dueOn: '2026-10-14',
          },
        }),
        w,
      ).line,
    ).toBe('Marcus Smith · 6 days overdue');
  });

  it('prints an archived record’s day and how to bring it back, and a bin item’s days left', () => {
    expect(
      hitLines(
        hit('contacts', {
          badges: ['archived'],
          facts: { archivedAt: '2026-03-03T15:00:00.000Z' },
        }),
        w,
      ).line,
    ).toBe('Archived Mar 3 · Restore from the record’s menu');
    expect(
      hitLines(
        hit('bin', {
          facts: {
            deletedAt: daysAgo(4),
            purgeAfter: new Date(NOW + 26 * 86_400_000).toISOString(),
          },
        }),
        w,
      ).line,
    ).toBe('Deleted 4 days ago · Gone for good in 26 days');
    expect(
      binLeftLine({ deletedAt: daysAgo(0), purgeAfter: daysAgo(-30), emptying: true }, NOW),
    ).toBe('Deleted today · Being deleted now');
  });

  it('says who answered a form, that nobody said, or that who did has no name on file now', () => {
    const answer = (facts: SearchHit['facts'], badges: string[] = []) =>
      hitLines(hit('forms', { at: '2026-10-19T15:00:00.000Z', badges, facts }), w).line;
    expect(answer({ answeredBy: 'Jo Smithers' })).toBe('Answered by Jo Smithers · Oct 19');
    expect(answer({ answeredBy: null }, ['anonymous'])).toBe(
      'Answered by someone who didn’t say who · Oct 19',
    );
    // Merged away, deleted or erased since: they said who, so they aren't anonymous.
    expect(answer({ answeredBy: null })).toBe('Answered by someone with no name on file · Oct 19');
  });
});

describe('why chips', () => {
  it('name the field, a custom field by its own name, and nothing for a plain name match', () => {
    expect(whyLabel({ field: 'phone' })).toBe('Phone');
    expect(whyLabel({ field: 'file_text' })).toBe('In the file');
    expect(whyLabel({ field: 'field', label: 'Gate code' })).toBe('Gate code');
    expect(whyLabel({ field: 'name' })).toBeNull();
    expect(whyLabel({ field: 'customer' }, 'leads')).toBe('Customer');
    expect(whyLabel({ field: 'customer' }, 'notes')).toBeNull();
  });
});

describe('one kind’s words', () => {
  it('count one and more of a kind in its own nouns, and a business’s own kinds by their plural', () => {
    expect(SEARCH_WORDS.named(1, 'contacts', 'Contacts', 'dana')).toBe('1 contact named “dana”');
    expect(SEARCH_WORDS.named(9, 'contacts', 'Contacts', 'dana')).toBe('9 contacts named “dana”');
    expect(SEARCH_WORDS.kindFor(2, 'bin', 'Deleted bin', 'tom becnel')).toBe(
      '2 things in the Deleted bin for “tom becnel”',
    );
    expect(SEARCH_WORDS.named(1, 'archived', 'Archived', 'tom becnel')).toBe(
      '1 archived record named “tom becnel”',
    );
    expect(SEARCH_WORDS.kindFor(3, 'money', 'Money', 'smith')).toBe(
      '3 bills and payments for “smith”',
    );
    expect(SEARCH_WORDS.kindFor(3, 'record.pets', 'Pets', 'rex')).toBe('3 pets for “rex”');
    expect(SEARCH_WORDS.kindFor(1, 'record.pets', 'Pets', 'rex')).toBe(
      '1 result in Pets for “rex”',
    );
    expect(kindNoun(1, 'realestate.listings', 'Listings')).toBe('result in Listings');
  });

  it('say Show more and how far back in the same nouns', () => {
    expect(SEARCH_WORDS.showMore(3, 'contacts', 'Contacts')).toBe('Show 3 more contacts');
    expect(SEARCH_WORDS.showMore(1, 'bin', 'Deleted bin')).toBe(
      'Show 1 more thing in the Deleted bin',
    );
    expect(SEARCH_WORDS.showMore(2, 'close', 'Close matches')).toBe('Show 2 more close matches');
    expect(SEARCH_WORDS.searchedBack('messages', 'Messages', 'Mar 3, 2025')).toBe(
      'Searched messages back to Mar 3, 2025.',
    );
    expect(SEARCH_WORDS.searchedBack('archived', 'Archived', 'Mar 3, 2025')).toBe(
      'Searched archived records back to Mar 3, 2025.',
    );
  });

  it('names a lead and a client as the Contacts page does', () => {
    expect(badgeLabel('lead')).toBe(CONTACTS_WORDS.lead);
    expect(badgeLabel('client')).toBe(CONTACTS_WORDS.client);
  });
});

describe('titles of what the inbox found', () => {
  it('names a message by its channel and direction, a thread by who it’s with, and a call', () => {
    expect(messageTitle('sms', 'inbound', 'Dana Smith')).toBe('Text from Dana Smith');
    expect(messageTitle('sms', 'outbound', 'Jo Smithers')).toBe('Text to Jo Smithers');
    expect(messageTitle('email', 'inbound', 'Kim Le')).toBe('Email · Kim Le');
    expect(messageTitle('instagram', 'inbound', 'Theo Lavergne')).toBe('Instagram · Theo Lavergne');
    expect(threadTitle('sms', 'Dana Smith')).toBe('Texts with Dana Smith');
    expect(threadTitle('chat', 'Beatrice Fontaine')).toBe('Chat with Beatrice Fontaine');
    expect(callTitle('Marcus Smith')).toBe('Call · Marcus Smith');
  });
});
