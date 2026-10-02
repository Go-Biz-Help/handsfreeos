/**
 * An add-on's connections to other services (round five, 20261021000100): what the worker saves once a service
 * accepted a key or a sign-in, a person letting one go, staff turning HandsFreeOS's own account on, and what a screen
 * shows. Nothing here carries a secret in the clear: the worker seals it before a command sees it.
 */
import { z } from 'zod';
import { addonId } from './addon';
import { isoDateTime, uuid } from './common';

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Not a connector or service.');

export const AddonConnectionSaveInput = z.object({
  workspaceId: uuid,
  addonId,
  connector: slug,
  provider: slug,
  auth: z.enum(['key', 'oauth']),
  /** Who it is at the service, as people there would know it. */
  label: z.string().trim().min(1).max(200).nullable(),
  /** The service's own id for the account. */
  accountRef: z.string().trim().min(1).max(200).nullable(),
  /** What else is safe to show (the MLSs it covers). */
  details: z.record(z.string(), z.unknown()).default({}),
  secretEnc: z.string().min(1).max(20_000),
  keyId: z.string().min(1).max(100),
  tokenExpiresAt: isoDateTime.nullable().default(null),
  /** The person who connected it. */
  connectedBy: uuid,
});

export const AddonConnectionOutput = z.object({ connectionId: uuid });

export const AddonConnectionDisconnectInput = z.object({ workspaceId: uuid, connectionId: uuid });
export const AddonConnectionDisconnectOutput = z.object({
  connectionId: uuid,
  changed: z.boolean(),
});

export const AddonConnectionHealthInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  ok: z.boolean(),
  /** What went wrong, in words a person can act on. */
  error: z.string().trim().min(1).max(500).optional(),
  /** The service turned the key or sign-in down: it needs connecting again, not waiting. */
  refused: z.boolean().default(false),
});
export const AddonConnectionHealthOutput = z.object({
  connectionId: uuid,
  status: z.enum(['pending', 'active', 'reauth_required', 'error', 'disconnected']),
});

export const AddonConnectionPlatformInput = z.object({
  workspaceId: uuid,
  addonId,
  connector: slug,
  provider: slug,
  on: z.boolean(),
});
export const AddonConnectionPlatformOutput = z.object({
  connectionId: uuid.nullable(),
  changed: z.boolean(),
});

export const AddonConnectionListInput = z.object({ workspaceId: uuid, addonId });
const ConnectionOut = z.object({
  id: uuid,
  provider: z.string(),
  providerLabel: z.string(),
  auth: z.enum(['key', 'oauth', 'platform']),
  status: z.enum(['pending', 'active', 'reauth_required', 'error', 'disconnected']),
  label: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  lastSuccessAt: isoDateTime.nullable(),
  failingSince: isoDateTime.nullable(),
  failures: z.number().int(),
  lastError: z.string().nullable(),
  connectedAt: isoDateTime.nullable(),
  connectedByName: z.string().nullable(),
  /** The one the add-on uses now: its own account before HandsFreeOS's. */
  inUse: z.boolean(),
});
export const AddonConnectionListOutput = z.object({
  connectors: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      many: z.boolean(),
      /** The person may connect and let go of it. */
      canManage: z.boolean(),
      providers: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          auth: z.array(z.enum(['key', 'oauth', 'platform'])),
          fields: z.array(
            z.object({
              key: z.string(),
              label: z.string(),
              secret: z.boolean(),
              hint: z.string().nullable(),
            }),
          ),
        }),
      ),
      connections: z.array(ConnectionOut),
    }),
  ),
});
export type AddonConnectionList = z.infer<typeof AddonConnectionListOutput>;
