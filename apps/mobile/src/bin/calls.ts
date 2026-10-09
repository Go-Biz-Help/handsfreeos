import type { paths } from '@hfos/api-client';
import type { BinKind } from '@hfos/core';

import { api, unwrap } from '@/lib/api';

/**
 * Deleting for good from the phone (the Deleted bin, 20261027000400), as the web's delete box does it: first what goes
 * with it, then into the bin. Both need signal, so neither goes into the queue of changes: the box says what goes
 * from what HandsFreeOS has now, not from this phone's copy, and nothing is deleted later behind the owner's back.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type BinPreviewItem = Ok<'/v1/queries/bin.preview'>['items'][number];

/** What goes with each, and which can't go yet and why (`rule` and `message`). */
export async function previewBin(
  workspaceId: string,
  kind: BinKind,
  ids: readonly string[],
): Promise<BinPreviewItem[]> {
  return unwrap(
    await api.POST('/v1/queries/bin.preview', { body: { workspaceId, kind, ids: [...ids] } }),
  ).items;
}

/** Into the bin. A booking still to come is cancelled first, telling its customers when `notify` says so. */
export async function putInBin(
  workspaceId: string,
  kind: BinKind,
  ids: readonly string[],
  notify: boolean,
): Promise<void> {
  if (kind === 'appointment') {
    for (const appointmentId of ids)
      unwrap(
        await api.POST('/v1/commands/appointment.delete', {
          body: { workspaceId, appointmentId, notify },
        }),
      );
    return;
  }
  const list = [...ids];
  switch (kind) {
    case 'person':
      unwrap(
        await api.POST('/v1/commands/person.delete', { body: { workspaceId, personIds: list } }),
      );
      return;
    case 'conversation':
      unwrap(
        await api.POST('/v1/commands/conversation.delete', {
          body: { workspaceId, conversationIds: list },
        }),
      );
      return;
    case 'lead':
      unwrap(await api.POST('/v1/commands/lead.delete', { body: { workspaceId, leadIds: list } }));
      return;
    case 'company':
      unwrap(
        await api.POST('/v1/commands/company.delete', { body: { workspaceId, companyIds: list } }),
      );
      return;
    case 'custom_record':
      unwrap(
        await api.POST('/v1/commands/custom_record.delete', {
          body: { workspaceId, customRecordIds: list },
        }),
      );
      return;
  }
}
