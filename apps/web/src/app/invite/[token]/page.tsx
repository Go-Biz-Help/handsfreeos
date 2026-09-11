import type { Metadata } from 'next';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { AcceptInvite, SwitchAccount } from '@/components/members/accept-invite';
import { Avatar } from '@/components/ui/avatar';
import { RoleBadge } from '@/components/ui/badge';
import { Brand } from '@/components/ui/brand';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, apiServer, unwrap } from '@/lib/api/server';
import { ROLE_DESCRIPTIONS } from '@hfos/core';

export const metadata: Metadata = { title: 'Invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { api, email } = await apiServer();
  let preview: Awaited<ReturnType<typeof load>> | null = null;
  async function load() {
    return unwrap(await api.POST('/v1/queries/invitation.preview', { body: { token } }));
  }
  try {
    preview = await load();
  } catch (e) {
    if (!(e instanceof ApiError && (e.status === 404 || e.status === 400))) throw e;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12 [background:radial-gradient(70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_9%,transparent),transparent_75%)]">
      <Brand size={32} className="text-base" />
      <Card className="w-[480px] max-w-full rounded-dialog p-9">
        {!preview ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Invitation not found</h1>
            <p className="mt-2 leading-relaxed text-text-2">
              This link is not valid. Ask the person who invited you to send a new one.
            </p>
            <ButtonLink href="/app" variant="primary" size="lg" className="mt-6 w-full">
              Go to your workspaces
            </ButtonLink>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3.5">
              <Avatar
                name={preview.inviterName ?? 'A teammate'}
                seed={preview.inviterName ?? 'x'}
                size="lg"
                className="bg-[#008743] text-[15px]"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] text-text-2">
                  {preview.inviterName ?? 'A teammate'} invited you to join
                </span>
                <h1 className="text-2xl font-semibold leading-tight tracking-tight">
                  {preview.workspaceName}
                </h1>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-[13px] text-text-3">
              <RoleBadge role={preview.role} />
              {ROLE_DESCRIPTIONS[preview.role]}
            </div>
            {preview.status === 'pending' && preview.emailMatches ? (
              <AcceptInvite token={token} email={email} expiresAt={preview.expiresAt} />
            ) : preview.status === 'pending' ? (
              <>
                <div
                  className="mt-6 flex gap-3 rounded-menu bg-danger-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-danger-text"
                  data-testid="invite-wrong-account"
                >
                  <AlertCircle className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
                  <span>
                    This invitation was sent to{' '}
                    <strong className="font-semibold">{preview.inviteeEmailMasked}</strong>, but you
                    are signed in as <strong className="font-semibold">{email}</strong>. Invitations
                    only work for the address they were sent to.
                  </span>
                </div>
                <SwitchAccount token={token} />
              </>
            ) : preview.status === 'used' ? (
              <>
                <div
                  className="mt-6 flex gap-3 rounded-menu bg-warning-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-warning-text"
                  data-testid="invite-used"
                >
                  <CheckCircle2 className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
                  <span>This invitation was already accepted. Each link works once.</span>
                </div>
                <ButtonLink href="/app" variant="primary" size="lg" className="mt-5 w-full">
                  Open your workspaces
                </ButtonLink>
              </>
            ) : (
              <>
                <div
                  className="mt-6 flex gap-3 rounded-menu bg-warning-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-warning-text"
                  data-testid={`invite-${preview.status}`}
                >
                  <Clock className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
                  <span>
                    {preview.status === 'expired'
                      ? `This invitation expired on ${new Date(preview.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. For safety, links stop working after 7 days.`
                      : 'This invitation was revoked by the workspace.'}
                  </span>
                </div>
                <p className="mt-5 text-[13px] text-text-2">
                  Ask {preview.inviterName ?? 'the person who invited you'} for a new invitation.
                </p>
              </>
            )}
          </>
        )}
      </Card>
      <p className="text-[13px] text-text-3">
        Wrong workspace? Just close this page. Nothing changes until you accept.
      </p>
    </div>
  );
}
