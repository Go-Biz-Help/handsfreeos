import { z } from 'zod';
import { isoDateTime, uuid, workspaceRole } from './common';

/**
 * Viewing the app as a teammate (20261016000200): read-only, until you stop. A request names its view in the
 * `x-hfos-view-as` header, and the API reads the business as the teammate while the view holds.
 */

/** The header a request names its view in. The web keeps the view in a cookie of the same name. */
export const VIEW_AS_HEADER = 'x-hfos-view-as';

/**
 * Who opened it: someone in the business (`team`, written in its audit log), HandsFreeOS support inside a look (told
 * to the business as the look is), or the founder inside their session as its owner (not told).
 */
export const teammateViewBy = z.enum(['team', 'support', 'founder']);
export type TeammateViewBy = z.infer<typeof teammateViewBy>;

export const TeammateViewPerson = z.object({
  userId: uuid,
  fullName: z.string(),
  email: z.string(),
  role: workspaceRole,
});
export type TeammateViewPerson = z.infer<typeof TeammateViewPerson>;

export const TeammateViewSession = z.object({
  id: uuid,
  workspaceId: uuid,
  person: TeammateViewPerson,
  by: teammateViewBy,
  startedAt: isoDateTime,
});
export type TeammateViewSession = z.infer<typeof TeammateViewSession>;

export const TeammateViewStartInput = z.object({ workspaceId: uuid, userId: uuid });
export const TeammateViewStartOutput = z.object({ view: TeammateViewSession });

/** The view to end, or the one open in a business; with neither, every view still open. */
export const TeammateViewEndInput = z.object({
  viewId: uuid.optional(),
  workspaceId: uuid.optional(),
});
export const TeammateViewEndOutput = z.object({ ended: z.number().int().nonnegative() });

export const TeammateViewCurrentInput = z.object({ workspaceId: uuid });
/** The view open in this business, while it still holds; null when there's none. */
export const TeammateViewCurrentOutput = z.object({ view: TeammateViewSession.nullable() });

/**
 * What the phone needs to show its copy of the business as the teammate sees it, read through the view: their role
 * and permissions, and the threads and bills they'd see where that's fewer than the viewer's copy holds.
 */
export const TeammateViewLensInput = z.object({ workspaceId: uuid });
export const TeammateViewLensOutput = z.object({
  person: TeammateViewPerson.extend({ permissions: z.array(z.string()) }),
  /** Every thread they see, when the business shows them only their own; null when they see the whole inbox. */
  conversationIds: z.array(uuid).nullable(),
  /** The Action Center's items they see, on the same terms as their threads; null when they see them all. */
  attentionItemIds: z.array(uuid).nullable(),
  /** The estimates and invoices they see, when they don't manage the money; null when they see all of it. */
  estimateIds: z.array(uuid).nullable(),
  invoiceIds: z.array(uuid).nullable(),
});
export type TeammateViewLens = z.infer<typeof TeammateViewLensOutput>;
