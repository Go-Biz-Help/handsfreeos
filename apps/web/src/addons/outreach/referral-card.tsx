'use client';
/**
 * Refer someone you've talked with (docs/outreach.md, decision 174), near the top of the Today tab: a post asking for
 * a recommendation of what someone the person talked with does, with who and why, the comment naming them and the
 * heads-up to them, as the AI wrote them. Both wait for the person (the owner's 9a): each text to change and copy,
 * **Open the post** and **Open their chat**, then **I did both**, which notes it with the words as they stand, or
 * **Not this one**, which puts it aside for good. The words are core's (`REFER_WORDS`).
 */
import { REFER_WORDS as RW, type Referral } from '@hfos/core/addons/outreach/referrals';
import { Check, Copy, ExternalLink, X } from 'lucide-react';
import { useState } from 'react';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useAct } from './use-act';

export function ReferralCards({
  workspaceId,
  referrals,
}: {
  workspaceId: string;
  /** Those waiting for the person on the network shown. */
  referrals: readonly Referral[];
}) {
  // Done or put aside here: gone at once, before the page reloads.
  const [gone, setGone] = useState<readonly string[]>([]);
  const shown = referrals.filter((r) => !gone.includes(r.referralId));
  if (!shown.length) return null;
  return (
    <section aria-labelledby="today-refer-title" className="space-y-3" data-testid="today-refer">
      <h2 id="today-refer-title" className="text-lg font-semibold tracking-tight">
        {RW.title}
        <span className="font-medium text-text-3"> · {shown.length.toLocaleString()}</span>
      </h2>
      {shown.map((r) => (
        <ReferralCard
          key={r.referralId}
          workspaceId={workspaceId}
          referral={r}
          onGone={() => setGone((g) => [...g, r.referralId])}
        />
      ))}
    </section>
  );
}

function ReferralCard({
  workspaceId,
  referral: r,
  onGone,
}: {
  workspaceId: string;
  referral: Referral;
  onGone: () => void;
}) {
  const { busy, act } = useAct();
  const [comment, setComment] = useState(r.comment);
  const [note, setNote] = useState(r.note);
  const [more, setMore] = useState(false);
  const copy = (text: string) => void copyText(text, RW.copied);
  const done = () =>
    void act('done', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.referral.done', {
          body: {
            workspaceId,
            referralId: r.referralId,
            ...(comment.trim() && comment.trim() !== r.comment ? { comment: comment.trim() } : {}),
            ...(note.trim() && note.trim() !== r.note ? { note: note.trim() } : {}),
          },
        }),
      );
      onGone();
    });
  const skip = () =>
    void act('skip', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.referral.skip', {
          body: { workspaceId, referralId: r.referralId },
        }),
      );
      onGone();
    });
  return (
    <Card className="space-y-3 p-5" data-testid={`today-refer-${r.referralId}`}>
      <div className="space-y-1">
        <h3 className="text-[15px] font-semibold">{RW.refer(r.name)}</h3>
        <p className="text-[13px] text-text-2">{RW.blurb}</p>
        {r.why ? <p className="text-[13px] text-text-3">{r.why}</p> : null}
      </div>
      <blockquote className="rounded-md border border-border bg-card-2 px-3 py-2 text-[13px] text-text-2">
        <span className="font-medium text-text">{r.writer}</span>
        {r.asks ? <span className="text-text-3"> · {RW.asks(r.asks)}</span> : null}
        <p className="mt-1 whitespace-pre-line">{more && r.postWhole ? r.postWhole : r.post}</p>
        {r.postWhole && !more ? (
          <button
            type="button"
            className="mt-1 text-[12.5px] font-medium text-accent-text hover:underline"
            onClick={() => setMore(true)}
          >
            More
          </button>
        ) : null}
      </blockquote>
      <div className="space-y-1.5">
        <label className="text-[13px] font-medium" htmlFor={`refer-comment-${r.referralId}`}>
          {RW.comment}
        </label>
        <Textarea
          id={`refer-comment-${r.referralId}`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          data-testid="today-refer-comment"
        />
        <p className="text-[12.5px] text-text-3">{RW.tag}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => copy(comment)}
            data-testid="today-refer-copy-comment"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.copy}
          </Button>
          <a
            href={r.postUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ size: 'sm', variant: 'secondary' })}
            data-testid="today-refer-open-post"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.openPost}
          </a>
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-[13px] font-medium" htmlFor={`refer-note-${r.referralId}`}>
          {RW.note(r.name)}
        </label>
        <Textarea
          id={`refer-note-${r.referralId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          data-testid="today-refer-note"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => copy(note)}
            data-testid="today-refer-copy-note"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.copy}
          </Button>
          <a
            href={r.profileUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ size: 'sm', variant: 'secondary' })}
            data-testid="today-refer-open-chat"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.openChat}
          </a>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" disabled={busy !== null} onClick={done} data-testid="today-refer-done">
          <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
          {RW.done}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={skip}
          data-testid="today-refer-skip"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          {RW.skip}
        </Button>
      </div>
    </Card>
  );
}
