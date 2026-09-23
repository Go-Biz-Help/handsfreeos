import { WhatsNewAdmin } from '@/components/admin/whats-new-admin';
import { apiServer, unwrap } from '@/lib/api/server';

export default async function AdminWhatsNewPage() {
  const { api } = await apiServer();
  const [list, areas, me] = await Promise.all([
    api
      .POST('/v1/queries/whats_new.list', { body: { includeDrafts: true, limit: 50 } })
      .then(unwrap),
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrap),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  return (
    <WhatsNewAdmin
      entries={list.entries}
      areas={areas.areas}
      canManage={me.staff?.permissions.includes('platform.ideas.manage') ?? false}
    />
  );
}
