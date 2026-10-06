import { can } from '@hfos/core';
import type { ApiClient } from '@hfos/api-client';
import type { ComponentProps } from 'react';
import type { TextingPage } from '@/components/settings/texting-page';
import { getMe, unwrapPage } from '@/lib/api/server';

/**
 * Everything Settings → Texting & calls shows, for that page and for the setup wizard's number step. Null when
 * this person can't manage the business's channels.
 */
export async function loadTexting(
  api: ApiClient,
  workspaceId: string,
): Promise<ComponentProps<typeof TextingPage> | null> {
  const [got, status, me, members, ports, site, widgets, forms, imports, twilio, draft] =
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
      // The registration's answers as they were left, so the wizard picks up where it stopped.
      api.POST('/v1/queries/registration.get_draft', { body: { workspaceId } }).then(unwrapPage),
    ]);
  if (!can(got.workspace.permissions, 'channels.manage')) return null;
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
  const settings = (got.workspace.settings ?? {}) as Record<string, unknown>;
  return {
    workspaceId,
    businessName: got.workspace.name,
    // Settings → Workspace's website, which setup's quick questions fill in too.
    businessWebsite: typeof settings['website'] === 'string' ? settings['website'] || null : null,
    status,
    me: { fullName: me.user.fullName, email: me.user.email },
    team,
    people,
    ports: ports.ports,
    portsFromMigration: ports.fromMigration,
    imports: imports.imports,
    importsFromMigration: imports.fromMigration,
    twilio,
    inboxPerPerson: got.workspace.inboxPerPerson,
    registrationDraft: draft.answers,
    surfaces: {
      siteSlug: site.site?.slug ?? null,
      chatPublicKey: liveWidget?.publicKey ?? null,
      contactFormSlug: liveForm?.slug ?? null,
      bookingEnabled: site.site?.enabled ?? false,
    },
  };
}
