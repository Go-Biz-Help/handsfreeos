import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiServer, getMe, unwrap } from '@/lib/api/server';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';

/**
 * Where the emails about an idea point (the worker's `/app/ideas/<id>`). The board is the same in every business,
 * so the link names no business: it opens in the one the person was last in, the way /app does. Somebody who
 * works here and in no business reads it on the admin side instead.
 */
export default async function IdeaLinkPage({ params }: { params: Promise<{ ideaId: string }> }) {
  const { ideaId } = await params;
  const { api } = await apiServer();
  const me = await getMe();
  if (me.workspaces.length === 0) {
    const { staff } = unwrap(await api.POST('/v1/queries/platform.me', { body: {} }));
    redirect(staff ? `/admin/ideas/${ideaId}` : '/onboarding');
  }
  const last = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const target = me.workspaces.find((w) => w.id === last) ?? me.workspaces[0]!;
  redirect(`/app/w/${target.id}/ideas/${ideaId}`);
}
