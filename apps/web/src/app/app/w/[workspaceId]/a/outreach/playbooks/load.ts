/**
 * What the playbook builder needs besides the playbook: the business's own tags to tap in (most used first, those
 * short enough for a playbook), its booking pages to use as the link, the address its public links show on, the
 * live main offer a playbook narrows, and how many videos its library has, which Permission ask needs (decision 183).
 * Someone who can't see the business's records gets no tags to pick from, and types their own.
 */
import type { MainOfferParts } from '@hfos/core';
import { outreachSettings } from '@hfos/core/addons/outreach/chat-read';
import { playbookOffer } from '@hfos/core/addons/outreach/playbook-assist';
import { libraryOf } from '@hfos/core/addons/outreach/video-library';
import { PLAYBOOK_LIMITS } from '@hfos/core/addons/outreach/playbooks';
import { apiServer, getWorkspaceShell, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

/** Past this many, the business's tags stop being a quick pick. */
const TAGS_SHOWN = 24;

export async function builderData(workspaceId: string) {
  const { api } = await apiServer();
  const { current } = await getWorkspaceShell(workspaceId);
  const [tags, calendars, brandedOrigin, offer, settings, playbooks] = await Promise.all([
    current.permissions.includes('records.read')
      ? api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage)
      : null,
    api.POST('/v1/queries/calendar.list', { body: { workspaceId } }).then(unwrapPage),
    brandedOriginFor(api, workspaceId),
    api.POST('/v1/queries/main_offer.get', { body: { workspaceId } }).then(unwrapPage),
    // The video library, or the playbooks' short videos until it's saved (decision 154). Not had, none counted.
    api
      .POST('/v1/queries/addon.settings', { body: { workspaceId, addonId: 'outreach' } })
      .then((r) => r.data ?? null)
      .catch(() => null),
    api
      .POST('/v1/queries/outreach.playbook.list', { body: { workspaceId } })
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
  return {
    businessTags: (tags?.tags ?? [])
      .filter((t) => t.name.length <= PLAYBOOK_LIMITS.tags.line)
      .sort((a, b) => b.usage - a.usage)
      .slice(0, TAGS_SHOWN)
      .map((t) => t.name),
    bookingPages: calendars.items
      .filter((c) => c.status === 'active' && c.public)
      .map((c) => ({ name: c.name, path: c.bookingPath ?? c.permanentPath })),
    brandedOrigin,
    mainOffer: offer.live
      ? playbookOffer(offer.live.parts as MainOfferParts, offer.live.line)
      : null,
    /** Its live version: the short video's script says when it was written for an older one. */
    mainOfferVersion: offer.live?.version ?? null,
    videos: libraryOf(
      outreachSettings(settings?.settings).videos,
      (playbooks?.playbooks ?? []).map((p) => ({
        name: p.name,
        details: p.details as { videoLink?: string | null },
      })),
    ).length,
  };
}
