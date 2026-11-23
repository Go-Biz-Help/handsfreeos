import {
  can,
  chatSetupContextFrom,
  chatSetupScreen,
  chatSetupTeammateOf,
  CHAT_SETUP_WORDS,
} from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  ChatSetupDone,
  ChatSetupFlow,
  ChatSetupInstall,
} from '@/components/chat-setup/chat-setup-flow';
import { apiServer, getMe, getSetupWorkspace } from '@/lib/api/server';
import { loadChatEditor } from '@/lib/chat/editor-data';

export const metadata: Metadata = { title: CHAT_SETUP_WORDS.pageTitle };

/**
 * The guided website chat setup (the owner, 23 Nov 2026: W1 a to W4 b): Settings → Website chat opens it (Start,
 * Change, Go through the questions again), and so does the phone's "Open it on the web". One question at a time on a
 * page of its own, saved as it's answered, and nothing changed before Check it over. `?at=<question>` is Settings'
 * Change for one answer; `?step=install` is Put it on your site (`&new=1` right after Turn on website chat);
 * `?done=1` is Done. Only someone who can change the business's channels comes here; anyone else goes Home.
 */
export default async function ChatSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const home = `/app/w/${workspaceId}`;
  const { api, email } = await apiServer();
  // The person's own business, or one the founder is working in as its owner.
  const mine = await getSetupWorkspace(workspaceId);
  if (!mine) notFound();
  if (!can(mine.ws.permissions, 'channels.manage')) redirect(home);
  const query = await searchParams;
  const from = query['from'] === 'setup' ? 'setup' : 'settings';
  const [data, me] = await Promise.all([loadChatEditor(workspaceId), getMe()]);
  // The first chat, as Settings → Website chat shows it; more chats are in Forms.
  const widget = data.widgets[0] ?? null;
  const ctx = chatSetupContextFrom({
    widget,
    teammate: chatSetupTeammateOf(data.teammate),
    website: data.website,
    brandColor: data.brand.look.color?.hex ?? null,
    hasLogo: !!data.brand.logo,
  });
  const businessName = data.brand.businessName;

  if (widget && query['step'] === 'install')
    return (
      <ChatSetupInstall
        workspaceId={workspaceId}
        businessName={businessName}
        email={email}
        widget={widget}
        website={data.website}
        brandedOrigin={data.brandedOrigin}
        fresh={query['new'] === '1'}
        from={from}
      />
    );
  if (widget && query['done'] === '1')
    return (
      <ChatSetupDone
        workspaceId={workspaceId}
        businessName={businessName}
        email={email}
        widget={widget}
        ctx={ctx}
        from={from}
      />
    );

  // The web ships a little before the API: a draft it can't read yet is no draft.
  const draft = await api
    .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'chat' } })
    .then((r) => r.data ?? { answers: null, savedAt: null })
    .catch(() => ({ answers: null, savedAt: null }));
  const at = chatSetupScreen.safeParse(query['at']);
  return (
    <ChatSetupFlow
      workspaceId={workspaceId}
      email={email}
      firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
      ctx={ctx}
      brand={{ businessName, logo: data.brand.logo }}
      draft={{ answers: draft.answers, savedAt: draft.savedAt }}
      at={at.success ? at.data : null}
      from={from}
    />
  );
}
