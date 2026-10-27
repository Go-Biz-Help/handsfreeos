'use client';
/**
 * A message the extension drafted to send (packages/core/src/addons/outreach/sends.ts), on Today's Needs you and its
 * list: the texts it would send, as they'd look in Messenger, with **Send**, **Edit** and **Skip** while it waits, and
 * why it waits for an OK of its own when it does (decision 42); once OK'd it goes soon. Changing the words teaches the
 * AI. A message of a few texts (decision 55) keeps a blank line between them while it's changed.
 *
 * A comment on a good post (decision 92, Instagram's and Alignable's) waits the same way, with **OK**, **Change** and
 * **Skip**: the extension posts it under the post once OK'd, and a comment skipped puts its post aside.
 */
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { commentTitle, oneByOneWords } from '@hfos/core/addons/outreach/waiting-words';
import { messageParts } from '@hfos/core/addons/outreach/voice';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { Check, Pencil, Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useAct } from './use-act';

/** What Drafted needs of a message the extension drafted: Today's list and Needs you both have it. */
export interface DraftedSend {
  readonly sendId: string;
  readonly state: 'waiting' | 'approved' | (string & {});
  readonly text: string;
  readonly handedOver: boolean;
  readonly needsYou: string | null;
}

/** The texts a message goes as: a few short ones, or one. */
const sendLabel = (n: number) => (n > 1 ? `Send ${n} texts` : 'Send');

function Bubbles({ parts, testId }: { parts: readonly string[]; testId: string }) {
  return (
    <ul className="flex flex-col items-end gap-1.5" data-testid={testId}>
      {parts.map((part, i) => (
        <li
          key={i}
          className="max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] border-[1.5px] border-dashed border-border-strong bg-card px-3 py-2 text-[13.5px]"
        >
          {part}
        </li>
      ))}
    </ul>
  );
}

export function Drafted({
  workspaceId,
  name,
  send,
  comment = null,
}: {
  workspaceId: string;
  /** Who it's to: for a comment, whose post it goes under. */
  name: string;
  send: DraftedSend;
  /** For a comment on a good post (decision 92): the network it's posted on. Null for a message. */
  comment?: Platform | null;
}) {
  const [text, setText] = useState(send.text);
  const [editing, setEditing] = useState(false);
  const { busy, act } = useAct();
  // A comment is one, under the post; a message may go as a few texts.
  const partsOf = (t: string) => (comment ? [t] : messageParts(t, true));
  if (send.state === 'approved')
    return (
      <div className="mt-3 space-y-1.5" data-testid="today-send-approved">
        <p className="text-[12.5px] text-text-3">{comment ? W.commentOkd : W.sentOkd}</p>
        <Bubbles parts={partsOf(send.text)} testId="today-send-texts" />
      </div>
    );
  const parts = partsOf(text);
  const alone = oneByOneWords(send);
  return (
    <div
      className="mt-3 space-y-2"
      data-testid="today-send"
      data-kind={comment ? 'comment' : 'message'}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {comment
            ? W.yourComment
            : parts.length > 1
              ? `Your reply · ${parts.length} texts`
              : 'Your reply'}
        </p>
        <p className="text-[12.5px] text-text-3">{W.changeHelp}</p>
      </div>
      {alone ? (
        <p className="text-[12.5px] text-warning-text" data-testid="today-send-alone">
          {alone}
        </p>
      ) : null}
      {editing ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={comment ? commentTitle(name) : `Message to ${name}`}
          rows={Math.min(8, Math.max(3, text.split('\n').length + 1))}
          autoFocus
        />
      ) : (
        <Bubbles parts={parts} testId="today-send-texts" />
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          disabled={busy !== null || !text.trim()}
          onClick={() =>
            void act(
              'send',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/outreach.send.approve', {
                    body: { workspaceId, sends: [{ sendId: send.sendId, text }] },
                  }),
                ),
              comment ? W.okdComment(PLATFORMS[comment]) : W.okd,
            )
          }
          data-testid="today-send-ok"
        >
          {comment ? (
            <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
          ) : (
            <Send className="h-3.5 w-3.5" strokeWidth={1.5} />
          )}
          {comment ? W.ok : sendLabel(parts.length)}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          aria-pressed={editing}
          onClick={() => setEditing((e) => !e)}
          data-testid="today-send-edit"
        >
          <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
          {editing ? 'Done' : comment ? W.change : 'Edit'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void act(
              'skip',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/outreach.send.skip', {
                    body: { workspaceId, sendId: send.sendId },
                  }),
                ),
              comment ? W.commentSkipped : `Skipped. ${name} is off your list for today.`,
            )
          }
          data-testid="today-send-skip"
        >
          {W.skip}
        </Button>
      </div>
    </div>
  );
}
