import {
  businessAddressOf,
  businessPageService,
  businessPageServicesTitle,
  cityAndState,
  consentPolicyPath,
  consentTermsPath,
  defaultNumber,
  emptyKnowledgeProfile,
  KnowledgeProfile,
  loadRegistrations,
  readiness,
  WeeklyHours,
  type BusinessPageParts,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { knowledgeProfiles, workspaces } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';

/**
 * The business's simple page (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "A simple page"): what
 * the public booking page adds while it's on, all from what the business already keeps. Knowledge → Business profile
 * says what it does, its services and where it works; Settings → Workspace has its open hours and address; the
 * privacy policy and terms are the ones its agreement boxes link to. Text shows only once the carriers have approved
 * texting, and Chat only when its website chat is set up for the address the page is shown at.
 */
export type PublicBusinessPage = BusinessPageParts;

/** An origin as a browser sends one: https://host[:port], or http on your own computer. Anything else is ignored. */
const ORIGIN_RE =
  /^(?:https:\/\/[a-z0-9.-]{1,253}|http:\/\/(?:localhost|127\.0\.0\.1))(?::\d{1,5})?$/;

export async function businessPageOf(
  tx: Tx,
  workspaceId: string,
  slug: string,
  origin: string | null | undefined,
): Promise<PublicBusinessPage> {
  const [w] = await tx
    .select({ industry: workspaces.industry, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const settings = (w?.settings ?? {}) as Record<string, unknown>;
  const [row] = await tx
    .select({ profile: knowledgeProfiles.profile, allowPrices: knowledgeProfiles.allowPrices })
    .from(knowledgeProfiles)
    .where(eq(knowledgeProfiles.workspaceId, workspaceId));
  const stored = row ? KnowledgeProfile.safeParse(row.profile) : null;
  const profile = stored?.success ? stored.data : emptyKnowledgeProfile();
  const allowPrices = row?.allowPrices ?? false;
  const openHours = WeeklyHours.safeParse(settings['openHours']);
  const address = businessAddressOf(settings);

  const number = await defaultNumber(tx, workspaceId);
  const texts = readiness(number, await loadRegistrations(tx, workspaceId)).messagingReady;

  const asked = origin?.toLowerCase() ?? '';
  const [chat] = ORIGIN_RE.test(asked)
    ? await rows<{ key: string }>(
        tx,
        sql`select public_key as key from app.chat_widgets
            where workspace_id = ${workspaceId} and paused_at is null and ${asked} = any(allowed_origins)
            order by created_at limit 1`,
      )
    : [];

  return {
    description: profile.description,
    servicesTitle: businessPageServicesTitle(w?.industry),
    services: profile.services.map((s) => businessPageService(s, allowPrices)),
    area: profile.serviceArea,
    place: address ? cityAndState(address) : null,
    openHours: openHours.success ? openHours.data : null,
    hours: profile.hours,
    privacyPath: consentPolicyPath(slug),
    termsPath: consentTermsPath(slug),
    textTo: texts && number ? number.e164 : null,
    chat: chat?.key ?? null,
  };
}
