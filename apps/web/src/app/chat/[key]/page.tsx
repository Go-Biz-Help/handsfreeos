import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ChatUnavailable } from '@/components/chat-widget/chat-parts';
import { ChatShowcase } from '@/components/chat-widget/chat-showcase';
import { ChatWindow } from '@/components/chat-widget/chat-window';
import { CHAT_WINDOW_HEADER, chatWindowFrom } from '@/lib/chat/frame';

/**
 * The chat window: /chat/<key>, framed by a business's site (the loader creates it on the first click) or by our
 * own preview page. No app shell and no session. proxy.ts has already set the frame rule and looked the widget
 * up; without its answer (it always runs first) the window refuses rather than show unframed-for-anyone.
 *
 * Opened on its own in a tab, it's the chat's sign-up page instead (ChatShowcase): its details form, which works, and
 * the page a texting registration gives the carrier's reviewer.
 */
async function context() {
  return chatWindowFrom((await headers()).get(CHAT_WINDOW_HEADER));
}

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await context();
  const name = ctx?.lookup.state === 'ok' ? ctx.lookup.config.business.name : null;
  return {
    title: {
      absolute: ctx?.standalone
        ? name
          ? `Get texts from ${name}`
          : 'Sign up for texts'
        : name
          ? `Chat with ${name}`
          : 'Chat',
    },
    robots: { index: false, follow: false },
  };
}

export default async function ChatWindowPage() {
  const ctx = await context();
  if (!ctx || ctx.lookup.state === 'unreachable') return <ChatUnavailable kind="unreachable" />;
  if (ctx.lookup.state === 'missing') notFound();
  if (ctx.lookup.state === 'refused') return <ChatUnavailable kind="refused" />;
  if (ctx.standalone)
    return ctx.lookup.config.paused ? (
      <ChatUnavailable kind="paused" />
    ) : (
      <ChatShowcase config={ctx.lookup.config} widgetKey={ctx.key} />
    );
  return (
    <ChatWindow
      widgetKey={ctx.key}
      config={ctx.lookup.config}
      origin={ctx.origin}
      path={ctx.path}
      preview={ctx.preview}
    />
  );
}
