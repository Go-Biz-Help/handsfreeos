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
 * from correcting the AI to what it knows, from its Home card; deleting a form's answer sheet; moving an email
 * thread between the Inbox, Other mail and Spam, or sharing one's own mail with the team (M19); sending a text or
 * email that didn't go out again, from its thread; asking for help, or saving and removing one's own safety contacts,
 * from the safety screens (round six); Got it on an add-on's alert, from its Home card (round six); and on Real
 * Estate's buyer pages (round six, boards 82–84), looking a home up on the MLS, adding or setting aside one of our
 * listings, planning a tour or changing its homes, writing a counter, sharing an offer's summary, and finding a CMA's
 * comps or asking for its summary.
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
  'message.retry',
  'safety.help',
  'safety_contact.save',
  'safety_contact.remove',
  'addon_alert.acknowledge',
  'realestate.home.lookup',
  'realestate.suggestion.add',
  'realestate.suggestion.not_a_fit',
  'realestate.tour.plan',
  'realestate.tour.set_stops',
  'realestate.offer.add_version',
  'realestate.offer.share_summary',
  'realestate.cma.find_comps',
  'realestate.cma.request_summary',
  // A deal's pages (boards 78–81, 93): an update the AI writes, the next stage, marking a duty done without its proof,
  // confirming a contract's values, approving a vendor, exporting the transaction, and placing or lifting a hold.
  'realestate.status_email.request',
  'realestate.deal.move_stage',
  'realestate.duty.complete_with_exception',
  'realestate.contract.confirm',
  'realestate.vendor.approve',
  'realestate.deal.export',
  'record_hold.place',
  'record_hold.lift',
  // Closing and the listing (boards 85–89): a task marked done for a client, letting them into the portal, the
  // repair request, the walkthrough's list, a fact changed, the MLS asked again, a description or posts written,
  // marking it live, an open house on the calendar, and a duty's vendor and quote.
  'realestate.client_task.mark_done',
  'portal_access.give',
  'realestate.repair.send',
  'realestate.walkthrough.plan',
  'realestate.listing.confirm_facts',
  'realestate.listing.lookup',
  'realestate.listing.description.request',
  'realestate.listing.posts_request',
  'realestate.listing.mark_live',
  'realestate.open_house.plan',
  'realestate.duty.pick_vendor',
  'realestate.duty.vendor_quote',
  // Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): each screen's answers
  // kept as it's finished, Save, an answer added from its test chat, and turning the teammate on.
  'ai_setup.save',
  'ai_setup.finish',
  'knowledge_item.create',
  'ai_teammate.set_status',
  // The onboarding setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): making the business after
  // signing up, each screen's answers kept as it's finished, Stay in the loop, and what a stop does in place: a
  // business number bought, and the payment provider's sign-in started.
  'organization.create',
  'onboarding_setup.save',
  'onboarding_setup.finish',
  'phone_number.buy',
  'payment_connection.connect',
  // Its logo and colour (§4): a place reserved for an upload and the upload handed to the worker, a colour picked or
  // the logo taken off, and the website looked at again.
  'look.begin_upload',
  'look.use_upload',
  'look.set',
  'look.find',
  // Social Outreach on the phone (decision 44): saving someone's settings or the business's, ending someone's training
  // wheels, and writing, archiving or bringing back a playbook.
  'outreach.automation.save',
  'addon.save_settings',
  'outreach.wheels.end',
  'outreach.playbook.save',
  'outreach.playbook.archive',
  // Asking the person's computer from the phone (decision 43): asking, Carry on or Skip, Stop, and the code a network
  // emailed them.
  'outreach.ask.make',
  'outreach.ask.reply',
  'outreach.ask.cancel',
  'outreach.ask.code',
  // The person menu on Today (decision 44): Add to Contacts, Demo booked and Don't pitch; and on any name, Mark as
  // client and Not a client after all (decision 91), and Later (decision 100).
  'outreach.profile.contact',
  'outreach.demo.mark',
  'outreach.friend.set',
  'outreach.client.set',
  'outreach.later.set',
  // Cancel all, under Today's note when no new requests go for now (decision 121).
  'outreach.friends.cancel_all',
  // Where someone stands, from the Pipeline screen (decision 47), and on the Partners list (decision 81).
  'outreach.stage.mark',
  'outreach.partner.mark',
  // Potential partner, and Not a partner after all, from the person menu (decision 130).
  'outreach.partner.potential',
  // Today's helpful post (decision 50): ask for it, OK it for the computer, say it's up, or put it aside.
  'outreach.helpful.ask',
  'outreach.helpful.ok',
  'outreach.helpful.posted',
  'outreach.helpful.skip',
  // Letting the browser extension sign in by picking its number, from the push (20261027002910).
  'extension_sign_in.answer',
  // Get ready on Today (decision 63): a profile item ticked, the goal set, and the messages OK'd.
  'outreach.readiness.profile',
  'outreach.readiness.numbers',
  'outreach.readiness.messages',
  // The rest of Social Outreach's settings on the phone (decision 104): a computer renamed or removed, a country call
  // kept or taken back, and the sample messages changed or a kept note forgotten.
  'outreach.computer.rename',
  'outreach.computer.remove',
  'outreach.country.decide',
  'outreach.country.unskip',
  'outreach.messages.edit',
  'outreach.messages.forget',
  // Instagram accounts like yours, added or taken off in the settings (decision 110).
  'outreach.like_yours.add',
  'outreach.like_yours.remove',
  // Won or lost after the demo, on a customer's Social card (decision 106).
  'outreach.demo.outcome',
  // A group or a person given to a teammate, on a group's page and the person menu (decision 107).
  'outreach.owner.move',
  // Retry, and Retry all, on what didn't go, from Steps it needs you for (decision 132).
  'outreach.send.retry',
  // Feedback on the AI teammate's replies (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md), in a conversation and the
  // test console: a thumbs up or down, the answer to its quick question, and Not now on the rule it suggests.
  'ai_teammate.give_feedback',
  'ai_teammate.answer_feedback',
  'teammate_lesson.dismiss',
  // Settings → Main offer (HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md): a part edited, the direction, and
  // going live.
  'main_offer.save_draft',
  'main_offer.save_direction',
  'main_offer.publish',
  // A partner's page and a customer's Partner card (the partners plan, stage 2d): a contact made a partner, their
  // share or status changed, and which partner sent a customer.
  'partner.add',
  'partner.update',
  'partner.referral_set',
  // The bell (20261027012600): opening it sees its notifications, and pressing one, or its push, opens it.
  'notification.seen',
  'notification.read',
];
/**
 * Commands only the browser extension sends, which can wait in it as long as the browser is offline (Social
 * Outreach's steps taken on Facebook, and answers to friend requests). No phone screen sends them, so they're no
 * part of what an old app build sends.
 */
const EXTENSION_COMMANDS = [
  'outreach.touch.save',
  'outreach.friend.note',
  'outreach.friend.end',
  'outreach.warning.note',
  'outreach.live.beat',
  'outreach.need.note',
  'outreach.ask.end',
];
/** Whether the phone may keep it waiting: it can wait, a person sends it, and it isn't the extension's alone. */
const phoneCanWait = (c: { name: string; offline: unknown; actors?: readonly string[] }) =>
  c.offline !== 'online' &&
  (c.actors ?? ['human']).includes('human') &&
  !EXTENSION_COMMANDS.includes(c.name);
/**
 * What the phone asks the server for that its own copy can't answer: among them a form's answers (one at a time, and
 * all of them for a spreadsheet), and the business's link name and own domain for the form's link and QR code; and
 * Real Estate's buyer pages for a deal the phone keeps only as its summary (round six), loaded with signal; and
 * Search everything, whose inputs only ever grow (every field has a default, and kinds and badges are strings).
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
  'realestate.buyer_profile.get',
  'realestate.cma',
  'realestate.homes',
  'realestate.matches',
  'realestate.memory',
  'realestate.offers',
  'realestate.offers.compare',
  'realestate.tours',
  // A deal's documents and history when it's kept as its summary, its transaction exports, and its legal hold.
  'realestate.document.list',
  'realestate.deal.history',
  'realestate.exports',
  'record_hold.list',
  // Closing and the listing's pages of a deal kept as its summary, with signal (boards 85–89).
  'realestate.financing',
  'realestate.inspections',
  'realestate.client_tasks',
  'realestate.walkthrough',
  'realestate.listing',
  'realestate.listing.prices',
  'realestate.listing.marketing',
  'realestate.open_houses',
  'realestate.showing.list',
  // A listing's lockboxes and who opened them, never their codes (round seven).
  'realestate.lockbox.list',
  'realestate.duty.vendors',
  // A signed document's fingerprint, checked once the phone has downloaded it to keep (round seven).
  'file.fingerprints',
  // Quick setup for the AI teammate: where it stands, and what Ava found on the website that's still waiting.
  'ai_setup.get',
  'knowledge_scan.get',
  'knowledge_suggestion.list',
  // The onboarding setup: where it stands.
  'onboarding_setup.get',
  // Social Outreach on the phone (decision 44), with signal: Waiting for you's steps and friend requests, the live
  // view and the team's, Today and training wheels, Groups, Chats, the playbooks, and the settings (someone's, who uses
  // it, and the business's).
  'outreach.waiting',
  'outreach.live',
  'outreach.live.team',
  'outreach.today',
  'outreach.wheels',
  'outreach.groups',
  'outreach.chats',
  'outreach.playbook.list',
  'outreach.automation',
  'outreach.automation.people',
  'addon.settings',
  // What the person asked their computer, for the Groups, Chats and Live screens.
  'outreach.asks',
  // Add to Contacts' customers with the same name, offered first.
  'outreach.lookup',
  // Where someone stands as their person menu opens (decision 91): in Contacts, a client, on Don't pitch.
  'outreach.profile.marks',
  // Whether the person has set Social Outreach up: until then the phone says to do it on a computer (decision 45).
  'outreach.setup',
  // The Pipeline screen: everyone the person reached, by where they stand (decision 47).
  'outreach.stages',
  // A customer's Social card and a group's own page: how someone came along (decision 103).
  'outreach.person',
  'outreach.group.people',
  // Today's helpful post, and those up lately (decision 50).
  'outreach.helpful',
  // Get ready on Today: what's left before the extension reaches anyone (decision 63).
  'outreach.readiness',
  // Not sure where they live and Skipped for country, from General on the phone (decision 104).
  'outreach.countries.skipped',
  // The extension's sign-ins waiting for the person's number, for the screen its push opens (20261027002910).
  'extension_sign_in.pending',
  // The feedback on the AI teammate's replies on a screen, and what came of it, asked again while it's being read.
  'ai_teammate.feedback',
  // Settings → Main offer, with signal: the offer with its draft and score, and this round's tries.
  'main_offer.get',
  'main_offer.tries',
  // Settings → Partners and a customer's Partner card, with signal (the partners plan, stage 2d).
  'partners.settings',
  'partner.list',
  'partner.get',
  'partner.of_person',
  // Search everything, with signal: the box, and one kind a page at a time (the search plan, stage 3).
  'search.everything',
  'search.kind',
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
    .filter((c) => phoneCanWait(c) || ONLINE_COMMANDS.includes(c.name))
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
      if (phoneCanWait(c)) expect(recorded.commands, c.name).toHaveProperty([c.name]);
    for (const name of EXTENSION_COMMANDS)
      expect(registry.command(name)?.offline, name).toBe('anytime');
    expect(Object.keys(recorded.commands)).toEqual(
      expect.arrayContaining([
        'person.update',
        'message.send',
        'record.add_tag',
        'estimate.update',
      ]),
    );
  });

  it('never lets the phone keep waiting a command that leaves no receipt', () => {
    // The phone's queue lets a command go once its receipt comes back: one that keeps none would wait forever there.
    const none = registry.commands.filter(
      (c) => (c as { receipt?: false }).receipt === false && phoneCanWait(c),
    );
    expect(none.map((c) => c.name)).toEqual([]);
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
