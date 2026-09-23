import { notFound } from 'next/navigation';
import { IdeaAreasAdmin } from '@/components/admin/idea-areas-admin';
import { apiServer, unwrap } from '@/lib/api/server';

export default async function AdminIdeaAreasPage() {
  const { api } = await apiServer();
  const [areas, me] = await Promise.all([
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrap),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  if (!me.staff?.permissions.includes('platform.ideas.manage')) notFound();
  return <IdeaAreasAdmin areas={areas.areas} />;
}
