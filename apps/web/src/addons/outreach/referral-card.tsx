'use client';
/**
 * Refer someone you've talked with (docs/outreach.md, decision 174), near the top of the Today tab: a post asking for
 * a recommendation of what someone the person talked with does, with who and why, the comment naming them and the
 * heads-up to them, as the AI wrote them. Both wait for the person (the owner's 9a): each text to change and copy,
 * **Open the post** and **Open their chat**, then **I did both**, which notes it with the words as they stand, or
 * **Not this one**, which puts it aside for good. The words are core's (`REFER_WORDS`).
 *
 * Done for the person (decision 185): on Facebook **Do it for me** has their computer post it and send the heads-up,
 * as the words stand; under Autopilot one shows as done soon, with nothing to do. One their computer couldn't finish
 * says why. A referral within a week of their last heads-up is the comment alone. Below, the ask after two: a short
 * note asking someone referred twice to send people the person's way too, to copy, send for them, or put aside.
 */
import {
  REFER_WORDS as RW,
  type ReferAsk,
  type Referral,
} from '@hfos/core/addons/outreach/referrals';
import { Bot, Check, Copy, ExternalLink, X } from 'lucide-react';
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
  asks = [],
}: {
  workspaceId: string;
  /** Those waiting for the person on the network shown, or done for them soon. */
  referrals: readonly Referral[];
  /** The asks after two (decision 185) on the network shown. */
  asks?: readonly ReferAsk[];
}) {
  // Done or put aside here: gone at once, before the page reloads.
  const [gone, setGone] = useState<readonly string[]>([]);
  const shown = referrals.filter((r) => !gone.includes(r.referralId));
  const asking = asks.filter((a) => !gone.includes(a.askId));
  if (!shown.length && !asking.length) return null;
  return (
    <>
      {shown.length ? (
        <section
          aria-labelledby="today-refer-title"
          className="space-y-3"
          data-testid="today-refer"
        >
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
      ) : null}
      {asking.length ? (
        <section
          aria-labelledby="today-refer-ask-title"
          className="space-y-3"
          data-testid="today-refer-asks"
        >
          <h2 id="today-refer-ask-title" className="text-lg font-semibold tracking-tight">
            {RW.askTitle}
            <span className="font-medium text-text-3"> · {asking.length.toLocaleString()}</span>
          </h2>
          {asking.map((a) => (
            <ReferAskCard
              key={a.askId}
              workspaceId={workspaceId}
              ask={a}
              onGone={() => setGone((g) => [...g, a.askId])}
            />
          ))}
        </section>
      ) : null}
    </>
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
  const [note, setNote] = useState(r.note ?? '');
  const [more, setMore] = useState(false);
  // Do it for me pressed here: their computer has it now.
  const [approved, setApproved] = useState(r.state === 'approved');
  const copy = (text: string) => void copyText(text, RW.copied);
  const hasNote = r.note !== null;
  const changed = {
    ...(comment.trim() && comment.trim() !== r.comment ? { comment: comment.trim() } : {}),
    ...(hasNote && note.trim() && note.trim() !== r.note ? { note: note.trim() } : {}),
  };
  const done = () =>
    void act('done', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.referral.done', {
          body: { workspaceId, referralId: r.referralId, ...changed },
        }),
      );
      onGone();
    });
  const forMe = () =>
    void act('approve', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.referral.approve', {
          body: { workspaceId, referralId: r.referralId, ...changed },
        }),
      );
      setApproved(true);
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
      {approved ? (
        <p
          className="rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent-text"
          data-testid="today-refer-approved"
        >
          {RW.approved(r.name, hasNote)}
        </p>
      ) : r.needs ? (
        <p
          className="rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning-text"
          data-testid="today-refer-needs"
        >
          {r.posted ? RW.posted(r.name, r.needs) : RW.needs(r.needs)}
        </p>
      ) : null}
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
      {hasNote ? (
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
      ) : (
        <p className="text-[12.5px] text-text-3" data-testid="today-refer-no-note">
          {RW.noNote(r.name)}
        </p>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {r.forYou && !approved ? (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={forMe}
            data-testid="today-refer-for-me"
          >
            <Bot className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.forYou}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={r.forYou && !approved ? 'secondary' : 'primary'}
          disabled={busy !== null}
          onClick={done}
          data-testid="today-refer-done"
        >
          <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
          {hasNote ? RW.done : RW.doneComment}
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

/**
 * The ask after two (decision 185): the note to someone the person referred twice, asking if they'd send people their
 * way too, or have a quick call. To change and copy with **Open their chat** and **I sent it**; on Facebook **Do it for
 * me** has their computer send it; **Don't ask them** puts it aside for good.
 */
function ReferAskCard({
  workspaceId,
  ask: a,
  onGone,
}: {
  workspaceId: string;
  ask: ReferAsk;
  onGone: () => void;
}) {
  const { busy, act } = useAct();
  const [text, setText] = useState(a.text);
  const [approved, setApproved] = useState(a.state === 'approved');
  const answer = (how: 'approve' | 'done' | 'skip') =>
    void act(how, async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.refer_ask.answer', {
          body: {
            workspaceId,
            askId: a.askId,
            answer: how,
            ...(how !== 'skip' && text.trim() && text.trim() !== a.text
              ? { text: text.trim() }
              : {}),
          },
        }),
      );
      if (how === 'approve') setApproved(true);
      else onGone();
    });
  return (
    <Card className="space-y-3 p-5" data-testid={`today-refer-ask-${a.askId}`}>
      <div className="space-y-1">
        <h3 className="text-[15px] font-semibold">{a.name}</h3>
        <p className="text-[13px] text-text-2">{RW.askBlurb(a.name, a.referred)}</p>
      </div>
      {approved ? (
        <p
          className="rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent-text"
          data-testid="today-refer-ask-approved"
        >
          {RW.askApproved(a.name)}
        </p>
      ) : a.needs ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning-text">
          {RW.askNeeds(a.needs)}
        </p>
      ) : null}
      <div className="space-y-1.5">
        <label className="text-[13px] font-medium" htmlFor={`refer-ask-${a.askId}`}>
          {RW.askText(a.name)}
        </label>
        <Textarea
          id={`refer-ask-${a.askId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          data-testid="today-refer-ask-text"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void copyText(text, RW.copied)}
            data-testid="today-refer-ask-copy"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.copy}
          </Button>
          <a
            href={a.profileUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ size: 'sm', variant: 'secondary' })}
            data-testid="today-refer-ask-open-chat"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.openChat}
          </a>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {a.forYou && !approved ? (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => answer('approve')}
            data-testid="today-refer-ask-for-me"
          >
            <Bot className="h-3.5 w-3.5" strokeWidth={1.5} />
            {RW.forYou}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={a.forYou && !approved ? 'secondary' : 'primary'}
          disabled={busy !== null}
          onClick={() => answer('done')}
          data-testid="today-refer-ask-done"
        >
          <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
          {RW.askDone}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => answer('skip')}
          data-testid="today-refer-ask-skip"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          {RW.askSkip}
        </Button>
      </div>
    </Card>
  );
}
