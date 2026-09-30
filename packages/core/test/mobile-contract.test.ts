/**
 * The phone's contract (M10, "Old app builds"): the inputs of every command and query the phone uses, each
 * command's offline class, and the shape of every table it syncs, recorded in contract/mobile-contract.json. Phones
 * stay on old builds for weeks, so the contract may only grow. This fails on anything else (a removed field, a new
 * required one, a narrowed enum, type or limit, a command that can wait less), and asks for the record to be
 * refreshed when the contract grew compatibly:
 *
 *   UPDATE_CONTRACT=1 pnpm --filter @hfos/core exec vitest run test/mobile-contract.test.ts
 *   pnpm exec prettier --write packages/core/test/contract/mobile-contract.json
 *
 * `tables` is what each sync stream sends: "stream.table" → every column and its type in the database, read from
 * apps/sync/sync-config.yaml (apps/sync/src/shape.ts). A column removed, renamed or given another type fails here;
 * stream names carry a version (`business_v1`), so that kind of change is a new stream beside the old one, which
 * old builds keep using. Retiring a stream (once MIN_APP_VERSION is past every build that uses it) means deleting
 * its tables from the record by hand, on purpose. A type change a phone reads the same way (integer to bigint) can
 * be edited in the record by hand too, saying why in the commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { syncConfigFile, syncedTables, unversionedStreams } from '../../../apps/sync/src/shape';
import { registry } from '../src/server';
import {
  incompatibilities,
  schemaIncompatibilities,
  type Contract,
  type Schema,
} from './contract/compat';

const RECORD = new URL('./contract/mobile-contract.json', import.meta.url);

/**
 * Online commands the phone also sends: a draft estimate or invoice saved on it (a stale save keeps a new draft);
 * calling a customer through the person's own cell, cancelling that call, and verifying that cell; deleting the
 * account; the Assistant's consent; registering the phone for push notifications, or removing it; adding a lesson
 * from correcting the AI to what it knows, from its Home card; deleting a form's answer sheet; and moving an email
 * thread between the Inbox, Other mail and Spam, or sharing one's own mail with the team (M19).
 */
const ONLINE_COMMANDS = [
  'estimate.create',
  'estimate.update',
  'invoice.create',
  'invoice.update',
  'call.connect_me',
  'call.cancel_connect',
  'user_phone.start_verification',
  'account.delete',
  'assistant.consent',
  'push_device.register',
  'push_device.remove',
  'user.update_profile',
  'teammate_lesson.apply',
  'form_response.delete',
  'conversation.move',
  'conversation.share',
];
/**
 * What the phone asks the server for that its own copy can't answer: among them a form's answers (one at a time, and
 * all of them for a spreadsheet), and the business's link name and own domain for the form's link and QR code.
 */
const QUERIES = [
  'account.me',
  'attention.preview_handle',
  'booking_site.get',
  'branded_domain.get',
  'calendar.availability',
  'crm.find_matches',
  'email.compose_options',
  'form.response_export',
  'form.response_get',
  'form.response_list',
];

/** An input's JSON Schema, without the regex a format already stands for (a uuid's, a date-time's). */
function inputSchema(schema: z.ZodType): Schema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  const tidy = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(tidy);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(o)
        .filter(([k]) => !(k === 'pattern' && typeof o.format === 'string'))
        .map(([k, x]) => [k, tidy(x)]),
    );
  };
  return tidy(rest) as Schema;
}

/** Today's contract: every command a person may send that can wait on a phone, the online ones above, the queries. */
function currentContract(tables: Contract['tables']): Contract {
  const commands = registry.commands
    .filter((c) => (c.actors ?? ['human']).includes('human'))
    .filter((c) => c.offline !== 'online' || ONLINE_COMMANDS.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    about:
      'What an old phone app build sends: may only grow. Refresh with UPDATE_CONTRACT=1 (see test/mobile-contract.test.ts).',
    commands: Object.fromEntries(
      commands.map((c) => [c.name, { offline: c.offline, input: inputSchema(c.input) }]),
    ),
    queries: Object.fromEntries(
      [...QUERIES].sort().map((name) => {
        const q = registry.query(name);
        if (!q) throw new Error(`The phone uses ${name}, which isn't a query`);
        return [name, { input: inputSchema(q.input) }];
      }),
    ),
    tables,
  };
}

describe('the phone’s contract', () => {
  afterAll(closeTestDbs);

  it('only grows', async () => {
    let recorded: Contract | null = null;
    try {
      recorded = JSON.parse(readFileSync(RECORD, 'utf8')) as Contract;
    } catch {
      recorded = null;
    }
    // The synced tables' columns and types come from the streams and the local database's schema.
    const current = currentContract(await syncedTables(testDbs().admin.db));
    if (process.env.UPDATE_CONTRACT || !recorded) {
      if (recorded) expect(incompatibilities(recorded, current)).toEqual([]);
      writeFileSync(RECORD, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    expect(incompatibilities(recorded, current), 'changes an old app build would break on').toEqual(
      [],
    );
    expect(
      JSON.parse(JSON.stringify(current)),
      'the contract grew compatibly: record it with UPDATE_CONTRACT=1',
    ).toEqual(recorded);
  });

  it('covers every command the phone can keep waiting', () => {
    const recorded = JSON.parse(readFileSync(RECORD, 'utf8')) as Contract;
    for (const c of registry.commands)
      if (c.offline !== 'online' && (c.actors ?? ['human']).includes('human'))
        expect(recorded.commands, c.name).toHaveProperty([c.name]);
    expect(Object.keys(recorded.commands)).toEqual(
      expect.arrayContaining([
        'person.update',
        'message.send',
        'record.add_tag',
        'estimate.update',
      ]),
    );
  });

  it('versions every sync stream, so a change old builds can’t take is a new stream', async () => {
    expect(unversionedStreams(), 'stream names end in _v1, _v2, …').toEqual([]);
    const recorded = JSON.parse(readFileSync(RECORD, 'utf8')) as Contract;
    expect(Object.keys(recorded.tables)).toEqual(
      expect.arrayContaining(['me_v1.workspace_access', 'business_v1.people', 'agency_v1.users']),
    );
    // Scratch copies of today's streams: a customer's notes dropped, their number renamed, their city retyped.
    const config = readFileSync(syncConfigFile, 'utf8');
    const people = /^( {6}- SELECT id, workspace_id, company_id, first_name.*)$/m;
    const line = people.exec(config)![1]!;
    const tablesWith = (edited: string) =>
      syncedTables(testDbs().admin.db, config.replace(line, edited));
    const broken = await tablesWith(
      line
        .replace(' notes,', '')
        .replace(' phone_e164,', ' phone_e164 AS phone_number,')
        .replace(' city,', ' created_at AS city,'),
    );
    expect(incompatibilities(recorded, { ...recorded, tables: broken })).toEqual([
      'table business_v1.people: column phone_e164 removed',
      'table business_v1.people: column city changed from text to timestamp with time zone',
      'table business_v1.people: column notes removed',
    ]);
    // The same change as a new version beside the old stream is growth: old builds keep business_v1.
    const v2 = config.replace(
      /\n {2}agency_v1:/,
      `\n  business_v2:\n    queries:\n${line.replace(' notes,', '').replace('IN access', "= 'x'")}\n\n  agency_v1:`,
    );
    const grown = await syncedTables(testDbs().admin.db, v2);
    expect(Object.keys(grown)).toContain('business_v2.people');
    expect(incompatibilities(recorded, { ...recorded, tables: grown })).toEqual([]);
    expect(unversionedStreams(config.replace('agency_v1:', 'agency:'))).toEqual(['agency']);
  });
});

describe('what counts as growth', () => {
  const person: Schema = {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', format: 'uuid' },
      name: { type: 'string', maxLength: 80 },
      email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      channel: { type: 'string', enum: ['sms', 'email'], default: 'sms' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
    required: ['workspaceId', 'name'],
  };
  /** A copy of the schema to change, as plain data. */
  type Editable = { properties: Record<string, Schema>; required: string[] };
  const change = (patch: (s: Editable) => void): Schema => {
    const copy = JSON.parse(JSON.stringify(person)) as Editable;
    patch(copy);
    return copy;
  };

  it('lets a field, a value, null or room be added', () => {
    const grown = change((s) => {
      s.properties.source = { type: 'string' };
      s.properties.channel = { type: 'string', enum: ['sms', 'email', 'chat'], default: 'sms' };
      s.properties.name = { anyOf: [{ type: 'string', maxLength: 120 }, { type: 'null' }] };
      s.properties.tags = { type: 'array', items: { type: 'string' }, maxItems: 50 };
      s.required = ['workspaceId'];
    });
    expect(schemaIncompatibilities(person, grown)).toEqual([]);
  });

  it('refuses a removed field, a new required one, and narrower enums, types and limits', () => {
    expect(
      schemaIncompatibilities(
        person,
        change((s) => delete s.properties.email),
      ),
    ).toEqual(['email: removed']);
    expect(
      schemaIncompatibilities(
        person,
        change((s) => {
          s.properties.phone = { type: 'string' };
          s.required = ['workspaceId', 'name', 'phone', 'email'];
        }),
      ),
    ).toEqual(['phone: new and required', 'email: now required']);
    expect(
      schemaIncompatibilities(
        person,
        change((s) => {
          s.properties.channel = { type: 'string', enum: ['sms'], default: 'sms' };
        }),
      ),
    ).toEqual(['channel: no longer takes ["email"]']);
    expect(
      schemaIncompatibilities(
        person,
        change((s) => {
          s.properties.email = { type: 'string' };
          s.properties.name = { type: 'string', maxLength: 40 };
          s.properties.tags = { type: 'array', items: { type: 'integer' } };
        }),
      ),
    ).toEqual([
      'name: maximum length 80 → 40',
      'email: no longer takes null',
      'tags[]: no longer takes string',
    ]);
    expect(
      schemaIncompatibilities(
        person,
        change((s) => {
          s.properties.channel = { type: 'string', enum: ['sms', 'email'], default: 'email' };
        }),
      ),
    ).toEqual(['channel: its default changed from "sms" to "email"']);
  });

  it('refuses a command that can wait less, or is gone, and a synced column removed or changed', () => {
    const before: Contract = {
      commands: {
        'note.add': { offline: 'anytime', input: person },
        'text.send': { offline: { freshMinutes: 30 }, input: person },
        'task.done': { offline: 'anytime', input: person },
      },
      queries: { 'me.get': { input: { type: 'object' } } },
      tables: { people: { columns: { id: 'uuid', email: 'text' } } },
    };
    const after: Contract = {
      commands: {
        'note.add': { offline: 'online', input: person },
        'text.send': { offline: { freshMinutes: 10 }, input: person },
      },
      queries: {},
      tables: { people: { columns: { id: 'text' } } },
    };
    expect(incompatibilities(before, after)).toEqual([
      'command note.add: can wait less on a phone ("anytime" → "online")',
      'command text.send: fresh for fewer minutes (30 → 10)',
      'command task.done: removed',
      'query me.get: removed',
      'table people: column id changed from uuid to text',
      'table people: column email removed',
    ]);
    // Waiting longer is growth.
    expect(
      incompatibilities(
        {
          ...before,
          commands: { 'x.y': { offline: 'online', input: person } },
          queries: {},
          tables: {},
        },
        {
          ...before,
          commands: { 'x.y': { offline: 'anytime', input: person } },
          queries: {},
          tables: {},
        },
      ),
    ).toEqual([]);
  });
});
