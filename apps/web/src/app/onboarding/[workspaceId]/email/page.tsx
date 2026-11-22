import { can, EMAIL_SETUP_WORDS, EmailSetupGetOutput } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { EmailGuidedFlow } from '@/components/email-setup/guided-flow';
import { apiServer, getSetupWorkspace, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: EMAIL_SETUP_WORDS.homeStartTitle };

/**
 * The guided email setup (the owner, 22 Nov 2026): one question at a time on a page of its own, opened from Home's
 * "Set up your business email" and from Settings → Email (`?from=settings`, so Finish later goes back there). The
 * answers are saved as they are given, so this page opens where they left off; nothing changes until Set it up.
 * A business whose website name still has its last step open lands on it (`?at=records` asks for it by name), and
 * `?done=1` is the Done screen. Only someone who can change the business's email comes here; anyone else goes Home.
 */
export default async function EmailSetupPage({
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
  const { ws } = mine;
  if (!can(ws.permissions, 'channels.manage')) redirect(home);
  const [got, draft] = await Promise.all([
    api
      .POST('/v1/queries/email_setup.get', { body: { workspaceId } })
      .then((r) => EmailSetupGetOutput.parse(unwrapPage(r))),
    // The answers as they were left. Only a head start, so a read that fails starts from the first question rather
    // than taking the page down with it (the API ships some minutes after this app does, and until then it has no
    // such route).
    api.POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'email' } }).then(
      (r) => r.data ?? null,
      () => null,
    ),
  ]);
  const query = await searchParams;
  return (
    <EmailGuidedFlow
      workspaceId={workspaceId}
      businessName={ws.name}
      email={email}
      firstName={got.state.myFirstName}
      got={got}
      draft={{ answers: draft?.answers ?? null, savedAt: draft?.savedAt ?? null }}
      at={query['at'] === 'records' ? 'records' : null}
      done={query['done'] === '1'}
      from={query['from'] === 'settings' ? 'settings' : 'home'}
    />
  );
}
