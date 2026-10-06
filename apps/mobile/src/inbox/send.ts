import type { RichInput } from '@hfos/core';

import { change, changes, newId } from '@/changes';
import { removePhoto, takePhoto, type KeptPhoto, type PhotoSource } from '@/changes/photo-device';

/**
 * Replying from the phone: a text, an email, a website chat reply, a reply in a client's portal (round six) or on
 * Messenger or Instagram (20261025000200), through `change('message.send')` like every change. Photos go first on
 * their own track to the customer's files (`changes.addPhoto`), and the reply waits for them (a chat or portal reply
 * carries none); a reply written with no signal goes on its own within 30 minutes, or asks "Still send?".
 */

export interface TrayPhoto extends KeptPhoto {
  /** The file id the phone made: the customer file it becomes, and what the reply attaches. */
  readonly fileId: string;
}

export type TakeResult =
  | { readonly kind: 'kept'; readonly photo: TrayPhoto }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-camera-permission' };

/** Takes or picks a photo for a reply: shrunk and kept on the phone until it's sent (or taken off the tray). */
export async function takeReplyPhoto(userId: string, source: PhotoSource): Promise<TakeResult> {
  const fileId = newId();
  const taken = await takePhoto({ userId, source, fileId });
  if (taken.kind !== 'kept') return taken;
  return { kind: 'kept', photo: { ...taken.photo, fileId } };
}

/** A photo taken off the tray before the reply went: its file goes. */
export function dropReplyPhoto(userId: string, photo: TrayPhoto): void {
  removePhoto(userId, photo.localName);
}

/** The answer to quiet hours before a text goes: ask (the default), send now anyway, or when quiet hours end. */
export type QuietChoice = 'ask' | 'now' | 'later';

export interface Reply {
  readonly workspaceId: string;
  /** The conversation it answers; a reply on the customer's other channel goes to them instead (`personId`). */
  readonly conversationId: string | null;
  readonly personId: string | null;
  /**
   * A portal reply goes back to the client's portal, where they wrote (`channel: 'portal'`, as the web sends it), and
   * a Messenger or Instagram reply to their inbox there.
   */
  readonly channel: 'sms' | 'email' | 'chat' | 'portal' | 'messenger' | 'instagram';
  readonly body: string;
  readonly subject?: string | null;
  readonly photos: readonly TrayPhoto[];
  readonly quiet: Exclude<QuietChoice, 'ask'> | null;
  /** Email: the business's address it goes from, when the person picked one. */
  readonly emailAddressId?: string | null;
  /** A text's buttons, card or carousel (RCS, 0103): core's `checkRich` value, as message.send takes it. */
  readonly rich?: RichInput | null;
  /**
   * A carousel's pictures, one per card. They go to the customer's files first, like photos, but ride on their
   * cards (`mediaFileId`) rather than on the message.
   */
  readonly cardPhotos?: readonly TrayPhoto[];
}

/**
 * Sends a reply: its photos (and a carousel's pictures) to the customer's files first, then the message, waiting for
 * them. Returns the reply's change id and its client id (what the server's copy of the message carries, so the
 * thread can match it).
 */
export async function sendReply(reply: Reply): Promise<{ id: string; clientId: string }> {
  const photoChanges: string[] = [];
  const uploads = [...reply.photos, ...(reply.cardPhotos ?? [])];
  if (uploads.length > 0) {
    if (!reply.personId) throw new Error('Add them as a customer to send photos.');
    for (const photo of uploads) {
      const added = await changes.addPhoto(
        { workspaceId: reply.workspaceId, recordType: 'person', recordId: reply.personId },
        photo,
        { fileId: photo.fileId },
      );
      photoChanges.push(added.id);
    }
  }
  const clientId = newId();
  const target = reply.conversationId
    ? { conversationId: reply.conversationId }
    : { personId: reply.personId! };
  const result = await change(
    'message.send',
    {
      workspaceId: reply.workspaceId,
      ...target,
      channel: reply.channel,
      body: reply.body,
      ...(reply.channel === 'email' && reply.subject ? { subject: reply.subject } : {}),
      ...(reply.channel === 'email' && reply.emailAddressId
        ? { emailAddressId: reply.emailAddressId }
        : {}),
      attachmentFileIds: reply.photos.map((p) => p.fileId),
      ...(reply.channel === 'sms' && reply.rich ? { rich: reply.rich } : {}),
      clientId,
      ...(reply.quiet === 'later'
        ? { sendAfterQuietHours: true }
        : reply.quiet === 'now'
          ? { acknowledgeQuietHours: true }
          : {}),
    },
    { dependsOn: photoChanges },
  );
  return { id: result.id, clientId };
}
