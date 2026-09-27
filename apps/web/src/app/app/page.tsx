import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMe } from '@/lib/api/server';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';

export default async function AppIndexPage() {
  const me = await getMe();
  if (me.workspaces.length === 0) redirect('/onboarding');
  const last = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const target = me.workspaces.find((w) => w.id === last) ?? me.workspaces[0]!;
  redirect(`/app/w/${target.id}`);
}
