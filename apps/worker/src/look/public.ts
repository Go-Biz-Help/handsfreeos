import { emailColorOf, emailContactOf, logoUrlFor, lookKitOf, lookOf } from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { EmailBrand } from '../email/render';

/**
 * A business's logo, colour and brand kit as its customers see them (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §4): on its booking page, website chat and invoices (the worker's public routes), and at the top of the emails
 * HandsFreeOS sends for it.
 */
export interface PublicLook {
  /** Its logo, where anyone can see it; null when it has none, and the page shows its name instead. */
  readonly logo: { readonly url: string; readonly width: number; readonly height: number } | null;
  /** Its colour as #rrggbb; null for HandsFreeOS's own. */
  readonly color: string | null;
  /** Its brand kit's font, a Google font's name; null for HandsFreeOS's own. */
  readonly font: string | null;
  /** Its brand kit's corners; null for slight. */
  readonly corners: 'square' | 'slight' | 'round' | null;
}

export const NO_PUBLIC_LOOK: PublicLook = { logo: null, color: null, font: null, corners: null };

/** The look from a business's settings, its logo at Storage's public address (none without that address). */
export function publicLookOf(settings: unknown, storageUrl: string | null | undefined): PublicLook {
  const look = lookOf(settings);
  return {
    logo:
      look.logo && storageUrl
        ? {
            url: logoUrlFor(storageUrl, look.logo.path),
            width: look.logo.width,
            height: look.logo.height,
          }
        : null,
    color: look.color?.hex ?? null,
    ...lookKitOf(look),
  };
}

/** How big a logo is drawn at the top of an email (core's look/email.ts). */
export { emailLogoSize } from '@hfos/core';

/** The colour a business's links are in its emails: its own, dark enough to read on white. */
export const emailLinkColor = (look: PublicLook): string | null => emailColorOf(look.color);

/**
 * The look of an email HandsFreeOS sends for the business automatically: nobody wrote it
 * there and then (a confirmation, a reminder, an invoice, a campaign). Emails a person or the AI teammate wrote
 * in a conversation go plain, as people's own emails do.
 */
export async function emailBrandFor(
  tx: Tx,
  storageUrl: string | null | undefined,
  m: {
    readonly workspaceId: string;
    readonly sentBy: string | null;
    readonly sentByTeammateId: string | null;
  },
): Promise<EmailBrand | null> {
  if (m.sentBy || m.sentByTeammateId) return null;
  const [w] = await tx
    .select({ name: workspaces.name, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, m.workspaceId));
  if (!w) return null;
  // How its emails look (Settings → Email); the footer's details are looked up only when it shows one.
  const layout = lookOf(w.settings).email;
  return {
    name: w.name,
    look: publicLookOf(w.settings, storageUrl),
    layout: layout ? { band: layout.band, logo: layout.logo, footer: layout.footer } : null,
    contact: layout?.footer ? await emailContactOf(tx, m.workspaceId, w.settings) : null,
  };
}
