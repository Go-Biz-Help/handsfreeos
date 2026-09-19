import { eq } from 'drizzle-orm';
import { bookingSites, workspaces } from '@hfos/db/schema';
import type { Tx } from '@hfos/db/client';
import { slugify } from '../slug';

/**
 * The name a business's public pages live under: `/book/<site>` and `/f/<site>/<form>` are both built from it.
 *
 * It arrived with the calendar, so only Settings → Booking site ever created one — and a business that published a
 * form without ever setting up a booking page had no public address at all. The Share tab rendered its headings with
 * nothing under them, `private.form_route` found no workspace, and the Assistant and workflows quietly skipped
 * sending the link (step 1, finding: "published a form and there is no link and no QR code").
 *
 * So publishing anything public gives the business a name if it hasn't got one. It is the workspace's own name,
 * which is what somebody would have typed anyway, and it can be changed afterwards in Settings — renaming retires
 * the old slug the way a calendar's does.
 */

/** Names the booking pages already use, mirroring `private.booking_slug_reserved`. */
const RESERVED = new Set(['manage', 'c', 'api', 'app', 'admin', 'www', 'book', 'help', 'support']);

/** A slug the `booking_sites` check constraint accepts: lowercase, 1–64, no leading or trailing dash. */
export function siteSlugFrom(name: string): string {
  const base = slugify(name)
    .slice(0, 56)
    .replace(/^-+|-+$/g, '');
  return !base || RESERVED.has(base) ? `${base || 'business'}-hq` : base;
}

/**
 * The workspace's booking site, made from its name if it hasn't got one yet. A slug someone else holds gets a
 * number after it: the name is unique across HandsFreeOS, and two businesses called the same thing is ordinary.
 * Never changes a site that already exists.
 */
export async function ensureBookingSite(
  tx: Tx,
  workspaceId: string,
  createdBy: string | null,
): Promise<{ id: string; slug: string }> {
  const [existing] = await tx
    .select({ id: bookingSites.id, slug: bookingSites.slug })
    .from(bookingSites)
    .where(eq(bookingSites.workspaceId, workspaceId));
  if (existing) return { id: existing.id, slug: String(existing.slug) };

  const [ws] = await tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const name = ws?.name?.trim() || 'Business';
  const wanted = siteSlugFrom(name);

  // A handful of tries rather than a loop without end: past that, something else is wrong.
  for (let attempt = 0; attempt < 25; attempt++) {
    const slug = attempt === 0 ? wanted : `${wanted.slice(0, 58)}-${attempt + 1}`;
    const [taken] = await tx
      .select({ id: bookingSites.id })
      .from(bookingSites)
      .where(eq(bookingSites.slug, slug));
    if (taken) continue;
    const [row] = await tx
      .insert(bookingSites)
      // Not enabled: this names the business's pages, it does not put its calendars up for booking. The booking
      // site's own screen turns that on, and a form's page never reads it.
      .values({ workspaceId, slug, name, enabled: false, createdBy })
      .returning({ id: bookingSites.id });
    if (row) return { id: row.id, slug };
  }
  throw new Error(`could not find a free link name for workspace ${workspaceId}`);
}
