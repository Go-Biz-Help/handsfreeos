/**
 * What the playbook builder needs besides the playbook: the business's own tags to tap in (most used first, those
 * short enough for a playbook), its booking pages to use as the link, and the address its public links show on.
 * Someone who can't see the business's records gets no tags to pick from, and types their own.
 */
import { PLAYBOOK_LIMITS } from '@hfos/core/addons/outreach/playbooks';
import { apiServer, getWorkspaceShell, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

/** Past this many, the business's tags stop being a quick pick. */
const TAGS_SHOWN = 24;

export async function builderData(workspaceId: string) {
  const { api } = await apiServer();
  const { current } = await getWorkspaceShell(workspaceId);
  const [tags, calendars, brandedOrigin] = await Promise.all([
    current.permissions.includes('records.read')
      ? api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage)
      : null,
    api.POST('/v1/queries/calendar.list', { body: { workspaceId } }).then(unwrapPage),
    brandedOriginFor(api, workspaceId),
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
  };
}
