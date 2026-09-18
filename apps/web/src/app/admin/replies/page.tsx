import { SavedReplies } from '@/components/admin/saved-replies';
import { apiServer, unwrap } from '@/lib/api/server';

export default async function SavedRepliesPage() {
  const { api } = await apiServer();
  const [list, me] = await Promise.all([
    api.POST('/v1/queries/support.canned_reply.list', { body: {} }).then(unwrap),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  return (
    <SavedReplies
      replies={list.replies}
      canManage={me.staff?.permissions.includes('support.manage') ?? false}
    />
  );
}
