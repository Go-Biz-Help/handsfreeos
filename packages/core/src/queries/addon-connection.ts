/**
 * An add-on's connections as its Connections screen shows them (round five, 20261021000100): each thing its manifest
 * connects, the services it can use, and the business's connections with their health. Rows come only to the people
 * who may manage them (row security); never a secret.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { addonConnections } from '@hfos/db/schema';
import { findAddon, type Catalog } from '../addons/graph';
import { HfosError } from '../errors';
import { scopeCan } from '../kernel/execute';
import { defineQuery } from '../kernel/define';
import type { Permission } from '../permissions';
import { AddonConnectionListInput, AddonConnectionListOutput } from '../schemas/addon-connection';

type Auth = 'key' | 'oauth' | 'platform';
type Status = 'pending' | 'active' | 'reauth_required' | 'error' | 'disconnected';

export function addonConnectionQueries(catalog: Catalog) {
  const list = defineQuery({
    name: 'addon_connection.list',
    description:
      'What an add-on connects to: each service it can use, and the business’s accounts there with whether they work.',
    input: AddonConnectionListInput,
    output: AddonConnectionListOutput,
    permission: 'workspace.read',
    scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
    async handler(ctx, input) {
      const m = findAddon(catalog, input.addonId);
      if (!m) throw HfosError.notFound('HandsFreeOS has no add-on by that name.');
      // Only the columns people may read: a sealed one is refused even to an owner.
      const connected = await ctx.tx
        .select({
          id: addonConnections.id,
          connector: addonConnections.connector,
          provider: addonConnections.provider,
          auth: addonConnections.auth,
          status: addonConnections.status,
          label: addonConnections.label,
          details: addonConnections.details,
          lastSuccessAt: addonConnections.lastSuccessAt,
          failingSince: addonConnections.failingSince,
          failures: addonConnections.failures,
          lastError: addonConnections.lastError,
          connectedBy: addonConnections.connectedBy,
          connectedAt: addonConnections.connectedAt,
        })
        .from(addonConnections)
        .where(
          and(
            eq(addonConnections.workspaceId, input.workspaceId),
            eq(addonConnections.addonId, input.addonId),
          ),
        );
      const live = connected.filter((c) => c.status !== 'disconnected');
      const people = [...new Set(live.map((c) => c.connectedBy).filter((x): x is string => !!x))];
      const names = new Map(
        people.length
          ? (
              await rows<{ id: string; name: string }>(
                ctx.tx,
                sql`select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name from app.users u
                    where u.id = any(${`{${people.join(',')}}`}::uuid[])`,
              )
            ).map((u) => [u.id, u.name])
          : [],
      );
      const iso = (d: Date | null) => d?.toISOString() ?? null;
      return {
        connectors: (m.connectors ?? []).map((c) => {
          const mine = live
            .filter((x) => x.connector === c.key)
            // Its own accounts first, then HandsFreeOS's; the newest of its own is the one in use.
            .sort(
              (a, b) =>
                Number(a.auth === 'platform') - Number(b.auth === 'platform') ||
                (b.connectedAt?.getTime() ?? 0) - (a.connectedAt?.getTime() ?? 0),
            );
          return {
            key: c.key,
            label: c.label,
            many: !!c.many,
            canManage: scopeCan(ctx.scope, c.permission as Permission),
            providers: c.providers.map((p) => ({
              id: p.id,
              label: p.label,
              auth: [...p.auth],
              fields: (p.fields ?? []).map((f) => ({
                key: f.key,
                label: f.label,
                secret: f.secret,
                hint: f.hint ?? null,
              })),
            })),
            connections: mine.map((x, i) => ({
              id: x.id,
              provider: x.provider,
              providerLabel: c.providers.find((p) => p.id === x.provider)?.label ?? x.provider,
              auth: x.auth as Auth,
              status: x.status as Status,
              label: x.label,
              details: (x.details ?? {}) as Record<string, unknown>,
              lastSuccessAt: iso(x.lastSuccessAt),
              failingSince: iso(x.failingSince),
              failures: x.failures,
              lastError: x.lastError,
              connectedAt: iso(x.connectedAt),
              connectedByName: x.connectedBy ? (names.get(x.connectedBy) ?? null) : null,
              inUse: c.many ? x.status === 'active' : i === 0,
            })),
          };
        }),
      };
    },
  });
  return { list };
}
