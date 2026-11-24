import { businessAddressOf, can, PHONE_SETUP_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PhoneSetupFlow } from '@/components/phone-setup/phone-setup-flow';
import { apiServer, getMe, getSetupWorkspace, getWorkspace, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: PHONE_SETUP_WORDS.startCard.title };

/**
 * The guided phone number setup (the owner, 22 Nov 2026): one question at a time on a page of its own, opened from
 * Settings → Texting & calls. A business with no number is asked everything, and gets its number on the last screen;
 * one that has its number is asked only what the number does ("Run the guided setup again"). The answers are saved as
 * they are given, so this page opens where they left off. Only someone who can change the business's channels comes
 * here; anyone else goes Home.
 */
export default async function PhoneSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const home = `/app/w/${workspaceId}`;
  const { api, email } = await apiServer();
  // The person's own business, or one the founder is working in as its owner.
  const mine = await getSetupWorkspace(workspaceId);
  if (!mine) notFound();
  if (!can(mine.ws.permissions, 'channels.manage')) redirect(home);
  const [got, status, draft, me] = await Promise.all([
    getWorkspace(workspaceId),
    api.POST('/v1/queries/phone.setup_status', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'phone' } })
      .then(unwrapPage),
    getMe(),
  ]);
  const address = businessAddressOf((got.workspace.settings ?? {}) as Record<string, unknown>);
  const firstName = me.user.fullName.trim().split(/\s+/)[0] || null;
  return (
    <PhoneSetupFlow
      workspaceId={workspaceId}
      businessName={got.workspace.name}
      email={email}
      firstName={firstName}
      near={address ? { city: address.city, state: address.state } : null}
      status={status}
      draft={{ answers: draft.answers, savedAt: draft.savedAt }}
      done={(await searchParams)['done'] === '1'}
    />
  );
}
