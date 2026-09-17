/**
 * What makes a record over there the same as a record here, forever.
 *
 * Six parts, and every one of them earns its place:
 *   workspace       — a business never sees another business's mapping, whatever a job does wrong.
 *   source system   — GoHighLevel's id 42 is not HubSpot's id 42.
 *   installation    — the same agency connected twice is two installations; ids may well collide.
 *   location        — Chris allowed two sub-accounts to land in one business, so the sub-account has to be
 *                     part of the key. Both copies keep their own mapping, and both may point at one person
 *                     here. That is what a merge is.
 *   object type     — a contact 42 and an invoice 42 are different things.
 *   object id       — the source's own id.
 *
 * Reading the same page twice, retrying a batch, replaying a webhook and a catch-up sync months later all come
 * down to the same insert against this key. Everything the milestone promises about never duplicating rests
 * here.
 */

export interface SourceIdentity {
  readonly workspaceId: string;
  readonly sourceSystem: string;
  readonly installationId: string;
  readonly sourceLocationId: string;
  readonly sourceObjectType: string;
  readonly sourceObjectId: string;
}

/** A stable string for logs, dedupe keys and job inputs. Never used as a database key; the index is. */
export function identityKey(i: SourceIdentity): string {
  return [
    i.workspaceId,
    i.sourceSystem,
    i.installationId,
    i.sourceLocationId,
    i.sourceObjectType,
    i.sourceObjectId,
  ].join('/');
}

/**
 * A message with no id of its own gets a fingerprint instead — conservative on purpose: everything that could
 * tell two real messages apart is in it, so the cost of being wrong is a duplicate rather than a lost message.
 * Two messages a second apart, or with one character different, produce different fingerprints.
 */
export interface MessageFingerprintParts {
  readonly locationId: string;
  readonly conversationId: string;
  readonly channel: string;
  readonly direction: string;
  readonly participants: readonly string[];
  readonly sentAt: string;
  readonly bodyHash: string;
  readonly attachmentHashes?: readonly string[];
}

export function messageFingerprint(p: MessageFingerprintParts): string {
  return [
    p.locationId,
    p.conversationId,
    p.channel,
    p.direction,
    [...p.participants].sort().join(','),
    p.sentAt,
    p.bodyHash,
    [...(p.attachmentHashes ?? [])].sort().join(','),
  ].join('|');
}
