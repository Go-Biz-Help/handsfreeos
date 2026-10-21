import { managesAnAgency, pushSwitchesOf } from '@hfos/core';
import type { Metadata } from 'next';
import { DeleteAccount } from '@/components/account/delete-account';
import { AppearanceSection } from '@/components/settings/appearance-section';
import { GoogleSection } from '@/components/settings/google-section';
import { MenuSection } from '@/components/settings/menu-section';
import { MyCellSection } from '@/components/settings/my-cell-section';
import { NotificationsSection } from '@/components/settings/notifications-section';
import { PasskeysSection } from '@/components/settings/passkeys-section';
import { PasswordSection } from '@/components/settings/password-section';
import { ProfileForm } from '@/components/settings/profile-form';
import { settingAttrs } from '@/components/settings/setting-anchor';
import { Card } from '@/components/ui/card';
import { apiServer, getMe, getPlatformMe, unwrap } from '@/lib/api/server';
import { parseTheme } from '@/lib/theme';

export const metadata: Metadata = { title: 'Account settings' };

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [me, devices, cell, deletion, phone, platform] = await Promise.all([
    getMe(),
    api.POST('/v1/queries/push_device.list', { body: {} }).then(unwrap),
    api.POST('/v1/queries/user_phone.get', { body: {} }).then(unwrap),
    api.POST('/v1/queries/account.deletion_check', { body: {} }).then(unwrap),
    // The business number the cell's calls come from; someone without the inbox has none to show.
    api
      .POST('/v1/queries/phone.setup_status', { body: { workspaceId } })
      .then(unwrap)
      .catch(() => null),
    // Whether they answer HandsFreeOS support: only then is New support tickets a row of theirs.
    getPlatformMe(),
  ]);
  const current = me.workspaces.find((w) => w.id === workspaceId);
  // All on unless turned off. The daily agency digest is for organization owners and admins only.
  const notifications = (
    me.user.settings as {
      notifications?: {
        unansweredEmail?: boolean;
        attentionDigest?: boolean;
        eveningSummary?: boolean;
        aiHandoff?: boolean;
        bookingEmail?: boolean;
        paymentEmail?: boolean;
        agencyDigest?: boolean;
        addonEmail?: boolean;
      };
    }
  ).notifications;
  // An agency: an organization with more than one business, as settings search and the phone decide it.
  const agency = managesAnAgency({ organizations: me.organizations, businesses: me.workspaces });
  const number = phone?.number && phone.number.status === 'active' ? phone.number.e164 : null;
  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
          <div className="flex flex-col gap-5">
            <Card className="p-6" {...settingAttrs('account.profile')}>
              <ProfileForm user={me.user} />
            </Card>
            <Card className="p-6" id="appearance">
              <AppearanceSection
                initial={parseTheme((me.user.settings as { theme?: unknown }).theme)}
              />
            </Card>
            <Card className="p-6" id="menu">
              <MenuSection />
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
        <Card className="p-6 max-md:p-5" id="notifications">
          <NotificationsSection
            agency={agency}
            staff={Boolean(platform?.staff)}
            phones={devices.devices.length}
            initial={{
              email: {
                unansweredEmail: notifications?.unansweredEmail !== false,
                attentionDigest: notifications?.attentionDigest !== false,
                eveningSummary: notifications?.eveningSummary !== false,
                aiHandoff: notifications?.aiHandoff !== false,
                bookingEmail: notifications?.bookingEmail !== false,
                paymentEmail: notifications?.paymentEmail !== false,
                agencyDigest: notifications?.agencyDigest !== false,
                addonEmail: notifications?.addonEmail !== false,
              },
              push: pushSwitchesOf(me.user.settings),
            }}
          />
        </Card>
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
          <Card className="p-6" id="my-cell">
            <MyCellSection
              workspaceId={workspaceId}
              businessName={current?.name ?? 'This business'}
              businessNumber={number}
              initial={cell.phone}
            />
          </Card>
          <Card className="p-6" id="delete-account">
            <DeleteAccount email={me.user.email} check={deletion} />
          </Card>
        </div>
      </div>
    </>
  );
}
