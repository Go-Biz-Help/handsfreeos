'use client';
/**
 * Today's helpful post (docs/outreach.md, decision 50), at the top of the Today tab: the post the AI wrote for one of
 * the person's groups, with what it's about, and what to do by their posting choice. After their OK (the default):
 * the words to change and **OK, post it**, which OKs it and asks their computer to put it up (a `post` ask). Copying it
 * themselves: **Copy**, **Open the group** and **I posted it**. On its own: it says so, with **Not this one**. Then
 * its link once up, and who engaged; or why it was put aside. With none today, **Write a helpful post**.
 *
 * Each network's own (`platform`): on LinkedIn it goes on the person's own feed, so the card says "Your LinkedIn feed"
 * where a group's name would be, and **Open LinkedIn** in place of Open the group, by LinkedIn's posting choice.
 */
import {
  HELPFUL_STATES,
  helpfulOpenUrl,
  helpfulWhere,
  helpfulWordsOn,
  OPEN_HELPFUL_STATES,
  type HelpfulShown,
} from '@hfos/core/addons/outreach/helpful';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { Check, Copy, ExternalLink, Send, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { AskLine, latestAskOn } from './asks';
import type { Asks, HelpfulList } from './types';
import { useAct } from './use-act';

export function HelpfulCard({
  workspaceId,
  platform = 'facebook',
  helpful,
  asks,
}: {
  workspaceId: string;
  /** The network whose helpful post it is. */
  platform?: Platform;
  helpful: HelpfulList;
  asks: Asks;
}) {
  const { busy, act } = useAct();
  const H = helpfulWordsOn(platform);
  // The list has today's, then those up in the last fortnight: one still to do, else the last put aside today.
  const open = helpful.posts.find((p) =>
    (OPEN_HELPFUL_STATES as readonly string[]).includes(p.state),
  );
  const ended = helpful.posts.find((p) => p.state === 'skipped' || p.state === 'failed');
  const up = helpful.posts.filter((p) => p.state === 'posted');
  const write = () =>
    void act('write', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.helpful.ask', {
          body: { workspaceId, platform },
        }),
      );
    });
  return (
    <Card className="p-5" data-testid="today-helpful">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{H.title}</h3>
        <span className="text-[12.5px] text-text-3">{H.limit}</span>
      </div>
      {open ? (
        <Today workspaceId={workspaceId} platform={platform} post={open} asks={asks} />
      ) : ended ? (
        <Today workspaceId={workspaceId} platform={platform} post={ended} asks={asks} />
      ) : null}
      {!open && helpful.today < helpful.perDay ? (
        <Button
          size="sm"
          className="mt-3"
          disabled={busy !== null}
          onClick={write}
          data-testid="today-helpful-write"
        >
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
          {H.write}
        </Button>
      ) : null}
      {up.length ? (
        <ul className="mt-3 space-y-1.5" data-testid="today-helpful-up">
          {up.map((p) => (
            <li key={p.helpfulId} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge variant="ok">{HELPFUL_STATES.posted}</Badge>
              {p.postUrl ? (
                <a
                  href={p.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent-text hover:underline"
                >
                  {p.topic ?? p.groupName ?? 'Your post'}
                </a>
              ) : (
                <span className="font-medium">{p.topic ?? p.groupName ?? 'Your post'}</span>
              )}
              <span className="text-text-3">
                {p.groupName ? `${p.groupName} · ` : ''}
                {H.engaged(p.comments, p.reactions)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Today({
  workspaceId,
  platform,
  post,
  asks,
}: {
  workspaceId: string;
  platform: Platform;
  post: HelpfulShown;
  asks: Asks;
}) {
  const { busy, act } = useAct();
  const H = helpfulWordsOn(platform);
  const [text, setText] = useState(post.text ?? '');
  const asked = latestAskOn(asks, platform, 'post', `helpful:${post.helpfulId}`);
  const openUrl = helpfulOpenUrl({ ...post, platform });
  const place = helpfulWhere({ ...post, platform });
  const ok = () =>
    void act('ok', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.helpful.ok', {
          body: {
            workspaceId,
            helpfulId: post.helpfulId,
            ...(text.trim() && text.trim() !== post.text ? { text: text.trim() } : {}),
          },
        }),
      );
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.ask.make', {
          body: { workspaceId, platform, ask: { kind: 'post', helpfulId: post.helpfulId } },
        }),
      );
    });
  const skip = () =>
    void act('skip', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.helpful.skip', {
          body: { workspaceId, helpfulId: post.helpfulId },
        }),
      );
    });
  const posted = () =>
    void act(
      'posted',
      async () => {
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.helpful.posted', {
            body: { workspaceId, helpfulId: post.helpfulId, posted: true },
          }),
        );
      },
      H.postedDone,
    );
  const where = (
    <p className="mt-1 text-[13px] text-text-2" data-testid="today-helpful-where">
      {[place, post.topic].filter(Boolean).join(' · ')}
    </p>
  );
  if (post.state === 'drafting')
    return (
      <div data-testid="today-helpful-writing">
        {where}
        <p className="mt-2 text-[13px] text-text-2">{H.writing}</p>
      </div>
    );
  if (post.state === 'skipped' || post.state === 'failed')
    return (
      <div data-testid="today-helpful-ended">
        {where}
        <p className="mt-2 text-[13px] text-text-2">
          {HELPFUL_STATES[post.state]}
          {post.whyNot ? `: ${post.whyNot}` : '.'}
        </p>
      </div>
    );
  return (
    <div data-testid="today-helpful-post">
      {where}
      {post.state === 'draft' && post.how !== 'own' ? (
        <Textarea
          className="mt-2"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Your helpful post"
          data-testid="today-helpful-text"
        />
      ) : (
        <p className="mt-2 whitespace-pre-wrap rounded-md bg-card-2 px-3 py-2 text-[13px]">
          {post.text}
        </p>
      )}
      <p className="mt-1.5 text-[12.5px] text-text-3">
        {post.state === 'approved' ? H.waitingComputer : H.how(post.how)}
      </p>
      {asked ? (
        <AskLine workspaceId={workspaceId} asks={asks} ask={asked} className="mt-1" />
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {post.how === 'after_ok' || post.state === 'approved' ? (
          <Button
            size="sm"
            disabled={busy !== null || !text.trim()}
            onClick={ok}
            data-testid="today-helpful-ok"
          >
            <Send className="h-3.5 w-3.5" strokeWidth={1.5} />
            {H.ok}
          </Button>
        ) : null}
        {post.how === 'copy' ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void copyText(text, H.copied)}
              data-testid="today-helpful-copy"
            >
              <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
              {H.copy}
            </Button>
            {openUrl ? (
              <a
                href={openUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonClassName({ variant: 'ghost', size: 'sm' })}
                data-testid="today-helpful-open"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                {H.open}
              </a>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={posted}
              data-testid="today-helpful-posted"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
              {H.posted}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={skip}
          data-testid="today-helpful-skip"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          {H.skip}
        </Button>
      </div>
    </div>
  );
}
