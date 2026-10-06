/**
 * What the onboarding setup starts from, read from the database (server only): the AI quick setup's state, and
 * each of the setup's own parts as the screen that owns it reads it (Getting started's facts for the number,
 * payments and customers), so the setup never disagrees with Settings, Calendars or Home. Read as the person asking,
 * under row-level security.
 */
import { eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { loadAiSetupState } from '../ai-setup/load';
import { WeeklyHours } from '../calendar/config';
import { loadOnboardingFacts } from '../onboarding/load';
import { businessOnboardingOf } from '../onboarding/settings';
import { businessAddressOf } from './address';
import type { OnboardingSetupState } from './state';

/** The business as the onboarding setup sees it, for the person setting it up. */
export async function loadOnboardingSetupState(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<OnboardingSetupState> {
  const ai = await loadAiSetupState(tx, workspaceId);
  const [ws] = await tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const settings = (ws?.settings ?? {}) as Record<string, unknown>;
  const facts = await loadOnboardingFacts(tx, workspaceId, userId, 'business');
  const b = facts.business!;
  const business = businessOnboardingOf(settings);

  const [site] = await rows<{ slug: string; name: string; enabled: boolean }>(
    tx,
    sql`select slug::text as slug, name, enabled from app.booking_sites where workspace_id = ${workspaceId}`,
  );
  const invited = await rows<{ email: string }>(
    tx,
    sql`select email::text as email from app.invitations
        where workspace_id = ${workspaceId} and accepted_at is null and revoked_at is null and expires_at > now()
        order by created_at`,
  );
  const bookable = await rows<{
    id: string;
    name: string;
    minutes: number;
    priceCents: number | null;
  }>(
    tx,
    sql`select id, name, default_duration as minutes, price_cents as "priceCents" from app.services
        where workspace_id = ${workspaceId} and archived_at is null order by name`,
  );
  const priceList = await rows<{
    id: string;
    name: string;
    priceCents: number | string;
    serviceId: string | null;
  }>(
    tx,
    sql`select id, name, unit_price_cents as "priceCents", service_id as "serviceId" from app.products
        where workspace_id = ${workspaceId} and archived_at is null order by name`,
  );
  const [mine] = await rows<{ weekly: unknown }>(
    tx,
    sql`select weekly from app.schedules
        where workspace_id = ${workspaceId} and owner_kind = 'user' and owner_id = ${userId} limit 1`,
  );
  const myHours = mine ? WeeklyHours.safeParse(mine.weekly) : null;
  const links = settings['links'];
  const review =
    links && typeof links === 'object' && !Array.isArray(links)
      ? (links as Record<string, unknown>)['review']
      : null;

  return {
    ...ai,
    quick: business.answers,
    address: businessAddressOf(settings),
    reviewLink: typeof review === 'string' && review.trim() ? review : null,
    numberSetup: b.number,
    payments: b.payments,
    customers: {
      count: b.customers.count,
      running: b.customers.running,
      migrationNeedsYou: b.customers.migrationNeedsYou,
      asYouGo: !!business.customersAsYouGo,
    },
    booking: {
      on: b.calendar.bookingOn,
      site: site ? { slug: site.slug, name: site.name, enabled: site.enabled } : null,
    },
    team: { members: b.team.members, invited: invited.map((i) => i.email) },
    bookable,
    priceList: priceList.map((p) => ({ ...p, priceCents: Number(p.priceCents) })),
    myHours: myHours?.success ? myHours.data : null,
    phones: facts.person.phones,
  };
}
