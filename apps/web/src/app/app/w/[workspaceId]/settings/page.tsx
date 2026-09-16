import type { Metadata } from 'next';
import { AppearanceSection } from '@/components/settings/appearance-section';
import { GoogleSection } from '@/components/settings/google-section';
import { NotificationsSection } from '@/components/settings/notifications-section';
import { PasskeysSection } from '@/components/settings/passkeys-section';
import { PasswordSection } from '@/components/settings/password-section';
import { ProfileForm } from '@/components/settings/profile-form';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';
import { apiServer, fetchMe } from '@/lib/api/server';
import { parseTheme } from '@/lib/theme';

export const metadata: Metadata = { title: 'Account settings' };

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const role = me.workspaces.find((w) => w.id === workspaceId)?.role;
  // All on unless turned off. The daily agency digest is for organization owners and admins only.
  const notifications = (
    me.user.settings as {
      notifications?: {
        unansweredEmail?: boolean;
        attentionDigest?: boolean;
        aiHandoff?: boolean;
        bookingEmail?: boolean;
        agencyDigest?: boolean;
      };
    }
  ).notifications;
  const agency = me.organizations.some((o) => o.role === 'owner' || o.role === 'admin');
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage={role === 'owner' || role === 'admin'} />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Card className="p-6">
            <ProfileForm user={me.user} />
          </Card>
          <Card className="p-6" id="appearance">
            <AppearanceSection
              initial={parseTheme((me.user.settings as { theme?: unknown }).theme)}
            />
          </Card>
          <Card className="p-6" id="notifications">
            <NotificationsSection
              agency={agency}
              initial={{
                unansweredEmail: notifications?.unansweredEmail !== false,
                attentionDigest: notifications?.attentionDigest !== false,
                aiHandoff: notifications?.aiHandoff !== false,
                bookingEmail: notifications?.bookingEmail !== false,
                agencyDigest: notifications?.agencyDigest !== false,
              }}
            />
          </Card>
        </div>
        <Card className="p-6">
          <h2 className="text-lg font-semibold tracking-tight">Sign-in methods</h2>
          <p className="mt-1 text-[13px] text-text-2">
            Keep at least two so you are never locked out.
          </p>
          <div className="mt-2.5 flex flex-col">
            <PasswordSection email={me.user.email} />
            <div className="h-px bg-border" />
            <GoogleSection />
            <div className="h-px bg-border" />
            <PasskeysSection />
          </div>
        </Card>
      </div>
    </>
  );
}
