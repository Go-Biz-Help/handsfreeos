import { can, EMAIL_SETUP_WORDS, EmailSetupGetOutput } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { EmailSetupFlow } from '@/components/email-setup/email-setup-flow';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { ButtonLink } from '@/components/ui/button';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: EMAIL_SETUP_WORDS.homeStartTitle };

/**
 * Home's "Set up your business email" (the owner's 7a): the guided setup's email screens on a page of their own, for
 * a business that finished setting up before the step existed, or whose domain's records are still on their way
 * (`?at=records`). Only someone who can change the business's email comes here; anyone else goes Home.
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
  const me = await getMe();
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  if (!ws) notFound();
  if (!can(ws.permissions, 'channels.manage')) redirect(home);
  const got = EmailSetupGetOutput.parse(
    unwrapPage(await api.POST('/v1/queries/email_setup.get', { body: { workspaceId } })),
  );
  const at = (await searchParams)['at'];
  return (
    <SetupPage
      business={{ name: got.state.businessName || ws.name, home }}
      email={email}
      settingUp={EMAIL_SETUP_WORDS.homeStartTitle}
      finishLater={
        <ButtonLink href={home} variant="ghost" data-testid="email-setup-later">
          {EMAIL_SETUP_WORDS.notNow}
        </ButtonLink>
      }
    >
      <EmailSetupFlow
        workspaceId={workspaceId}
        got={got}
        at={at === 'records' ? 'records' : null}
      />
    </SetupPage>
  );
}
