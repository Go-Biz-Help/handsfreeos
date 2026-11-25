import { redirect } from 'next/navigation';

/**
 * The Assistant is a panel over whatever page you're on, so its links (a scheduled question's answer, by push or
 * email: `/assistant?chat=<id>`) land on Home with the panel open on that chat (AssistantProvider reads `?chat=`).
 */
export default async function AssistantPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { chat } = await searchParams;
  const id = typeof chat === 'string' && /^[0-9a-f-]{36}$/i.test(chat) ? chat : null;
  redirect(`/app/w/${workspaceId}?${id ? `chat=${id}` : 'assistant=open'}`);
}
