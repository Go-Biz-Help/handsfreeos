/**
 * An add-on's connections to other services (round five, 20261021000100). A business gives an add-on its account at
 * a service its manifest names (`connectors`): a key it pastes or a sign-in, which the worker tries with the service
 * and seals before anything is kept, or HandsFreeOS's own account, which staff turn on.
 *
 * - **The worker's commands** (`save`, `health`) run as the system on a person's behalf, once the worker has asked
 *   the permission question; a person's own database role writes nothing here.
 * - **Letting one go** is a person's, and the database checks they may (`private.disconnect_addon_connection`): its
 *   secret is wiped there and then.
 * - **HandsFreeOS's own account** is staff's (`private.set_addon_platform_connection` checks for itself).
 *
 * Nothing emitted carries more than which add-on, what for and which service.
 */
import { and, eq, ne } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { addonConnections } from '@hfos/db/schema';
import { findAddon, type Catalog } from '../addons/graph';
import type { AddonConnector, AddonConnectorProvider } from '../addons/manifest';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import {
  AddonConnectionDisconnectInput,
  AddonConnectionDisconnectOutput,
  AddonConnectionHealthInput,
  AddonConnectionHealthOutput,
  AddonConnectionOutput,
  AddonConnectionPlatformInput,
  AddonConnectionPlatformOutput,
  AddonConnectionSaveInput,
  AddonConnectionWebhookInput,
  AddonConnectionWebhookOutput,
} from '../schemas/addon-connection';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** After this many failures in a row, a connection reads "not working" rather than "trying again". */
export const CONNECTION_FAILURES_BEFORE_ERROR = 5;

/** The connector and service an add-on's manifest declares, or a refusal that says so. */
export function connectorOf(
  catalog: Catalog,
  addonId: string,
  connector: string,
  provider: string,
): { readonly connector: AddonConnector; readonly provider: AddonConnectorProvider } {
  const m = findAddon(catalog, addonId);
  const c = m?.connectors?.find((x) => x.key === connector);
  const p = c?.providers.find((x) => x.id === provider);
  if (!m || !c || !p)
    throw HfosError.rule(
      'addon_connector_unknown',
      404,
      'That add-on doesn’t connect to that service. Pick one from its Connections.',
    );
  return { connector: c, provider: p };
}

export function addonConnectionCommands(catalog: Catalog) {
  const save = defineCommand({
    name: 'addon_connection.save',
    description:
      'Worker: a service accepted the key or sign-in a business gave one of its add-ons, sealed by the worker. It replaces the add-on’s own account there, if it had one.',
    risk: 2,
    input: AddonConnectionSaveInput,
    output: AddonConnectionOutput,
    permission: null,
    actors: ['system'],
    scope: inWorkspace,
    emits: ['addon_connection.connected'],
    async handler(ctx, input) {
      const { connector, provider } = connectorOf(
        catalog,
        input.addonId,
        input.connector,
        input.provider,
      );
      if (!provider.auth.includes(input.auth))
        throw HfosError.rule(
          'addon_connector_auth',
          409,
          `${provider.label} doesn’t connect that way here. Use what its Connections offers.`,
        );
      const [on] = await rows<{ ok: boolean }>(
        ctx.tx,
        sql`select private.addon_in_use(${input.workspaceId}::uuid, ${input.addonId}, true) as ok`,
      );
      if (!on?.ok) throw HfosError.addonInactive(findAddon(catalog, input.addonId)!);
      const at = new Date();
      const live = and(
        eq(addonConnections.workspaceId, input.workspaceId),
        eq(addonConnections.addonId, input.addonId),
        eq(addonConnections.connector, input.connector),
        ne(addonConnections.status, 'disconnected'),
      );
      // One of its own at a time (a listing feed): the business's other accounts for it go. HandsFreeOS's own stays,
      // used again if this one is let go.
      if (!connector.many)
        await ctx.tx
          .update(addonConnections)
          .set({
            status: 'disconnected',
            secretEnc: null,
            keyId: null,
            pkceVerifierEnc: null,
            oauthStateHash: null,
            webhookTokenHash: null,
            webhookSecretEnc: null,
            disconnectedAt: at,
          })
          .where(
            and(
              live,
              ne(addonConnections.provider, input.provider),
              ne(addonConnections.auth, 'platform'),
            ),
          );
      const values = {
        auth: input.auth,
        status: 'active' as const,
        permission: connector.permission,
        label: input.label,
        accountRef: input.accountRef,
        details: input.details,
        secretEnc: input.secretEnc,
        keyId: input.keyId,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        lastSuccessAt: at,
        failingSince: null,
        failures: 0,
        lastError: null,
        connectedBy: input.connectedBy,
        connectedAt: at,
        disconnectedAt: null,
      };
      const [was] = await ctx.tx
        .select({ id: addonConnections.id })
        .from(addonConnections)
        .where(
          and(
            live,
            eq(addonConnections.provider, input.provider),
            ne(addonConnections.auth, 'platform'),
          ),
        )
        .for('update');
      const [row] = was
        ? await ctx.tx
            .update(addonConnections)
            .set(values)
            .where(eq(addonConnections.id, was.id))
            .returning({ id: addonConnections.id })
        : await ctx.tx
            .insert(addonConnections)
            .values({
              workspaceId: input.workspaceId,
              addonId: input.addonId,
              connector: input.connector,
              provider: input.provider,
              ...values,
            })
            .returning({ id: addonConnections.id });
      await ctx.emit({
        type: 'addon_connection.connected',
        entityType: 'addon_connection',
        entityId: row!.id,
        payload: {
          addonId: input.addonId,
          connector: input.connector,
          provider: input.provider,
          again: !!was,
        },
        after: {
          addon: input.addonId,
          for: connector.label,
          service: provider.label,
          ...(input.label ? { account: input.label } : {}),
        },
      });
      return { connectionId: row!.id };
    },
  });

  const disconnect = defineCommand({
    name: 'addon_connection.disconnect',
    description:
      'Let go of an add-on’s account at another service. Its key or sign-in is wiped at once; the add-on uses HandsFreeOS’s own account there, if it has one, or nothing.',
    risk: 2,
    input: AddonConnectionDisconnectInput,
    output: AddonConnectionDisconnectOutput,
    // Who may is the connection's own permission: the database checks it.
    permission: 'workspace.read',
    scope: inWorkspace,
    emits: ['addon_connection.disconnected'],
    async handler(ctx, input) {
      const [done] = await rows<{
        connector: string;
        provider: string;
        auth: string;
        changed: boolean;
      }>(
        ctx.tx,
        sql`select connector, provider, auth, changed
            from private.disconnect_addon_connection(${input.workspaceId}::uuid, ${input.connectionId}::uuid)`,
      );
      if (!done) throw HfosError.internal();
      if (done.changed) {
        const [row] = await ctx.tx
          .select({ addonId: addonConnections.addonId })
          .from(addonConnections)
          .where(eq(addonConnections.id, input.connectionId));
        await ctx.emit({
          type: 'addon_connection.disconnected',
          entityType: 'addon_connection',
          entityId: input.connectionId,
          payload: {
            addonId: row?.addonId ?? null,
            connector: done.connector,
            provider: done.provider,
          },
          after: { connector: done.connector, service: done.provider },
        });
      }
      return { connectionId: input.connectionId, changed: done.changed };
    },
  });

  const health = defineCommand({
    name: 'addon_connection.health',
    description:
      'Worker: whether an add-on’s connection just worked. A failure counts; a refusal, or too many failures, says it isn’t working, and what it affects is shown.',
    risk: 0,
    input: AddonConnectionHealthInput,
    output: AddonConnectionHealthOutput,
    permission: null,
    actors: ['system'],
    scope: inWorkspace,
    emits: ['addon_connection.failing', 'addon_connection.working'],
    async handler(ctx, input) {
      const [c] = await ctx.tx
        .select()
        .from(addonConnections)
        .where(
          and(
            eq(addonConnections.id, input.connectionId),
            eq(addonConnections.workspaceId, input.workspaceId),
          ),
        )
        .for('update');
      // An add-on reports only on its own connections, never another's.
      if (c && ctx.addon && ctx.addon.id !== c.addonId)
        throw HfosError.notFound('That add-on has no connection by that id.');
      if (!c || c.status === 'disconnected')
        return { connectionId: input.connectionId, status: 'disconnected' as const };
      const at = new Date();
      const was = c.status;
      const failures = input.ok ? 0 : c.failures + 1;
      const status = input.ok
        ? ('active' as const)
        : input.refused
          ? ('reauth_required' as const)
          : failures >= CONNECTION_FAILURES_BEFORE_ERROR
            ? ('error' as const)
            : (c.status as 'active' | 'error' | 'reauth_required' | 'pending');
      await ctx.tx
        .update(addonConnections)
        .set(
          input.ok
            ? { status, failures: 0, failingSince: null, lastError: null, lastSuccessAt: at }
            : {
                status,
                failures,
                failingSince: c.failingSince ?? at,
                lastError: input.error ?? 'It didn’t answer.',
              },
        )
        .where(eq(addonConnections.id, c.id));
      const failing = (s: string) => s === 'error' || s === 'reauth_required';
      if (failing(status) !== failing(was))
        await ctx.emit({
          type: failing(status) ? 'addon_connection.failing' : 'addon_connection.working',
          entityType: 'addon_connection',
          entityId: c.id,
          payload: {
            addonId: c.addonId,
            connector: c.connector,
            provider: c.provider,
            status,
            ...(input.error ? { error: input.error } : {}),
          },
        });
      return { connectionId: c.id, status };
    },
  });

  const webhook = defineCommand({
    name: 'addon_connection.webhook',
    description:
      'Worker: give an add-on’s connection its own address for the service’s updates, replacing any it had. Only the address’s hash and the service’s sealed signing secret are kept.',
    risk: 1,
    input: AddonConnectionWebhookInput,
    output: AddonConnectionWebhookOutput,
    permission: null,
    actors: ['system'],
    scope: inWorkspace,
    emits: [],
    async handler(ctx, input) {
      const [c] = await ctx.tx
        .select({ id: addonConnections.id, addonId: addonConnections.addonId })
        .from(addonConnections)
        .where(
          and(
            eq(addonConnections.id, input.connectionId),
            eq(addonConnections.workspaceId, input.workspaceId),
            ne(addonConnections.status, 'disconnected'),
          ),
        )
        .for('update');
      // An add-on opens addresses only for its own connections.
      if (!c || (ctx.addon && ctx.addon.id !== c.addonId))
        throw HfosError.notFound('That add-on has no connection by that id.');
      await ctx.tx
        .update(addonConnections)
        .set({
          webhookTokenHash: Buffer.from(input.tokenHash, 'hex'),
          webhookSecretEnc: input.secretEnc,
        })
        .where(eq(addonConnections.id, c.id));
      return { connectionId: c.id };
    },
  });

  const platform = defineCommand({
    name: 'addon_connection.platform',
    description:
      'Staff: turn HandsFreeOS’s own account at a service on or off for one business’s add-on. A business that connects its own account uses that instead.',
    risk: 3,
    input: AddonConnectionPlatformInput,
    output: AddonConnectionPlatformOutput,
    permission: 'platform.addons.manage',
    scope: () => ({ kind: 'platform' as const }),
    emits: ['addon_connection.platform_changed'],
    async handler(ctx, input) {
      const { connector, provider } = connectorOf(
        catalog,
        input.addonId,
        input.connector,
        input.provider,
      );
      if (!provider.auth.includes('platform'))
        throw HfosError.rule(
          'addon_connector_auth',
          409,
          `HandsFreeOS has no account of its own at ${provider.label}. The business connects its own.`,
        );
      const [done] = await rows<{ connection_id: string | null; changed: boolean }>(
        ctx.tx,
        sql`select connection_id, changed from private.set_addon_platform_connection(
              ${input.workspaceId}::uuid, ${input.addonId}, ${input.connector}, ${input.provider},
              ${connector.permission}, ${`HandsFreeOS’s ${provider.label} account`}, ${input.on})`,
      );
      if (!done) throw HfosError.internal();
      if (done.changed)
        await ctx.emit({
          type: 'addon_connection.platform_changed',
          entityType: 'addon_connection',
          entityId: done.connection_id,
          payload: {
            workspaceId: input.workspaceId,
            addonId: input.addonId,
            connector: input.connector,
            provider: input.provider,
            on: input.on,
          },
          after: { addon: input.addonId, service: provider.label, on: input.on },
        });
      return { connectionId: done.connection_id, changed: done.changed };
    },
  });

  return { save, disconnect, health, webhook, platform };
}
