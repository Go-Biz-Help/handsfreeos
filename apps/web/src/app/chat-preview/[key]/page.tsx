import { FlaskConical } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import Script from 'next/script';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { CHAT_KEY_RE } from '@/lib/chat/lookup';
import { markOf } from '@/lib/chat/look';

export const metadata: Metadata = {
  title: 'Try your website chat',
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Settings → Website chat → Try it: the widget exactly as visitors see it (the same loader and chat window), on a
 * stand-in page on our own site. Signed in (proxy.ts protects /chat-preview), and the loader tells the window it's
 * a preview, so its chats go to the AI teammate's test console: they create nothing and send nothing. The preview
 * works while the chat is paused, and never counts as the install check.
 */
export default async function ChatPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { key } = await params;
  const { w } = await searchParams;
  if (!CHAT_KEY_RE.test(key) || typeof w !== 'string' || !UUID.test(w)) notFound();
  const { api } = await apiServer();
  const [got, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId: w } }),
    api.POST('/v1/queries/chat_widget.list', { body: { workspaceId: w } }),
  ]);
  const workspace = unwrapPage(got).workspace;
  const widget = unwrapPage(list).items.find((i) => i.publicKey === key);
  if (!widget) notFound();
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <div
        role="status"
        className="sticky top-0 z-10 flex items-center gap-2.5 bg-warning-soft px-4 py-2.5 text-[13px] text-warning-text md:px-6"
        data-testid="chat-preview-banner"
      >
        <FlaskConical className="h-4 w-4 flex-none" aria-hidden />
        <span className="min-w-0 flex-1">
          <strong className="font-semibold">Preview.</strong> Chats here create nothing and send
          nothing.
          {widget.paused ? ' Your chat is paused, so visitors don’t see it right now.' : null}
        </span>
        <Link
          href={`/app/w/${w}/settings/website-chat`}
          className="flex-none font-medium underline underline-offset-2"
        >
          Back to Settings
        </Link>
      </div>
      <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-4 md:px-10">
        <span
          aria-hidden
          className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-card-3 text-[13px] font-bold text-text-2"
        >
          {markOf(workspace.name)}
        </span>
        <span className="truncate text-[15px] font-semibold">{workspace.name}</span>
        <span aria-hidden className="ml-auto hidden gap-5 text-[13px] text-text-3 md:flex">
          <span>Services</span>
          <span>About</span>
          <span>Contact</span>
        </span>
      </header>
      <main className="mx-auto w-full max-w-[880px] flex-1 px-4 py-10 md:px-10">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-3">
          A stand-in for {widget.name}
        </p>
        <h1 className="mt-2 max-w-[560px] text-[28px] font-semibold leading-tight tracking-tight md:text-[34px]">
          Your chat button sits in the corner, just as visitors see it.
        </h1>
        <p className="mt-3 max-w-[560px] text-[15px] leading-relaxed text-text-2">
          Open it and write the way a customer would.
          {widget.teammate
            ? ` ${widget.teammate.name} answers from your saved settings and Knowledge. Anything it would book or change is only described.`
            : ' Only your team answers this chat, so a real one would land in your inbox.'}
        </p>
        <div aria-hidden className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 rounded-card border border-border bg-card" />
          ))}
        </div>
      </main>
      <Script src={`/embed/v1/${key}.js?preview=${w}`} strategy="afterInteractive" />
    </div>
  );
}
