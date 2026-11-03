'use client';
/**
 * A video call's chat, kept with the call whatever its AI notes (docs/video-calls.md, "The chat, kept"): on the
 * appointment, and in the notes of a call that wasn't for one. Folded away under its count, oldest first, each
 * message's links pressable. Nothing shows while the call has no chat.
 */
import { VIDEO_CALL_WORDS } from '@hfos/core';
import { useEffect, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { ChatText } from './chat-text';

type Message = {
  id: string;
  name: string;
  side: 'team' | 'customer';
  body: string;
  sentAt: string;
};

const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function CallChatLog({
  workspaceId,
  callId,
  version = 0,
}: {
  workspaceId: string;
  callId: string;
  /** Read again when it changes: people coming and going. */
  version?: number;
}) {
  const [got, setGot] = useState<{ messages: Message[]; more: number } | null>(null);
  useEffect(() => {
    let gone = false;
    apiBrowser()
      .POST('/v1/queries/video_call.chat', { body: { workspaceId, callId } })
      .then(unwrap)
      .then((out) => {
        if (!gone) setGot({ messages: out.messages, more: out.more });
      })
      // Only the chat is missing then; the rest of the call still shows.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspaceId, callId, version]);

  if (!got?.messages.length) return null;
  const total = got.messages.length + got.more;
  return (
    <details className="group" data-testid="call-chat-log">
      <summary className="cursor-pointer text-[13px] font-medium">
        {VIDEO_CALL_WORDS.chatLog} <span className="text-text-3">· {total}</span>
      </summary>
      <div className="mt-2 flex max-h-80 flex-col gap-2.5 overflow-y-auto">
        {got.messages.map((m) => (
          <div key={m.id} className="flex flex-col gap-0.5" data-testid="call-chat-log-message">
            <span className="text-[12px] text-text-3">
              <span className="font-medium text-text-2">{m.name}</span> · {clock(m.sentAt)}
            </span>
            <span className="whitespace-pre-wrap break-words text-[13px]">
              <ChatText text={m.body} />
            </span>
          </div>
        ))}
        {got.more ? (
          <p className="text-xs text-text-3">{VIDEO_CALL_WORDS.chatLogMore(got.more)}</p>
        ) : null}
      </div>
    </details>
  );
}
