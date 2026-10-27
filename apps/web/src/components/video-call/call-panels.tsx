'use client';
/**
 * The side panels of a HandsFreeOS video call (docs/video-calls.md): the chat, and who's in the call. For the team,
 * who's asking to come in too, with Let in and Turn away, and Mute and Remove on everyone else. Chat isn't kept:
 * it goes with the call.
 */
import { VIDEO_CALL_ATTRIBUTES, VIDEO_CALL_WORDS, isPersonIdentity } from '@hfos/core';
import {
  useIsMuted,
  useParticipantAttribute,
  useParticipants,
  type ReceivedChatMessage,
} from '@livekit/components-react';
import { Track, type Participant } from 'livekit-client';
import { Hand, MicOff, Send, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { actOn, type VideoCallGot, type VideoCallPerson } from './team-call';
import type { TeamSide } from './types';

function Panel({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <aside
      className="absolute inset-0 z-20 flex flex-col bg-card md:static md:w-[340px] md:flex-none md:rounded-card md:border md:border-border"
      data-testid={testId}
      aria-label={title}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <button
          type="button"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
          className="rounded-control p-1 text-text-2 hover:bg-card-2 hover:text-text"
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </aside>
  );
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function ChatPanel({
  messages,
  send,
  sending,
  onClose,
}: {
  messages: readonly ReceivedChatMessage[];
  send: (text: string) => Promise<unknown>;
  sending: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  const submit = async () => {
    const said = text.trim();
    if (!said || sending) return;
    try {
      await send(said);
      setText('');
    } catch {
      toast.error('Your message didn’t send. Try again in a moment.');
    }
  };
  return (
    <Panel title="Chat" onClose={onClose} testId="call-chat">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-[13px] text-text-3">
            Messages here are seen by everyone in the call, and aren’t kept after it.
          </p>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className="flex flex-col gap-0.5" data-testid="call-chat-message">
            <span className="text-[12px] text-text-3">
              <span className="font-medium text-text-2">
                {m.from?.isLocal ? 'You' : m.from?.name || 'Guest'}
              </span>{' '}
              · {clock(m.timestamp)}
            </span>
            <span className="whitespace-pre-wrap break-words text-[13.5px]">{m.message}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          rows={1}
          value={text}
          maxLength={1000}
          placeholder="Send a message to everyone"
          aria-label="Message"
          className="max-h-28 min-h-9 flex-1 resize-none rounded-control border border-border-strong bg-card px-3 py-2 text-[13.5px] text-text placeholder:text-placeholder focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          data-testid="call-chat-input"
        />
        <Button
          type="submit"
          size="icon"
          className="h-9 w-9"
          aria-label="Send"
          loading={sending}
          disabled={!text.trim()}
        >
          <Send size={16} />
        </Button>
      </form>
    </Panel>
  );
}

const KIND_LABEL: Record<VideoCallPerson['kind'], string> = {
  team: 'Team',
  customer: 'Customer',
  guest: 'Guest',
};

export function PeoplePanel({
  team,
  got,
  reload,
  onClose,
}: {
  /** The team's own: what they may do here. Null for a customer or a guest, who only see who's in. */
  team: TeamSide | null;
  got: VideoCallGot | null;
  reload: () => void;
  onClose: () => void;
}) {
  const inRoom = useParticipants().filter((p) => isPersonIdentity(p.identity));
  const rows = new Map((got?.people ?? []).map((p) => [p.id, p]));
  // Asking to come in: someone waiting, or let in and on their way. A customer waiting goes in on their own now
  // that the team is here, so only someone on the call's link needs a button.
  const asking = (got?.people ?? []).filter(
    (p) =>
      !inRoom.some((r) => r.identity === p.id) && (p.state === 'waiting' || p.state === 'admitted'),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (what: Parameters<typeof actOn>[0], personId: string) => {
    if (!team || busy) return;
    setBusy(`${what}:${personId}`);
    try {
      await actOn(what, { workspaceId: team.workspaceId, callId: team.callId, personId });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="People" onClose={onClose} testId="call-people">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
        {team && asking.length ? (
          <section className="mb-4" data-testid="call-asking">
            <h3 className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-text-3">
              Asking to join
            </h3>
            {asking.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2.5 py-1.5"
                data-testid={`call-asking-${p.id}`}
              >
                <Avatar name={p.name} seed={p.id} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13.5px]">{p.name}</span>
                  <span className="text-[12px] text-text-3">
                    {p.state === 'admitted'
                      ? 'Let in, joining now'
                      : p.kind === 'customer'
                        ? 'On their own link, coming in now'
                        : KIND_LABEL[p.kind]}
                  </span>
                </span>
                {p.state === 'waiting' && p.kind === 'guest' ? (
                  <>
                    <Button
                      size="sm"
                      loading={busy === `admit:${p.id}`}
                      onClick={() => void act('admit', p.id)}
                    >
                      {VIDEO_CALL_WORDS.letIn}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === `turn_away:${p.id}`}
                      onClick={() => void act('turn_away', p.id)}
                    >
                      {VIDEO_CALL_WORDS.turnAway}
                    </Button>
                  </>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
        <section data-testid="call-in">
          <h3 className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-text-3">
            In the call ({inRoom.length})
          </h3>
          {inRoom.map((p) => (
            <InCall
              key={p.identity}
              participant={p}
              row={rows.get(p.identity) ?? null}
              team={team}
              busy={busy}
              onAct={(what) => void act(what, p.identity)}
            />
          ))}
        </section>
      </div>
    </Panel>
  );
}

function InCall({
  participant: p,
  row,
  team,
  busy,
  onAct,
}: {
  participant: Participant;
  row: VideoCallPerson | null;
  team: TeamSide | null;
  busy: string | null;
  onAct: (what: 'mute' | 'remove') => void;
}) {
  const micOff = useIsMuted({ participant: p, source: Track.Source.Microphone });
  const hand = useParticipantAttribute(VIDEO_CALL_ATTRIBUTES.hand, { participant: p }) === 'up';
  const name = p.name || row?.name || 'Guest';
  return (
    <div className="flex items-center gap-2.5 py-1.5" data-testid="call-person" data-name={name}>
      <Avatar name={name} seed={p.identity} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 truncate text-[13.5px]">
          {p.isLocal ? `${name} (you)` : name}
          {hand ? <Hand size={13} className="flex-none text-warning" aria-label="Hand up" /> : null}
        </span>
        {row ? <span className="text-[12px] text-text-3">{KIND_LABEL[row.kind]}</span> : null}
      </span>
      {micOff ? (
        <MicOff size={15} className="flex-none text-text-3" aria-label="Microphone off" />
      ) : null}
      {team && !p.isLocal ? (
        <span className="flex flex-none gap-1">
          {!micOff ? (
            <Button
              variant="ghost"
              size="sm"
              loading={busy === `mute:${p.identity}`}
              onClick={() => onAct('mute')}
            >
              {VIDEO_CALL_WORDS.mute}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={cn('text-danger-text')}
            loading={busy === `remove:${p.identity}`}
            onClick={() => onAct('remove')}
          >
            {VIDEO_CALL_WORDS.remove}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
