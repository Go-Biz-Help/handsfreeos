import { ADDON_CATALOG, can, coreFeatureRunning, OFFER_STEPS, type OfferStep } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OfferBuilder } from '@/components/main-offer/builder';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Build your main offer' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * The main offer's builder (docs/main-offer.md), a page of its own over the app like the onboarding: a step at a
 * time, `?step=` opening one. A draft opens where it is; with none, it starts from the live version, or from nothing.
 */
export default async function MainOfferBuildPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const asked = one((await searchParams).step);
  const { api } = await apiServer();
  const [{ workspace }, me] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    getMe(),
  ]);
  if (
    !coreFeatureRunning(ADDON_CATALOG, workspace.addons, 'main_offer') ||
    !can(workspace.permissions, 'main_offer.manage')
  )
    notFound();
  const offer = unwrapPage(await api.POST('/v1/queries/main_offer.get', { body: { workspaceId } }));
  // A first offer starts at the niche; changing a live one opens on Who, past the niche it was built from.
  const startAt: OfferStep = (OFFER_STEPS as readonly string[]).includes(asked ?? '')
    ? (asked as OfferStep)
    : offer.live && !offer.draft
      ? 'who'
      : 'niche';
  return (
    <OfferBuilder
      workspaceId={workspaceId}
      businessName={workspace.name}
      email={me.user.email}
      industry={workspace.industry}
      offer={offer}
      startAt={startAt}
    />
  );
}
