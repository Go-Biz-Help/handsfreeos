import type { paths } from '@hfos/api-client';
import { ADDON_CATALOG, coreFeatureHeld, type PartnerStatus } from '@hfos/core';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { useGrants } from '@/lib/grants';

/**
 * Partners from the phone (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d), as the web's screens make the same
 * calls: the business's partner settings, its partners, one partner, a customer's partner side, and the changes a
 * partner's page and a customer's Partner card make. None of it is in the phone's copy, and none of the changes waits
 * in the queue: each is for the partner as HandsFreeOS has them now.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type PartnersSettingsOut = Ok<'/v1/queries/partners.settings'>;
export type PartnerRow = Ok<'/v1/queries/partner.list'>['partners'][number];
export type PartnerGetOut = Ok<'/v1/queries/partner.get'>;
export type PartnerCommissionRow = PartnerGetOut['commissions'][number];
export type PartnerOfPersonOut = Ok<'/v1/queries/partner.of_person'>;
export type PartnerPayoutsOut = Ok<'/v1/queries/partner.payouts'>;

/** Who sees partners and changes them, as the commands check it. */
export const PARTNERS_MANAGE = 'partners.manage';

/** Whether this person works with partners here: they're on (an add-on that uses them runs) and they hold Manage partners. */
export function usePartnersHere(): boolean {
  const { permissions } = useGrants();
  const held = permissions ?? [];
  return coreFeatureHeld(ADDON_CATALOG, held, 'partners') && held.includes(PARTNERS_MANAGE);
}

export function partnerCalls(workspaceId: string) {
  return {
    settings: async (): Promise<PartnersSettingsOut> =>
      unwrap(await api.POST('/v1/queries/partners.settings', { body: { workspaceId } })),
    list: async (): Promise<PartnerRow[]> =>
      unwrap(await api.POST('/v1/queries/partner.list', { body: { workspaceId } })).partners,
    get: async (partnerId: string): Promise<PartnerGetOut> =>
      unwrap(await api.POST('/v1/queries/partner.get', { body: { workspaceId, partnerId } })),
    /** Paying partners (stage 3): the card, the next payout as it stands, and the latest payouts. To read. */
    payouts: async (): Promise<PartnerPayoutsOut> =>
      unwrap(await api.POST('/v1/queries/partner.payouts', { body: { workspaceId } })),
    ofPerson: async (personId: string): Promise<PartnerOfPersonOut> =>
      unwrap(await api.POST('/v1/queries/partner.of_person', { body: { workspaceId, personId } })),
    add: async (personId: string) =>
      unwrap(await api.POST('/v1/commands/partner.add', { body: { workspaceId, personId } })),
    update: async (
      partnerId: string,
      change: { readonly rateBp?: number | null; readonly status?: PartnerStatus },
    ) =>
      unwrap(
        await api.POST('/v1/commands/partner.update', {
          body: { workspaceId, partnerId, ...change },
        }),
      ),
    referralSet: async (personId: string, partnerId: string | null) =>
      unwrap(
        await api.POST('/v1/commands/partner.referral_set', {
          body: { workspaceId, personId, partnerId },
        }),
      ),
    /**
     * Where a partner's link lives: the business's own domain once it's serving, else HandsFreeOS's address, as the
     * web's screens show it. A failed look-up gives HandsFreeOS's: a link that works beats none.
     */
    origin: async (): Promise<string> => {
      try {
        const { domain } = unwrap(
          await api.POST('/v1/queries/branded_domain.get', { body: { workspaceId } }),
        );
        return domain && domain.status === 'verified' && domain.certificateReady
          ? `https://${domain.domain}`
          : config.webUrl;
      } catch {
        return config.webUrl;
      }
    },
    /** Lets them into the portal and emails them their page, or emails it again. */
    sendPage: async (personId: string) =>
      unwrap(
        await api.POST('/v1/commands/portal_access.give', { body: { workspaceId, personId } }),
      ),
  };
}
