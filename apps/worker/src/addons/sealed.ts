/**
 * Sealing an add-on's values (round seven): only the worker's key seals or opens them. What's sealed names the
 * business, add-on and value it's for, so a sealed lockbox code copied onto another listing, or into another
 * business, never opens there.
 */
import { isSealed, SEALED_PREFIX, type SealedContents } from '@hfos/core';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { Sealer } from '../crypto';

export interface SealedFor {
  readonly workspaceId: string;
  readonly addonId: string;
  readonly key: string;
}

/** A sealed value that won't open here: not sealed, sealed by a key the worker doesn't have, or sealed for elsewhere. */
export class SealedMismatch extends Error {}

export function sealFor(sealer: Sealer, at: SealedFor, value: string): string {
  const contents: SealedContents = { v: value, w: at.workspaceId, a: at.addonId, k: at.key };
  return `${SEALED_PREFIX}${sealer.seal(JSON.stringify(contents))}`;
}

export function openSealed(sealer: Sealer, sealed: string, at: SealedFor): string {
  if (!isSealed(sealed)) throw new SealedMismatch('This isn’t a sealed value.');
  let contents: SealedContents;
  try {
    contents = JSON.parse(sealer.open(sealed.slice(SEALED_PREFIX.length))) as SealedContents;
  } catch (e) {
    throw new SealedMismatch(e instanceof Error ? e.message : 'It didn’t open.');
  }
  if (contents.w !== at.workspaceId || contents.a !== at.addonId || contents.k !== at.key)
    throw new SealedMismatch('It was sealed for something else.');
  return contents.v;
}

/**
 * An email's body with its sealed parts in place (`app.message_sealed_parts`), for the provider only: the stored
 * body keeps the markers. Throws SealedMismatch, and the email doesn't go, when one won't open.
 */
export async function withSealedParts(
  tx: Tx,
  sealer: Sealer,
  workspaceId: string,
  messageId: string,
  body: string,
): Promise<{ readonly body: string; readonly labels: readonly string[] }> {
  const parts = await rows<{ marker: string; value_enc: string; addon_id: string; key: string }>(
    tx,
    sql`select marker, value_enc, addon_id, key from app.message_sealed_parts
        where message_id = ${messageId}::uuid and workspace_id = ${workspaceId}::uuid order by position`,
  );
  let out = body;
  for (const p of parts) {
    const value = openSealed(sealer, p.value_enc, { workspaceId, addonId: p.addon_id, key: p.key });
    out = out.split(p.marker).join(value);
  }
  return { body: out, labels: parts.map((p) => p.marker) };
}
