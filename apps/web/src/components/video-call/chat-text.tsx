/**
 * A chat message from a video call, with each link and email address in it one to press (core's `chatLinkParts`):
 * in the call's chat, and in the chat kept on the appointment. A page opens in a new tab, with no referrer.
 */
import { chatLinkParts } from '@hfos/core';

export function ChatText({ text }: { text: string }) {
  return (
    <>
      {chatLinkParts(text).map((p, i) =>
        p.href ? (
          <a
            key={i}
            href={p.href}
            {...(p.href.startsWith('mailto:')
              ? {}
              : { target: '_blank', rel: 'noopener noreferrer nofollow' })}
            className="font-medium text-accent-text underline underline-offset-2 hover:no-underline"
            data-testid="call-chat-link"
          >
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
