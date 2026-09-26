import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { numberImports, twilioConnections } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { defineQuery } from '../kernel/define';
import { numberTypeOf, textingStateOf } from '../messaging/number-import';
import { loadRegistrations, numbersOf, readiness } from '../messaging/store';
import {
  NumberImportListInput,
  NumberImportListOutput,
  TwilioConnectionListInput,
  TwilioConnectionListOutput,
} from '../schemas/number-import';
import { numbersFromMigration } from './port';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const SETUP = {
  waiting: 'waiting_for_transfer',
  complete: 'live',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

/**
 * Every number this business is bringing over from Twilio or HighLevel, with **two statuses side by side**:
 * `setup`, the number itself (waiting for the transfer, then live here), and `texting`, the carrier
 * registration it needs before texts go out. A number can be live — calls ringing, texts arriving — while
 * texting still waits on the carriers, and the screen says exactly that rather than folding the two into one.
 *
 * `texting` is worked out even for a number that has not arrived: a business whose 10DLC campaign is already
 * approved should know the number will text the moment it lands (it joins the same messaging service), and one
 * that has never registered should know now rather than on the day.
 */
export const numberImportList = defineQuery({
  name: 'number_import.list',
  description:
    'Numbers this business is bringing over from a Twilio account or GoHighLevel, with where the number stands and, separately, where its texting registration stands.',
  input: NumberImportListInput,
  output: NumberImportListOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const all = await ctx.tx
      .select()
      .from(numberImports)
      .where(
        input.includeFinished
          ? eq(numberImports.workspaceId, input.workspaceId)
          : // A failed or called-off one still shows: that is when a business most needs to see why. Only a
            // finished one drops out, because it is one of their numbers now and shows there.
            and(
              eq(numberImports.workspaceId, input.workspaceId),
              ne(numberImports.status, 'complete'),
            ),
      )
      .orderBy(desc(numberImports.createdAt))
      .limit(50);
    const regs = await loadRegistrations(ctx.tx, input.workspaceId);
    const numbers = await numbersOf(ctx.tx, input.workspaceId);
    const byId = new Map(numbers.map((n) => [n.id, n]));

    const imported = new Set(
      all.filter((r) => r.status === 'waiting' || r.status === 'complete').map((r) => r.e164),
    );
    const fromMigration = (await numbersFromMigration(ctx.tx, input.workspaceId)).filter(
      (n) => !imported.has(n.e164),
    );

    return {
      fromMigration,
      imports: all.map((r) => {
        const numberType = r.numberType ?? numberTypeOf(r.e164);
        const landed = r.phoneNumberId ? byId.get(r.phoneNumberId) : undefined;
        // Before it lands: what it will need, as if it were here and working.
        const next = readiness(landed ?? { status: 'active', numberType }, regs).nextStep;
        const display = formatPhone(r.e164);
        return {
          id: r.id,
          e164: r.e164,
          display,
          source: r.source,
          status: r.status,
          numberType,
          connectionId: r.connectionId,
          sourceAccountSid: r.sourceAccountSid,
          sourceNumberSid: r.sourceNumberSid,
          carrierName: r.carrierName,
          hostedInTwilio: r.hostedInTwilio,
          destinationAccountSid: r.destinationAccountSid,
          phoneNumberId: r.phoneNumberId,
          setup: SETUP[r.status],
          texting: textingStateOf(next),
          lastError: r.lastError,
          lastCheckedAt: iso(r.lastCheckedAt),
          completedAt: iso(r.completedAt),
          createdAt: r.createdAt.toISOString(),
        };
      }),
    };
  },
});

/**
 * The Twilio accounts this organization connected, and the businesses a number can be assigned to.
 *
 * A connection is the organization's and **only its owners and admins see one** (RLS), because listing an
 * account lists every business's numbers in it. Anybody else who can manage this business's numbers gets an
 * empty list and `canConnect: false` — they can still bring a number in by asking for it to be sent here.
 */
export const twilioConnectionList = defineQuery({
  name: 'twilio_connection.list',
  description:
    'Twilio accounts connected to this organization so their numbers can be brought in, and the businesses each number can go to.',
  input: TwilioConnectionListInput,
  output: TwilioConnectionListOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx) {
    const organizationId = ctx.scope.organizationId!;
    // Asked of the organization itself: a workspace's resolved scope says what the person is in the business,
    // not whether they own or run the organization above it.
    const [role] = await rows<{ role: string | null }>(
      ctx.tx,
      sql`select private.org_role(${organizationId}::uuid) as role`,
    );
    const canConnect = role?.role === 'owner' || role?.role === 'admin';
    // Named columns, never `select()`: the sealed secret is not granted to a person at all, so asking for every
    // column is refused outright.
    const connections = await ctx.tx
      .select({
        id: twilioConnections.id,
        accountSid: twilioConnections.accountSid,
        friendlyName: twilioConnections.friendlyName,
        apiKeySid: twilioConnections.apiKeySid,
        status: twilioConnections.status,
        lastError: twilioConnections.lastError,
        checkedAt: twilioConnections.checkedAt,
        createdAt: twilioConnections.createdAt,
      })
      .from(twilioConnections)
      .where(
        and(
          eq(twilioConnections.organizationId, organizationId),
          inArray(twilioConnections.status, ['active', 'broken']),
        ),
      )
      .orderBy(desc(twilioConnections.createdAt));
    // Where this person may put a number: this organization's businesses they can manage numbers in.
    const places = await rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select w.id, w.name from app.workspaces w
          where w.organization_id = ${organizationId} and w.deletion_requested_at is null
            and private.has_permission(w.id, 'channels.manage')
          order by w.name`,
    );
    return {
      canConnect,
      connections: connections.map((c) => ({
        id: c.id,
        accountSid: c.accountSid,
        friendlyName: c.friendlyName,
        usesApiKey: !!c.apiKeySid,
        status: c.status,
        lastError: c.lastError,
        checkedAt: iso(c.checkedAt),
        createdAt: c.createdAt.toISOString(),
      })),
      workspaces: places,
    };
  },
});
