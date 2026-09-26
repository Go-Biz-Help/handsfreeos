import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;
let personA: string;
let personB: string;
let conversationA: string;

/** A random US number, so reruns against the same database never meet an old live number. */
const randomE164 = (): string =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const identity = (u: TestUser): string => `u${u.id.replace(/-/g, '')}`;
const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const unscoped = asService({});

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('tel-owner'),
    createTestUser('tel-admin'),
    createTestUser('tel-member'),
    createTestUser('tel-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Telephony Org A', 'Telephony A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Telephony Org B', 'Telephony B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: admin.id, role: 'admin' },
    { workspaceId: wsA, userId: member.id, role: 'member' },
  ]);
  personA = (
    await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name, phone_e164, created_by)
            values (${wsA}, 'Mike', 'Johnson', '+17135550142', ${member.id}) returning id`,
      ),
    )
  )[0]!.id;
  personB = (
    await as(outsider)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name, created_by)
            values (${wsB}, 'Other', 'Person', ${outsider.id}) returning id`,
      ),
    )
  )[0]!.id;
});
afterAll(closeAll);

describe('telephony accounts', () => {
  it('members see the account status but never the sealed tokens; other workspaces see nothing', async () => {
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, auth_token_enc, status)
            values (${wsA}, 'fake', ${`ACfake${uniq()}`}, 'sealed:v1:not-a-real-token', 'active')`,
      ),
    );
    const visible = await as(member)((tx) =>
      rows<{ status: string }>(
        tx,
        sql`select status::text as status from app.telephony_accounts where workspace_id = ${wsA}`,
      ),
    );
    expect(visible).toEqual([{ status: 'active' }]);
    const sealed = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`select auth_token_enc from app.telephony_accounts where workspace_id = ${wsA}`,
        ),
      ),
    );
    expect(sealed.code).toBe('42501');
    const other = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.telephony_accounts where workspace_id = ${wsA}`),
    );
    expect(other).toHaveLength(0);
    const insert = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.telephony_accounts (workspace_id, provider) values (${wsA}, 'fake')`,
        ),
      ),
    );
    expect(insert.code).toBe('42501');
  });
});

describe('phone numbers', () => {
  let numberId: string;
  const e164 = randomE164();

  it('only owners and admins add a number, and only as provisioning', async () => {
    const byMember = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.phone_numbers (workspace_id, e164, number_type, created_by) values (${wsA}, ${e164}, 'toll_free', ${member.id})`,
        ),
      ),
    );
    expect(byMember.code).toBe('42501');
    const active = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.phone_numbers (workspace_id, e164, number_type, status, created_by) values (${wsA}, ${e164}, 'toll_free', 'active', ${owner.id})`,
        ),
      ),
    );
    expect(active.code).toBe('42501');
    const [row] = await as(owner)((tx) =>
      rows<{ id: string; routing: { ringSeconds: number } }>(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, created_by) values (${wsA}, ${e164}, 'toll_free', ${owner.id}) returning id, routing`,
      ),
    );
    numberId = row!.id;
    expect(row!.routing.ringSeconds).toBe(20);
  });

  /**
   * This used to assert the opposite — `phone_numbers_one_live_per_workspace`, one number per business.
   * 0077 dropped that index on purpose: a second location, a dispatch line or a toll-free beside a local one
   * are all ordinary. What stays is `phone_numbers_live_e164`, and the two look alike and mean opposite
   * things: the one that went said "a business has one number", the one that stays says "a live number
   * belongs to one business" — which is how `private.phone_route()` can look a number up and expect one row.
   */
  it('lets one business hold several numbers', async () => {
    const added = await as(admin)((tx) =>
      rows(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, created_by)
            values (${wsA}, ${randomE164()}, 'local', ${admin.id}) returning id`,
      ),
    );
    expect(added).toHaveLength(1);
  });

  it('still lets a live number belong to only one business', async () => {
    const shared = randomE164();
    await as(admin)((tx) =>
      rows(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, created_by)
            values (${wsA}, ${shared}, 'local', ${admin.id})`,
      ),
    );
    const taken = await expectPgError(() =>
      as(outsider)((tx) =>
        rows(
          tx,
          sql`insert into app.phone_numbers (workspace_id, e164, number_type, created_by)
              values (${wsB}, ${shared}, 'local', ${outsider.id})`,
        ),
      ),
    );
    expect(taken.code).toBe('23505');
  });

  it('people change routing and start a release; provider fields and other transitions are the worker’s', async () => {
    const routed = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.phone_numbers set routing = '{"forwarding": [{"e164": "+17135550161", "label": "Dale", "enabled": true}], "ringSeconds": 15, "voicemailEnabled": true, "voicemailGreeting": null}'
            where id = ${numberId} returning id`,
      ),
    );
    expect(routed).toHaveLength(1);
    const provider = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.phone_numbers set e164 = ${randomE164()} where id = ${numberId}`),
      ),
    );
    expect(provider.detail).toBe('phone_number_provider_fields');
    // 0073 made this allowed on purpose (item 1.1): a purchase the worker never finished used to hold the
    // workspace's only live slot for good, with no way out of Settings. This asserted the old refusal.
    const early = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.phone_numbers set status = 'releasing' where id = ${numberId} returning id`,
      ),
    );
    expect(early).toHaveLength(1);
    // What is still refused: finishing the release. Only the worker says a number has actually gone back.
    const finished = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.phone_numbers set status = 'released' where id = ${numberId}`),
      ),
    );
    expect(finished.detail).toBe('phone_number_status_transition');
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.phone_numbers set status = 'active', provider_sid = ${`PNfake${uniq()}`}, purchased_at = now() where id = ${numberId}`,
      ),
    );
    const releasing = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.phone_numbers set status = 'releasing' where id = ${numberId} returning id`,
      ),
    );
    expect(releasing).toHaveLength(1);
    const back = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.phone_numbers set status = 'active' where id = ${numberId}`),
      ),
    );
    expect(back.detail).toBe('phone_number_status_transition');
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.phone_numbers set status = 'released', released_at = now() where id = ${numberId}`,
      ),
    );
  });

  it('routes a live number to its workspace with every inbox user as a browser identity', async () => {
    const live = randomE164();
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, status, provider_sid, purchased_at)
            values (${wsA}, ${live}, 'local', 'active', ${`PNfake${uniq()}`}, now())`,
      ),
    );
    const [route] = await unscoped((tx) =>
      rows<{
        workspace_id: string;
        client_identities: string[];
        timezone: string;
        routing: object;
      }>(tx, sql`select * from private.phone_route(${live})`),
    );
    expect(route!.workspace_id).toBe(wsA);
    expect(route!.timezone).toBe('America/Chicago');
    expect([...route!.client_identities].sort()).toEqual(
      [identity(owner), identity(admin), identity(member)].sort(),
    );
    const released = await unscoped((tx) =>
      rows(tx, sql`select * from private.phone_route(${e164})`),
    );
    expect(released).toHaveLength(0);
    const people = await expectPgError(() =>
      as(member)((tx) => rows(tx, sql`select * from private.phone_route(${live})`)),
    );
    expect(people.code).toBe('42501');
  });

  /**
   * A number can now ring only its own people (M17), and the case that matters is the one where nobody has
   * chosen any. Getting the fallback wrong means inbound calls ring **nobody**, silently, for every business
   * that never opened the screen — which is the worst thing this system can do.
   */
  it('rings only a number’s own people, and everybody when it has none', async () => {
    const live = randomE164();
    const [n] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, status, provider_sid, purchased_at)
            values (${wsA}, ${live}, 'local', 'active', ${`PNfake${uniq()}`}, now()) returning id`,
      ),
    );
    const rings = async () => {
      const [route] = await unscoped((tx) =>
        rows<{ client_identities: string[] }>(tx, sql`select * from private.phone_route(${live})`),
      );
      return [...(route?.client_identities ?? [])].sort();
    };

    // Nobody on it: everybody with the inbox, exactly as before this existed.
    expect(await rings()).toEqual([identity(owner), identity(admin), identity(member)].sort());

    // One person on it: only them.
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`insert into app.phone_number_members (phone_number_id, user_id, workspace_id)
            values (${n!.id}, ${member.id}, ${wsA})`,
      ),
    );
    expect(await rings()).toEqual([identity(member)]);

    // Taken off again: back to everybody, not nobody. This is the line that would break quietly.
    await worker(
      wsA,
      orgA,
    )((tx) => rows(tx, sql`delete from app.phone_number_members where phone_number_id = ${n!.id}`));
    expect(await rings()).toEqual([identity(owner), identity(admin), identity(member)].sort());
  });

  it('never rings somebody on a number who does not work the inbox', async () => {
    // Being on a number is about which calls reach you, not about whether you may answer any — so the
    // permission is checked at call time too, and somebody taken off the inbox stops ringing even if
    // nobody remembered to take them off the number.
    const live = randomE164();
    const [n] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, status, provider_sid, purchased_at)
            values (${wsA}, ${live}, 'local', 'active', ${`PNfake${uniq()}`}, now()) returning id`,
      ),
    );
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`insert into app.phone_number_members (phone_number_id, user_id, workspace_id)
            values (${n!.id}, ${outsider.id}, ${wsA})`,
      ),
    );
    const [route] = await unscoped((tx) =>
      rows<{ client_identities: string[] }>(tx, sql`select * from private.phone_route(${live})`),
    );
    // The only person on it cannot work the inbox, so the member arm is empty and the fallback takes over.
    expect([...(route?.client_identities ?? [])].sort()).toEqual(
      [identity(owner), identity(admin), identity(member)].sort(),
    );
  });

  it('tells someone who sets the numbers up whether a teammate works the inbox, and nobody else', async () => {
    // Settings → Texting & calls' "who does this ring" (0110): the screen asks as the person saving.
    const works = (asker: TestUser, who: TestUser, ws: string) =>
      as(asker)((tx) =>
        rows<{ ok: boolean }>(tx, sql`select private.works_the_inbox(${who.id}, ${ws}) as ok`),
      ).then((r) => r[0]!.ok);
    expect(await works(owner, member, wsA)).toBe(true);
    expect(await works(admin, member, wsA)).toBe(true);
    expect(await works(owner, outsider, wsA)).toBe(false);
    // A member may not set the numbers up, and nobody may ask about another business.
    expect(await works(member, owner, wsA)).toBe(false);
    expect(await works(outsider, member, wsA)).toBe(false);
  });

  it('checks a verified user’s permission without switching to that user', async () => {
    const has = (u: TestUser, ws: string, perm: string) =>
      unscoped((tx) =>
        rows<{ ok: boolean }>(
          tx,
          sql`select private.user_has_permission(${u.id}, ${ws}, ${perm}) as ok`,
        ),
      ).then((r) => r[0]!.ok);
    expect(await has(owner, wsA, 'channels.manage')).toBe(true);
    expect(await has(admin, wsA, 'channels.manage')).toBe(true);
    expect(await has(member, wsA, 'channels.manage')).toBe(false);
    expect(await has(member, wsA, 'inbox.use')).toBe(true);
    expect(await has(outsider, wsA, 'inbox.use')).toBe(false);
  });
});

describe('carrier registrations', () => {
  it('owners send a registration; while it is under review only the worker changes it', async () => {
    const [reg] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.telephony_registrations (workspace_id, kind, status, submission, submitted_at, created_by)
            values (${wsA}, 'toll_free_verification', 'submitted', '{"legalName": "Telephony A LLC"}', now(), ${owner.id}) returning id`,
      ),
    );
    const byMember = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.telephony_registrations (workspace_id, kind, status, created_by) values (${wsA}, 'a2p_brand', 'draft', ${member.id})`,
        ),
      ),
    );
    expect(byMember.code).toBe('42501');
    const approved = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.telephony_registrations (workspace_id, kind, status, created_by) values (${wsA}, 'a2p_brand', 'approved', ${owner.id})`,
        ),
      ),
    );
    expect(approved.code).toBe('42501');
    const preSent = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.telephony_registrations (workspace_id, kind, status, submitted_at, carrier_submitted_at, created_by)
              values (${wsA}, 'a2p_brand', 'submitted', now(), now(), ${owner.id})`,
        ),
      ),
    );
    expect(preSent.code).toBe('42501');
    // The carrier doesn't have it yet: people may still change what goes, never which details the carrier has.
    const queued = await as(owner)((tx) =>
      rows<{ status: string }>(
        tx,
        sql`update app.telephony_registrations set submission = '{"legalName": "Telephony A LLC", "optIn": "queued"}'
            where id = ${reg!.id} returning status::text as status`,
      ),
    );
    expect(queued).toEqual([{ status: 'submitted' }]);
    const marker = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.telephony_registrations set carrier_submitted_at = submitted_at where id = ${reg!.id}`,
        ),
      ),
    );
    expect(marker.detail).toBe('registration_provider_fields');
    // The worker sent it: from now on it waits for the carriers.
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.telephony_registrations set status = 'in_review', provider_sid = 'HHfakerlstest', carrier_submitted_at = submitted_at
            where id = ${reg!.id}`,
      ),
    );
    const edit = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.telephony_registrations set submission = '{"legalName": "Changed"}' where id = ${reg!.id}`,
        ),
      ),
    );
    expect(edit.detail).toBe('registration_in_review');
    const carrier = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.telephony_registrations set provider_status = 'TWILIO_APPROVED' where id = ${reg!.id}`,
        ),
      ),
    );
    expect(carrier.detail).toBe('registration_provider_fields');
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.telephony_registrations set status = 'rejected', rejection_reason = 'Opt-in not shown on the website' where id = ${reg!.id}`,
      ),
    );
    const resent = await as(owner)((tx) =>
      rows<{ status: string }>(
        tx,
        sql`update app.telephony_registrations set status = 'submitted', submission = '{"legalName": "Telephony A LLC", "optIn": "fixed"}', submitted_at = now()
            where id = ${reg!.id} returning status::text as status`,
      ),
    );
    expect(resent).toEqual([{ status: 'submitted' }]);
    // Sent again, the carrier hasn't seen these details yet: they can still change until the worker sends them.
    const again = await as(owner)((tx) =>
      rows<{ status: string }>(
        tx,
        sql`update app.telephony_registrations set submission = '{"legalName": "Telephony A LLC", "optIn": "fixed again"}'
            where id = ${reg!.id} returning status::text as status`,
      ),
    );
    expect(again).toEqual([{ status: 'submitted' }]);
  });
});

describe('conversations and messages', () => {
  it('one conversation per customer and channel, and references stay in the workspace', async () => {
    const [conv] = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, created_by)
            values (${wsA}, 'sms', '+17135550142', ${personA}, ${member.id}) returning id`,
      ),
    );
    conversationA = conv!.id;
    const dup = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart, created_by) values (${wsA}, 'sms', '+17135550142', ${owner.id})`,
        ),
      ),
    );
    expect(dup.code).toBe('23505');
    const badPhone = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart, created_by) values (${wsA}, 'sms', '713-555-0142', ${member.id})`,
        ),
      ),
    );
    expect(badPhone.code).toBe('23514');
    const upperEmail = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart, created_by) values (${wsA}, 'email', 'Mike@Example.com', ${member.id})`,
        ),
      ),
    );
    expect(upperEmail.code).toBe('23514');
    const crossed = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, created_by) values (${wsA}, 'sms', '+17135550199', ${personB}, ${member.id})`,
        ),
      ),
    );
    expect(crossed.detail).toBe('record_workspace_mismatch');
    const theirs = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.conversations where id = ${conversationA}`),
    );
    expect(theirs).toHaveLength(0);
    const otherWorker = await worker(
      wsB,
      orgB,
    )((tx) => rows(tx, sql`select id from app.conversations where id = ${conversationA}`));
    expect(otherWorker).toHaveLength(0);
  });

  it('people only add queued outbound messages, sent as themselves', async () => {
    const ok = await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by)
            values (${wsA}, ${conversationA}, 'sms', 'outbound', 'queued', 'On our way', ${member.id}) returning id`,
      ),
    );
    expect(ok).toHaveLength(1);
    const inbound = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text) values (${wsA}, ${conversationA}, 'sms', 'inbound', 'received', 'Fake')`,
        ),
      ),
    );
    expect(inbound.code).toBe('42501');
    const asSomeoneElse = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by) values (${wsA}, ${conversationA}, 'sms', 'outbound', 'queued', 'Hi', ${owner.id})`,
        ),
      ),
    );
    expect(asSomeoneElse.code).toBe('42501');
    const alreadySent = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by) values (${wsA}, ${conversationA}, 'sms', 'outbound', 'sent', 'Hi', ${member.id})`,
        ),
      ),
    );
    expect(alreadySent.code).toBe('42501');
  });

  it('delivery status only moves forward: late callbacks are ignored and people only resend failures', async () => {
    const [msg] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, dedupe_key)
            values (${wsA}, ${conversationA}, 'sms', 'outbound', 'queued', 'Estimate attached', ${`SMfake${uniq()}`}) returning id`,
      ),
    );
    const setStatus = (status: string) =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows<{ status: string }>(
          tx,
          sql`update app.messages set status = ${status}::app.message_status where id = ${msg!.id} returning status::text as status`,
        ),
      ).then((r) => r[0]!.status);
    expect(await setStatus('sent')).toBe('sent');
    expect(await setStatus('delivered')).toBe('delivered');
    expect(await setStatus('sent')).toBe('delivered');
    const person = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`update app.messages set status = 'failed' where id = ${msg!.id}`),
      ),
    );
    expect(person.detail).toBe('message_status_transition');
    const body = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`update app.messages set body_text = 'Edited' where id = ${msg!.id}`),
      ),
    );
    expect(body.code).toBe('42501');

    const [failed] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, error_code)
            values (${wsA}, ${conversationA}, 'sms', 'outbound', 'failed', 'Landline?', '30006') returning id`,
      ),
    );
    const retried = await as(member)((tx) =>
      rows<{ status: string }>(
        tx,
        sql`update app.messages set status = 'queued', error_code = null, error_message = null where id = ${failed!.id} returning status::text as status`,
      ),
    );
    expect(retried).toEqual([{ status: 'queued' }]);
    // A retry in quiet hours is held: a person may move the time of a text still waiting to go…
    const held = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`update app.messages set occurred_at = now() + interval '8 hours' where id = ${failed!.id} returning id`,
      ),
    );
    expect(held).toHaveLength(1);

    const [inbound] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, dedupe_key)
            values (${wsA}, ${conversationA}, 'sms', 'inbound', 'received', 'Thanks!', ${`SMfake${uniq()}`}) returning id`,
      ),
    );
    const receivedMoves = await expectPgError(() =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(tx, sql`update app.messages set status = 'delivered' where id = ${inbound!.id}`),
      ),
    );
    expect(receivedMoves.detail).toBe('message_status_transition');
    // …but never the time of one that happened.
    const backdated = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`update app.messages set occurred_at = now() - interval '1 day' where id = ${inbound!.id}`,
        ),
      ),
    );
    expect(backdated.detail).toBe('message_time_change');
    const wrongChannel = await expectPgError(() =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text) values (${wsA}, ${conversationA}, 'email', 'outbound', 'queued', 'Hi')`,
        ),
      ),
    );
    expect(wrongChannel.detail).toBe('conversation_mismatch');
  });

  it('a replayed provider id lands on the same message', async () => {
    const key = `SMfake${uniq()}`;
    const insert = () =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, dedupe_key)
              values (${wsA}, ${conversationA}, 'sms', 'inbound', 'received', 'Twice', ${key})`,
        ),
      );
    await insert();
    const again = await expectPgError(insert);
    expect(again.code).toBe('23505');
  });
});

describe('calls, opt-outs and consent', () => {
  it('people place outbound calls; the worker records the rest and statuses only move forward', async () => {
    const [call] = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.calls (workspace_id, direction, status, to_e164, placed_by, person_id)
            values (${wsA}, 'outbound', 'initiated', '+17135550142', ${member.id}, ${personA}) returning id`,
      ),
    );
    const inbound = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.calls (workspace_id, direction, status, placed_by) values (${wsA}, 'inbound', 'initiated', ${member.id})`,
        ),
      ),
    );
    expect(inbound.code).toBe('42501');
    const edit = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`update app.calls set status = 'completed' where id = ${call!.id}`),
      ),
    );
    expect(edit.code).toBe('42501');
    const setStatus = (status: string) =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows<{ status: string }>(
          tx,
          sql`update app.calls set status = ${status}::app.call_status where id = ${call!.id} returning status::text as status`,
        ),
      ).then((r) => r[0]!.status);
    expect(await setStatus('in_progress')).toBe('in_progress');
    expect(await setStatus('ringing')).toBe('in_progress');
    expect(await setStatus('completed')).toBe('completed');
  });

  it('an opt-out is kept once per workspace and customer number', async () => {
    const add = (u: TestUser) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`insert into app.opt_outs (workspace_id, counterpart_e164, source, opted_out_at, created_by)
              values (${wsA}, '+17135550142', 'manual', now(), ${u.id}) returning id`,
        ),
      );
    expect(await add(member)).toHaveLength(1);
    const dup = await expectPgError(() => add(owner));
    expect(dup.code).toBe('23505');
    const theirs = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.opt_outs where workspace_id = ${wsA}`),
    );
    expect(theirs).toHaveLength(0);
  });

  it('SMS consent lives on the person', async () => {
    const [p] = await as(member)((tx) =>
      rows<{ sms_consent: string }>(
        tx,
        sql`update app.people set sms_consent = 'opted_out', sms_consent_at = now(), sms_consent_source = 'stop_keyword'
            where id = ${personA} returning sms_consent::text as sms_consent`,
      ),
    );
    expect(p!.sms_consent).toBe('opted_out');
  });

  it('the worker fills in a call entry it wrote but never a system entry', async () => {
    const [call] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.activities (workspace_id, kind, subtype, person_id, actor_type)
            values (${wsA}, 'call', 'voicemail', ${personA}, 'system') returning id`,
      ),
    );
    const filled = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.activities set body = 'The AC upstairs is blowing warm air.' where id = ${call!.id} returning id`,
      ),
    );
    expect(filled).toHaveLength(1);
    const [sys] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.activities (workspace_id, kind, subtype, person_id, actor_type)
            values (${wsA}, 'system', 'created', ${personA}, 'system') returning id`,
      ),
    );
    const untouched = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(tx, sql`update app.activities set body = 'Edited' where id = ${sys!.id} returning id`),
    );
    expect(untouched).toHaveLength(0);
  });
});

describe('webhook deliveries, scheduled jobs and media', () => {
  it('a webhook is stored once per provider id, and people cannot see deliveries', async () => {
    const key = `SMfake${uniq()}`;
    const record = () =>
      unscoped((tx) =>
        rows<{ delivery_id: string; inserted: boolean }>(
          tx,
          sql`select * from private.record_webhook_delivery('twilio', 'messaging.inbound', ${key}, 'ACfake', 'https://hooks.example.test/webhooks/twilio/messaging/inbound',
                '{"Body": "Hi"}'::jsonb, true, ${wsA}, ${orgA})`,
        ),
      ).then((r) => r[0]!);
    const first = await record();
    const second = await record();
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.delivery_id).toBe(first.delivery_id);
    const people = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select id from app.webhook_deliveries limit 1`)),
    );
    expect(people.code).toBe('42501');
  });

  it('pending jobs dedupe on kind and key, and a finished job frees the key', async () => {
    const key = `conversation:${uniq()}`;
    const schedule = () =>
      unscoped((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.scheduled_jobs (workspace_id, organization_id, kind, dedupe_key, run_at)
              values (${wsA}, ${orgA}, 'conversation.unanswered_check', ${key}, now() + interval '10 minutes') returning id`,
        ),
      );
    const [job] = await schedule();
    const dup = await expectPgError(schedule);
    expect(dup.code).toBe('23505');
    await unscoped((tx) =>
      rows(
        tx,
        sql`update app.scheduled_jobs set status = 'done', finished_at = now() where id = ${job!.id}`,
      ),
    );
    expect(await schedule()).toHaveLength(1);
  });

  it('members read their workspace’s telephony objects and nobody else does', async () => {
    const readable = (u: TestUser, path: string) =>
      as(u)((tx) =>
        rows<{ ok: boolean }>(
          tx,
          sql`select private.storage_read_allowed('telephony', ${path}) as ok`,
        ),
      ).then((r) => r[0]!.ok);
    expect(await readable(member, `${wsA}/media/thermostat.jpg`)).toBe(true);
    expect(await readable(outsider, `${wsA}/media/thermostat.jpg`)).toBe(false);
    expect(await readable(member, 'media/thermostat.jpg')).toBe(false);
  });
});

/**
 * 0077: which number is "the" one, when a business has several.
 *
 * Every one of these was written after the fact, because the first run of these migrations against a real
 * database found two bugs that nothing here could have caught:
 *
 *   - `private.phone_numbers_keep_default()` compared an enum column to a `text[]`, which has no operator.
 *     A plpgsql body is not type-checked until it runs, so the migration applied and then every number
 *     anybody bought failed.
 *   - the hand-off rule fired between the two statements that move a default, put the old number straight
 *     back, and made `phone_number.set_default` collide with the unique index — for every business with
 *     more than one number, which is every business this milestone is for.
 */
describe('one number is the default', () => {
  const buy = async (ws: string, org: string, status = 'active') => {
    const [n] = await worker(
      ws,
      org,
    )((tx) =>
      rows<{ id: string; e164: string }>(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
            values (${ws}, ${randomE164()}, 'local', ${status}::app.phone_number_status)
            returning id, e164`,
      ),
    );
    return n!;
  };
  const defaults = (ws: string, org: string) =>
    worker(
      ws,
      org,
    )((tx) =>
      rows<{ id: string; is_default: boolean; status: string }>(
        tx,
        sql`select id::text, is_default, status::text from app.phone_numbers
            where workspace_id = ${ws} order by created_at, id`,
      ),
    );

  let ws: string;
  let org: string;
  beforeAll(async () => {
    const u = await createTestUser(`num-${uniq()}`);
    const o = await bootstrapOrganization(u, `Numbers ${uniq()}`, `Numbers ${uniq()}`);
    ws = o.wsId;
    org = o.orgId;
  }, 60_000);

  it('gives the first number the default, so a business is never left without one', async () => {
    const first = await buy(ws, org, 'provisioning');
    const all = await defaults(ws, org);
    expect(all.find((n) => n.id === first.id)?.is_default).toBe(true);
  });

  it('does not let a second number quietly demote the first', async () => {
    const first = (await defaults(ws, org))[0]!;
    await buy(ws, org);
    const all = await defaults(ws, org);
    expect(all.find((n) => n.id === first.id)?.is_default).toBe(true);
    expect(all.filter((n) => n.is_default)).toHaveLength(1);
  });

  it('moves the default when a business chooses another, which the index alone refuses', async () => {
    const all = await defaults(ws, org);
    const target = all.find((n) => !n.is_default)!;
    // Exactly what phone_number.set_default does: clear the old one, then set the new one.
    await worker(
      ws,
      org,
    )(async (tx) => {
      await rows(
        tx,
        sql`update app.phone_numbers set is_default = false
            where workspace_id = ${ws} and is_default and id <> ${target.id}::uuid`,
      );
      await rows(
        tx,
        sql`update app.phone_numbers set is_default = true where id = ${target.id}::uuid`,
      );
    });
    const after = await defaults(ws, org);
    expect(after.find((n) => n.id === target.id)?.is_default).toBe(true);
    expect(after.filter((n) => n.is_default)).toHaveLength(1);
  });

  it('hands the default on when the number holding it stops being live', async () => {
    const holder = (await defaults(ws, org)).find((n) => n.is_default)!;
    await worker(
      ws,
      org,
    )((tx) =>
      rows(tx, sql`update app.phone_numbers set status = 'released' where id = ${holder.id}::uuid`),
    );
    const after = await defaults(ws, org);
    const live = after.filter((n) => ['provisioning', 'active', 'releasing'].includes(n.status));
    expect(after.find((n) => n.id === holder.id)?.is_default).toBe(false);
    expect(live.filter((n) => n.is_default)).toHaveLength(1);
  });

  it('never lets two live numbers hold it at once', async () => {
    const live = (await defaults(ws, org)).filter((n) =>
      ['provisioning', 'active', 'releasing'].includes(n.status),
    );
    const other = live.find((n) => !n.is_default);
    if (!other) return;
    const e = await expectPgError(() =>
      worker(
        ws,
        org,
      )((tx) =>
        rows(tx, sql`update app.phone_numbers set is_default = true where id = ${other.id}::uuid`),
      ),
    );
    expect(e.code).toBe('23505');
  });
});

describe('RCS (0103)', () => {
  it('a read message stays read, and what a text carried and which button a reply came from never change', async () => {
    const [msg] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, rich)
            values (${wsA}, ${conversationA}, 'sms', 'outbound', 'sent', 'Tomorrow at 2?',
              ${JSON.stringify({ kind: 'buttons', title: null, buttons: [], cards: [], smsText: 'Tomorrow at 2?' })}::jsonb)
            returning id`,
      ),
    );
    const setStatus = (status: string) =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows<{ status: string }>(
          tx,
          sql`update app.messages set status = ${status}::app.message_status where id = ${msg!.id} returning status::text as status`,
        ),
      ).then((r) => r[0]!.status);
    expect(await setStatus('read')).toBe('read');
    // A late delivered never undoes read.
    expect(await setStatus('delivered')).toBe('read');
    const rich = await expectPgError(() =>
      worker(
        wsA,
        orgA,
      )((tx) => rows(tx, sql`update app.messages set rich = null where id = ${msg!.id}`)),
    );
    expect(rich.code).toBe('23514');
    // The worker learns the way a text went, and when it was read.
    const [after] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ transport: string }>(
        tx,
        sql`update app.messages set transport = 'rcs', read_at = now() where id = ${msg!.id}
            returning transport::text as transport`,
      ),
    );
    expect(after?.transport).toBe('rcs');
  });

  it('people send rich texts, never what the carrier says about them', async () => {
    const ok = await as(member)((tx) =>
      rows(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by, rich)
            values (${wsA}, ${conversationA}, 'sms', 'outbound', 'queued', 'Pick one', ${member.id},
              ${JSON.stringify({ kind: 'buttons', title: null, buttons: [], cards: [], smsText: 'Pick one' })}::jsonb)
            returning id`,
      ),
    );
    expect(ok).toHaveLength(1);
    const claimed = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by, transport)
              values (${wsA}, ${conversationA}, 'sms', 'outbound', 'queued', 'Hi', ${member.id}, 'rcs')`,
        ),
      ),
    );
    expect(claimed.code).toBe('42501');
    const read = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by, read_at)
              values (${wsA}, ${conversationA}, 'sms', 'outbound', 'queued', 'Hi', ${member.id}, now())`,
        ),
      ),
    );
    expect(read.code).toBe('42501');
  });

  it('only texts travel by carrier: email and chat carry no transport, buttons or card', async () => {
    const [mail] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart)
            values (${wsA}, 'email', ${`rcs-${uniq()}@example.com`}) returning id`,
      ),
    );
    const bad = await expectPgError(() =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, transport)
              values (${wsA}, ${mail!.id}, 'email', 'outbound', 'queued', 'Hi', 'rcs')`,
        ),
      ),
    );
    expect(bad.code).toBe('23514');
  });

  it('owners and admins connect a sender; everything Twilio says about it is the worker’s', async () => {
    const byMember = await expectPgError(() =>
      as(member)((tx) =>
        rows(
          tx,
          sql`insert into app.rcs_senders (workspace_id, sender_id, created_by)
              values (${wsA}, 'lonestar_agent', ${member.id})`,
        ),
      ),
    );
    expect(byMember.code).toBe('42501');
    const alreadyLive = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.rcs_senders (workspace_id, sender_id, created_by, status)
              values (${wsA}, 'lonestar_agent', ${owner.id}, 'active')`,
        ),
      ),
    );
    expect(alreadyLive.code).toBe('42501');
    const [s] = await as(admin)((tx) =>
      rows<{ id: string; status: string }>(
        tx,
        sql`insert into app.rcs_senders (workspace_id, sender_id, created_by)
            values (${wsA}, 'lonestar_agent', ${admin.id}) returning id, status::text as status`,
      ),
    );
    expect(s?.status).toBe('connecting');
    // One sender at a time.
    const second = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`insert into app.rcs_senders (workspace_id, sender_id, created_by)
              values (${wsA}, 'another_agent', ${owner.id})`,
        ),
      ),
    );
    expect(second.code).toBe('23505');
    // What Twilio said is the worker's to write.
    const approved = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.rcs_senders set status = 'active' where id = ${s!.id}`),
      ),
    );
    expect(approved.detail).toBe('rcs_sender_status_transition');
    const providerSid = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.rcs_senders set in_service = true where id = ${s!.id}`),
      ),
    );
    expect(providerSid.detail).toBe('rcs_sender_provider_fields');
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(
        tx,
        sql`update app.rcs_senders set status = 'active', provider_sid = 'XEfakesender', in_service = true,
              provider_status = 'ONLINE' where id = ${s!.id}`,
      ),
    );
    // A person switches RCS off, and lets the sender go.
    const off = await as(owner)((tx) =>
      rows<{ enabled: boolean }>(
        tx,
        sql`update app.rcs_senders set enabled = false where id = ${s!.id} returning enabled`,
      ),
    );
    expect(off).toEqual([{ enabled: false }]);
    const renamed = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.rcs_senders set sender_id = 'other_agent' where id = ${s!.id}`),
      ),
    );
    expect(renamed.detail).toBe('rcs_sender_id_fixed');
    const going = await as(owner)((tx) =>
      rows<{ status: string }>(
        tx,
        sql`update app.rcs_senders set status = 'disconnecting' where id = ${s!.id}
            returning status::text as status`,
      ),
    );
    expect(going).toEqual([{ status: 'disconnecting' }]);
    // Another business never sees it.
    const seen = await as(outsider)((tx) =>
      rows(tx, sql`select id from app.rcs_senders where id = ${s!.id}`),
    );
    expect(seen).toHaveLength(0);
    // Members see it: the composer says a text will go as RCS.
    const theirs = await as(member)((tx) =>
      rows(tx, sql`select id from app.rcs_senders where id = ${s!.id}`),
    );
    expect(theirs).toHaveLength(1);
    await worker(
      wsA,
      orgA,
    )((tx) =>
      rows(tx, sql`update app.rcs_senders set status = 'disconnected' where id = ${s!.id}`),
    );
  });
});
