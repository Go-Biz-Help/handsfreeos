import { can, GUIDE_WORDS, QUESTION_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Brand } from '@/components/ui/brand';
import { apiServer, getMe } from '@/lib/api/server';
import { setupHref } from '@/lib/setup';
import { QuestionsForm } from './questions-form';

export const metadata: Metadata = { title: QUESTION_WORDS.title };

/**
 * The quick questions (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, board 1 in design/onboarding): straight
 * after Create business, then the setup wizard, answered or skipped; and from the Getting started card for a
 * business that never answered them, then back to Home. Only someone who sets the business up answers them; anyone
 * else goes to Home.
 */
export default async function QuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const fromGuide = (await searchParams)['from'] === 'guide';
  const { api, email } = await apiServer();
  const me = await getMe();
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  if (!ws) notFound();
  if (!can(ws.permissions, 'workspace.update')) redirect(`/app/w/${workspaceId}`);
  // What was answered before, to change it. A nicety: the questions work without it.
  const status = await api
    .POST('/v1/queries/onboarding.status', { body: { workspaceId } })
    .then((r) => r.data ?? null)
    .catch(() => null);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10 sm:px-6 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <QuestionsForm
        workspaceId={workspaceId}
        overline={fromGuide ? GUIDE_WORDS.title : 'Step 2 of 3'}
        next={fromGuide ? `/app/w/${workspaceId}` : setupHref(workspaceId, 'number')}
        initial={{ answers: status?.answers ?? null, website: status?.website ?? null }}
      />
      <p className="text-[13px] text-text-3">
        {ws.name} · Signed in as {email}
      </p>
    </div>
  );
}
