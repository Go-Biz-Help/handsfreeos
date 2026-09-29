/**
 * Bringing a number that already lives in Twilio (20261010000900): the worker's side of the settings screen.
 *
 * Four routes, each one a provider call the API may not make (it refuses to start with any provider key):
 *
 * - `number-host` — who hosts a number today, by the carrier lookup. This is how a GoHighLevel / LeadConnector
 *   number is recognised as sitting in Twilio (HighLevel's account), which means it can move account to account
 *   in days instead of a carrier port's weeks.
 * - `twilio/connect` — signs in to the business's own Twilio account with what they gave us, seals it, and
 *   lists what is in it.
 * - `twilio/numbers` — lists a connected account again: each number, who is using it today (HighLevel shows up
 *   by its webhooks), and whether it is already here or on its way to one of this organization's businesses.
 * - `twilio/disconnect` — lets a connected account go and wipes what it was opened with.
 *
 * **Connecting is for the organization's owners and admins**, because listing an account lists every business's
 * numbers in it. Choosing which business a number goes to is then `number_import.start` through the API, which
 * asks `channels.manage` of that business — the same question buying a number asks.
 *
 * The credentials a business types go from the request straight into the provider call and the sealer. Nothing
 * here logs them, and nothing sends them back.
 */
import {
  executeCommand,
  formatPhone,
  HfosError,
  numberTypeOf,
  numberUsedBy,
  phoneRequired,
  TwilioConnectInput,
  twilioConnectionDisconnect,
  twilioConnectionFail,
  twilioConnectionSave,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { and, eq } from 'drizzle-orm';
import { twilioConnections } from '@hfos/db/schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { systemActor, workerMeta } from '../services';
import { ProviderError, type ExternalTwilioCreds } from '../telephony/provider';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';

/** More than any one business has; an agency's whole account, near enough. */
const MAX_LISTED = 500;
/** Carrier lookups cost money per number, so one person gets a handful a minute and no more. */
const LOOKUPS_PER_MINUTE = 10;

const HostInput = z.strictObject({ workspaceId: z.uuid(), e164: phoneRequired });
const ConnectionInput = z.strictObject({ workspaceId: z.uuid(), connectionId: z.uuid() });

type ConnectionRow = typeof twilioConnections.$inferSelect;

/** The organization a business belongs to, or a 404 for one that does not exist. */
async function organizationOf(deps: HttpDeps, workspaceId: string): Promise<string> {
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ organization_id: string | null }>(
      tx,
      sql`select private.workspace_organization(${workspaceId}::uuid) as organization_id`,
    ),
  );
  if (!row?.organization_id)
    throw HfosError.notFound('This workspace isn’t there anymore. Refresh the page and try again.');
  return row.organization_id;
}

/**
 * The person may manage this business's numbers **and** is an owner or admin of its organization. Answers with
 * the organization, since every route below needs it next.
 */
async function requireConnector(
  deps: HttpDeps,
  userId: string,
  workspaceId: string,
): Promise<string> {
  await requirePermission(deps, userId, workspaceId, 'channels.manage');
  const organizationId = await organizationOf(deps, workspaceId);
  const [row] = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ ok: boolean }>(
      tx,
      sql`select private.user_manages_organization(${userId}::uuid, ${organizationId}::uuid) as ok`,
    ),
  );
  if (!row?.ok)
    throw HfosError.forbidden(
      'Only the owners and admins of your organization can connect a Twilio account, because it can hold every one of your businesses’ numbers.',
    );
  return organizationId;
}

const refused = (e: unknown) =>
  e instanceof ProviderError && (e.httpStatus === 401 || e.httpStatus === 403);

const WRONG_CREDENTIALS =
  'Twilio did not accept those. Check the Account SID and the auth token — or the API key SID and its secret — in your Twilio console, and try again.';

/** The connection as the screen shows it: never its secret. */
const connectionOut = (c: ConnectionRow) => ({
  id: c.id,
  accountSid: c.accountSid,
  friendlyName: c.friendlyName,
  usesApiKey: !!c.apiKeySid,
  status: c.status,
  lastError: c.lastError,
  checkedAt: c.checkedAt ? c.checkedAt.toISOString() : null,
  createdAt: c.createdAt.toISOString(),
});

/**
 * Every number in the account, and where each stands for this organization: already one of its numbers, on its
 * way to one of its businesses, or free to bring in. A number another organization holds says only that.
 */
async function listNumbers(deps: HttpDeps, organizationId: string, creds: ExternalTwilioCreds) {
  const found = await deps.telephony.listAccountNumbers(creds, { limit: MAX_LISTED + 1 });
  const numbers = found.slice(0, MAX_LISTED);
  const [held, waiting] = await asWorker(deps.httpDb, {}, async (tx) => [
    numbers.length
      ? await rows<{
          e164: string;
          workspace_id: string;
          organization_id: string;
          workspace_name: string;
        }>(
          tx,
          sql`select x.e164, h.workspace_id, h.organization_id, h.workspace_name
              from jsonb_array_elements_text(${JSON.stringify(numbers.map((n) => n.e164))}::jsonb) as x(e164)
              cross join lateral private.number_held_by(x.e164) h`,
        )
      : [],
    await rows<{ e164: string; workspace_id: string; workspace_name: string }>(
      tx,
      sql`select e164, workspace_id, workspace_name from private.number_imports_waiting(${organizationId}::uuid)`,
    ),
  ]);
  const heldBy = new Map(held.map((h) => [h.e164, h]));
  const waitingFor = new Map(waiting.map((w) => [w.e164, w]));
  return {
    truncated: found.length > MAX_LISTED,
    numbers: numbers.map((n) => {
      const h = heldBy.get(n.e164);
      const w = waitingFor.get(n.e164);
      return {
        sid: n.sid,
        accountSid: n.accountSid,
        accountName: n.accountName,
        e164: n.e164,
        display: formatPhone(n.e164),
        friendlyName: n.friendlyName,
        numberType: numberTypeOf(n.e164),
        capabilities: n.capabilities,
        usedBy: numberUsedBy(n, deps.publicUrl),
        // Named only inside this organization. Anybody else's business is just "another business".
        heldBy: h
          ? h.organization_id === organizationId
            ? { workspaceId: h.workspace_id, workspaceName: h.workspace_name }
            : { workspaceId: null, workspaceName: null }
          : null,
        comingTo: w ? { workspaceId: w.workspace_id, workspaceName: w.workspace_name } : null,
      };
    }),
  };
}

export function registerNumberImportRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const recentLookups = new Map<string, number[]>();

  /** Who hosts a number today, and so whether it can move account to account inside Twilio. */
  app.post('/v1/telephony/number-host', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(HostInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'channels.manage');
    const now = Date.now();
    const mine = (recentLookups.get(actor.userId) ?? []).filter((t) => now - t < 60_000);
    if (mine.length >= LOOKUPS_PER_MINUTE)
      throw HfosError.rule(
        'too_many_lookups',
        429,
        'That is a lot of numbers in a minute. Wait a moment and try again.',
      );
    recentLookups.set(actor.userId, [...mine, now]);

    const found = await deps.telephony.lookupNumber(input.e164);
    const [held] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ workspace_id: string }>(
        tx,
        sql`select workspace_id from private.number_held_by(${input.e164})`,
      ),
    );
    return {
      e164: input.e164,
      display: formatPhone(input.e164),
      numberType: numberTypeOf(input.e164),
      carrierName: found.carrierName,
      lineType: found.lineType,
      hostedInTwilio: !!found.carrierName && /twilio/i.test(found.carrierName),
      // Already one of this business's numbers, or somebody else's here: either way there is nothing to bring.
      alreadyHere: held ? (held.workspace_id === input.workspaceId ? 'yours' : 'elsewhere') : null,
    };
  });

  /** Signs in to the business's own Twilio account, keeps it sealed, and lists what is in it. */
  app.post('/v1/telephony/twilio/connect', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(TwilioConnectInput, req.body);
    const organizationId = await requireConnector(deps, actor.userId, input.workspaceId);

    // One of our own accounts is not "their Twilio": its numbers are already here, and its token is ours.
    const [ours] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ account_id: string }>(
        tx,
        sql`select account_id from private.telephony_account_lookup(${input.accountSid})`,
      ),
    );
    if (ours || input.accountSid === deps.telephony.masterAccountSid)
      throw HfosError.rule(
        'twilio_account_is_ours',
        409,
        'That is one of HandsFreeOS’s own Twilio accounts — its numbers are already here.',
      );

    const secret = input.authToken ?? input.apiKeySecret!;
    const creds: ExternalTwilioCreds = {
      accountSid: input.accountSid,
      username: input.authToken ? input.accountSid : input.apiKeySid!,
      secret,
    };
    let account;
    try {
      account = await deps.telephony.inspectAccount(creds);
    } catch (e) {
      if (refused(e)) throw HfosError.rule('twilio_credentials', 400, WRONG_CREDENTIALS);
      throw e;
    }
    if (account.ownerAccountSid === deps.telephony.masterAccountSid)
      throw HfosError.rule(
        'twilio_account_is_ours',
        409,
        'That is one of HandsFreeOS’s own Twilio accounts — its numbers are already here.',
      );
    if (account.status !== 'active')
      throw HfosError.rule(
        'twilio_account_inactive',
        409,
        `That Twilio account is ${account.status}, and numbers can only move out of an active one. Reactivate it in your Twilio console, or connect a different account.`,
      );

    const scope = { workspaceId: input.workspaceId, organizationId };
    const { output } = await executeCommand(
      deps.httpDb,
      twilioConnectionSave,
      {
        organizationId,
        accountSid: account.sid,
        friendlyName: account.friendlyName,
        apiKeySid: input.authToken ? null : input.apiKeySid!,
        secretEnc: deps.sealer.seal(secret),
        keyId: deps.sealer.keyId,
      },
      systemActor(scope, actor.userId),
      workerMeta(),
    );
    const [row] = await asWorker(deps.httpDb, scope, (tx) =>
      tx.select().from(twilioConnections).where(eq(twilioConnections.id, output.connectionId)),
    );
    return { connection: connectionOut(row!), ...(await listNumbers(deps, organizationId, creds)) };
  });

  /** A connected account's numbers, listed again. */
  app.post('/v1/telephony/twilio/numbers', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(ConnectionInput, req.body);
    const organizationId = await requireConnector(deps, actor.userId, input.workspaceId);
    const scope = { workspaceId: input.workspaceId, organizationId };
    const [row] = await asWorker(deps.httpDb, scope, (tx) =>
      tx
        .select()
        .from(twilioConnections)
        .where(
          and(
            eq(twilioConnections.id, input.connectionId),
            eq(twilioConnections.organizationId, organizationId),
          ),
        ),
    );
    if (!row || row.status === 'disconnected' || !row.secretEnc)
      throw HfosError.notFound('That Twilio account is not connected any more. Connect it again.');
    const creds: ExternalTwilioCreds = {
      accountSid: row.accountSid,
      username: row.apiKeySid ?? row.accountSid,
      secret: deps.sealer.open(row.secretEnc),
    };
    try {
      return {
        connection: connectionOut(row),
        ...(await listNumbers(deps, organizationId, creds)),
      };
    } catch (e) {
      if (!refused(e)) throw e;
      // Revoked in Twilio, or the token was rotated. Say so on the connection, where the screen shows it.
      const reason =
        'Twilio no longer accepts the credentials this account was connected with. Connect it again with a current auth token or API key.';
      await executeCommand(
        deps.httpDb,
        twilioConnectionFail,
        { organizationId, connectionId: row.id, reason },
        systemActor(scope, actor.userId),
        workerMeta(),
      );
      throw HfosError.rule('twilio_credentials', 409, reason);
    }
  });

  /** Lets a connected account go. Numbers already on their way keep coming: they are watched for here. */
  app.post('/v1/telephony/twilio/disconnect', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(ConnectionInput, req.body);
    const organizationId = await requireConnector(deps, actor.userId, input.workspaceId);
    const { output } = await executeCommand(
      deps.httpDb,
      twilioConnectionDisconnect,
      { organizationId, connectionId: input.connectionId },
      systemActor({ workspaceId: input.workspaceId, organizationId }, actor.userId),
      workerMeta(),
    );
    return output;
  });
}
