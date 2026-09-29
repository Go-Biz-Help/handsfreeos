import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TextingPage } from '@/components/settings/texting-page';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Texting & calls' };

/** Owners and admins set up the business number and the carrier registration here. */
export default async function TextingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, status, me, members, ports, site, widgets, forms, imports, twilio] =
    await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/phone.setup_status', { body: { workspaceId } }).then(unwrapPage),
      getMe(),
      api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
      // Numbers being brought from another carrier (M17). Its own query rather than a field on setup_status,
      // because it is `channels.manage` only — the losing carrier's paperwork is not everyone's to see.
      api.POST('/v1/queries/number_port.list', { body: { workspaceId } }).then(unwrapPage),
      // What is already public, for the registration wizard's hosted opt-in: it has to know what it still
      // has to create, and a carrier reviewing the campaign has to be given addresses that actually open.
      api.POST('/v1/queries/booking_site.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/chat_widget.list', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/form.list', { body: { workspaceId } }).then(unwrapPage),
      // Numbers already in Twilio on their way here — the business's own account, or GoHighLevel's LC Phone —
      // and the Twilio accounts the organization connected to bring them from.
      api
        .POST('/v1/queries/number_import.list', {
          body: { workspaceId, includeFinished: true },
        })
        .then(unwrapPage),
      api.POST('/v1/queries/twilio_connection.list', { body: { workspaceId } }).then(unwrapPage),
    ]);
  if (!can(got.workspace.permissions, 'channels.manage')) notFound();
  // Everyone who works the inbox — by first name for the "these browsers ring" line, and with their ids
  // for choosing who each number rings (M17).
  const inbox = members.members.filter((m) => can(m.permissions, 'inbox.use'));
  const team = inbox.map((m) => (m.fullName.trim() || m.email).split(/\s+/)[0] ?? m.email);
  const people = inbox.map((m) => ({
    userId: m.userId,
    name: m.fullName.trim() || m.email,
  }));
  // A paused widget is not a page a reviewer can open, and a form that was never published is not either,
  // so neither counts as a live surface however recently it was made.
  const liveWidget = widgets.items.find((w) => !w.paused) ?? null;
  const liveForm = forms.items.find((f) => f.status === 'live') ?? null;
  const surfaces = {
    siteSlug: site.site?.slug ?? null,
    chatPublicKey: liveWidget?.publicKey ?? null,
    contactFormSlug: liveForm?.slug ?? null,
    bookingEnabled: site.site?.enabled ?? false,
  };
  return (
    <>
      <TextingPage
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        status={status}
        me={{ fullName: me.user.fullName, email: me.user.email }}
        team={team}
        people={people}
        ports={ports.ports}
        portsFromMigration={ports.fromMigration}
        imports={imports.imports}
        importsFromMigration={imports.fromMigration}
        twilio={twilio}
        inboxPerPerson={got.workspace.inboxPerPerson}
        surfaces={surfaces}
      />
    </>
  );
}
