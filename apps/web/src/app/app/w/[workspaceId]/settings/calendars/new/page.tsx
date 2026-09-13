import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { PresetPicker } from '@/components/calendars/preset-picker';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, fetchMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'New calendar' };

/** "How do you want this calendar to work?": presets only fill in settings. */
export default async function NewCalendarPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (got.workspace.role !== 'owner' && got.workspace.role !== 'admin') notFound();
  const [me, members, services, resources] = await Promise.all([
    fetchMe(api),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/service.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/resource.list', { body: { workspaceId } })),
  ]);
  const base = `/app/w/${workspaceId}/settings`;
  return (
    <>
      <div className="mb-2.5 flex items-center gap-1 text-xs text-text-3">
        <Link href={base} className="text-accent-text hover:underline">
          Settings
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <Link href={`${base}/calendars`} className="text-accent-text hover:underline">
          Calendars
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span>New calendar</span>
      </div>
      <h1 className="mb-[18px] text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
        New calendar
      </h1>
      <PresetPicker
        workspaceId={workspaceId}
        myUserId={userId}
        myName={me.user.fullName || me.user.email}
        people={assigneeOptions(members)}
        services={services.items}
        resources={resources.items}
      />
    </>
  );
}
