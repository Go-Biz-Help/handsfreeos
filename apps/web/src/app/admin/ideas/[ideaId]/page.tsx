import { IdeaTeamViewPage } from '@/components/admin/idea-team-view';
import { apiServer, unwrapPage } from '@/lib/api/server';

export default async function AdminIdeaPage({ params }: { params: Promise<{ ideaId: string }> }) {
  const { ideaId } = await params;
  const { api } = await apiServer();
  const [data, team, areas, me] = await Promise.all([
    api.POST('/v1/queries/idea.get', { body: { ideaId } }).then(unwrapPage),
    api.POST('/v1/queries/idea.team_view', { body: { ideaId } }).then(unwrapPage),
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrapPage),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrapPage),
  ]);
  return (
    <IdeaTeamViewPage
      key={ideaId}
      data={data}
      team={team}
      areas={areas.areas}
      can={{ manage: me.staff?.permissions.includes('platform.ideas.manage') ?? false }}
    />
  );
}
