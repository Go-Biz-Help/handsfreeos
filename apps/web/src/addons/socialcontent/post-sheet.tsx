'use client';
/**
 * One of the business's own posts, opened from the Calendar (docs/socialcontent.md, "Making posts"): its words,
 * hook, hashtags, a carousel's slides or a video's script, its pictures, where on Facebook it goes and when it goes.
 * Anyone who uses the add-on changes it, has the AI write it again or make its pictures again (designed, or
 * photo-style, decision 14), adds their own photo, OKs it (decision 15) or skips it. Changing an OK'd post takes the
 * OK back. An owner or admin removes it from the calendar for good (records.archive), which opens its day.
 */
import { localDateOf, localInstant } from '@hfos/core';
import {
  CONTENT_FORMATS,
  FACEBOOK_WHERE,
  formatFor,
  hasPictures,
  isShortNetwork,
  POSTING,
  POSTING_NETWORKS,
  postLength,
  postText,
  SHORT_POSTS,
  type ContentFormat,
  type FacebookWhere,
  type PostingNetwork,
} from '@hfos/core/addons/socialcontent/calendar';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import { ANGLE_LABELS } from '@hfos/core/addons/socialcontent/variety';
import {
  SOCIALCONTENT_WORDS as W,
  clockOf,
  daysAgo,
  numbersLines,
  timeShown,
} from '@hfos/core/addons/socialcontent/words';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  ImagePlus,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadFile } from '@/components/files/upload-zone';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { useCan } from '@/components/shell/workspace-shell';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';
import { supabaseBrowser } from '@/lib/supabase/client';
import type { Content, ContentPicture } from './types';
import { useAct } from './use-act';

const REWRITE = '/v1/addons/socialcontent/actions/socialcontent.content.rewrite';
const PICTURE = '/v1/addons/socialcontent/actions/socialcontent.content.picture';

export const STATE_BADGE: Record<Content['state'], BadgeVariant> = {
  draft: 'pending',
  ready: 'ok',
  posting: 'accent',
  posted: 'ok',
  failed: 'danger',
  skipped: 'gray',
};

/** "Wed, Nov 12, 9:00 AM" in the business's time zone (core's, shared with the phone). */
export const timeIn = timeShown;

/**
 * One of a post's pictures, or the person's video, through a short-lived link from the person's own storage session.
 * A video plays with its controls only where `controls` says (the post's sheet); elsewhere it shows its first frame.
 */
export function PostPicture({
  picture,
  className,
  controls = false,
}: {
  picture: ContentPicture;
  className?: string;
  controls?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    void supabaseBrowser()
      .storage.from(picture.bucket)
      .createSignedUrl(picture.objectPath, 3600)
      .then(({ data }) => !gone && setUrl(data?.signedUrl ?? null));
    return () => {
      gone = true;
    };
  }, [picture.bucket, picture.objectPath]);
  if (!url) return null;
  return picture.mimeType?.startsWith('video/') ? (
    <video
      src={url}
      aria-label={picture.name}
      className={className}
      controls={controls}
      muted
      playsInline
      preload="metadata"
    />
  ) : (
    <img src={url} alt={picture.name} className={className} />
  );
}

/**
 * A post's pictures full screen, to see them properly (the owner, 11 Nov): the arrows, or the arrow keys, go between
 * them; Esc, ✕ or a click on the dark around it closes.
 */
export function PictureViewer({
  pictures,
  at,
  onAt,
  onClose,
}: {
  pictures: readonly ContentPicture[];
  at: number | null;
  onAt: (at: number) => void;
  onClose: () => void;
}) {
  const pic = at === null ? null : (pictures[at] ?? null);
  const many = pictures.length > 1;
  const go = (step: number) => {
    if (at !== null) onAt((at + step + pictures.length) % pictures.length);
  };
  const round =
    'flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/60';
  return (
    <DialogPrimitive.Root open={pic !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/90" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 focus:outline-none md:p-12"
          data-testid="socialcontent-picture-viewer"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          onKeyDown={(e) => {
            if (!many) return;
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              go(1);
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              go(-1);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">{W.post.viewer}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {pic ? pic.name : W.post.viewer}
          </DialogPrimitive.Description>
          {pic ? (
            <PostPicture
              key={pic.fileId}
              picture={pic}
              className="max-h-full max-w-full rounded-md object-contain"
            />
          ) : null}
          <DialogPrimitive.Close
            className={`absolute right-4 top-4 ${round}`}
            aria-label={W.post.viewerClose}
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </DialogPrimitive.Close>
          {many ? (
            <>
              <button
                type="button"
                className={`absolute left-4 top-1/2 -translate-y-1/2 ${round}`}
                aria-label={W.post.viewerPrevious}
                onClick={() => go(-1)}
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className={`absolute right-4 top-1/2 -translate-y-1/2 ${round}`}
                aria-label={W.post.viewerNext}
                onClick={() => go(1)}
              >
                <ChevronRight className="h-5 w-5" strokeWidth={1.75} />
              </button>
              <div
                className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-[13px] text-white"
                data-testid="socialcontent-picture-viewer-count"
              >
                {W.post.viewerOf((at ?? 0) + 1, pictures.length)}
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

type Draft = {
  title: string;
  network: PostingNetwork;
  format: ContentFormat;
  words: string;
  hook: string;
  hashtags: string;
  slides: { heading: string; body: string }[];
  /** The posts under the first on Threads and X (decision 41). */
  chain: string[];
  lines: string;
  shots: string;
  picture: string;
  facebookWhere: FacebookWhere[];
  day: string;
  time: string;
};

function draftOf(p: Content, timeZone: string): Draft {
  return {
    title: p.title,
    network: (POSTING_NETWORKS as readonly string[]).includes(p.network)
      ? (p.network as PostingNetwork)
      : 'instagram',
    format: p.format,
    words: p.words,
    hook: p.hook ?? '',
    hashtags: p.hashtags.join(' '),
    slides: p.slides.map((s) => ({ ...s })),
    chain: [...(p.chain ?? [])],
    lines: p.script?.lines.join('\n') ?? '',
    shots: p.script?.shots.join('\n') ?? '',
    picture: p.picture ?? '',
    facebookWhere: [...p.facebookWhere],
    day: p.postAt ? localDateOf(Date.parse(p.postAt), timeZone) : '',
    time: p.postAt ? clockOf(p.postAt, timeZone) : '09:00',
  };
}

/**
 * Asks before a post comes off the calendar for good (owners and admins: records.archive). Its record is archived, as
 * an add-on's records are never deleted, and its day opens for Fill the calendar or Write one. Opened from a post's row
 * on the Calendar and from its sheet.
 */
export function RemovePostDialog({
  workspaceId,
  post,
  onClose,
  onRemoved,
}: {
  workspaceId: string;
  post: Content | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { busy, act } = useAct();
  const remove = async () => {
    if (!post) return;
    const out = await act(
      'remove',
      () =>
        apiBrowser()
          .POST('/v1/commands/socialcontent.content.remove', {
            body: { workspaceId, postId: post.id },
          })
          .then(unwrap),
      (o) => W.post.removed(o.openDay !== null),
    );
    if (!out) return;
    onClose();
    onRemoved?.();
  };
  return (
    <Dialog open={post !== null} onOpenChange={(open) => (open || busy ? null : onClose())}>
      {post ? (
        <DialogContent title={W.post.removeTitle} description={W.post.removeAsk}>
          <p className="mt-3 truncate text-[13.5px] font-medium text-text">{post.title}</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy !== null} onClick={onClose}>
              {W.post.removeNo}
            </Button>
            <Button
              variant="danger"
              loading={busy === 'remove'}
              onClick={() => void remove()}
              data-testid="socialcontent-post-remove-yes"
            >
              {W.post.removeYes}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function PostSheet({
  workspaceId,
  post: p,
  timeZone,
  facebookPage,
  onClose,
}: {
  workspaceId: string;
  post: Content;
  timeZone: string;
  facebookPage: string | null;
  onClose: () => void;
}) {
  const { busy, act } = useAct();
  const api = apiBrowser();
  const [d, setD] = useState<Draft>(() => draftOf(p, timeZone));
  const [ask, setAsk] = useState('');
  const [pictureAsk, setPictureAsk] = useState('');
  const [viewing, setViewing] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const changeable = p.state !== 'posted' && p.state !== 'posting';
  const canRemove = useCan('records.archive');
  const [removing, setRemoving] = useState(false);
  const was = draftOf(p, timeZone);
  const dirty = JSON.stringify(d) !== JSON.stringify(was);
  // What the post changed to while it was open (pictures made, written again) shows unless it's being edited.
  useEffect(() => {
    if (!dirty) setD(draftOf(p, timeZone));
  }, [p.updatedAt]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const lines = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  const save = () =>
    act(
      'save',
      () =>
        api
          .POST('/v1/commands/socialcontent.content.save', {
            body: {
              workspaceId,
              postId: p.id,
              title: d.title.trim() || p.title,
              network: d.network,
              format: d.format,
              words: d.words,
              hook: d.hook.trim() || null,
              hashtags: d.hashtags.split(/[\s,]+/).filter(Boolean),
              slides: d.slides,
              chain: isShortNetwork(d.network) ? d.chain.filter((t) => t.trim()) : [],
              script:
                d.format === 'video' ? { lines: lines(d.lines), shots: lines(d.shots) } : null,
              picture: d.picture.trim() || null,
              facebookWhere: d.facebookWhere,
              postAt: d.day
                ? new Date(localInstant(d.day, d.time || '09:00', timeZone)).toISOString()
                : null,
            },
          })
          .then(unwrap),
      (out) => (p.state === 'ready' && out.state === 'draft' ? W.post.unOkd : W.post.saved),
    );
  const approve = (ok: boolean) =>
    act(
      ok ? 'ok' : 'unok',
      () =>
        api
          .POST('/v1/commands/socialcontent.content.approve', {
            body: { workspaceId, postId: p.id, ok },
          })
          .then(unwrap),
      ok ? W.post.approved : W.post.takenBack,
    );
  const postNow = () =>
    act(
      'now',
      () =>
        api
          .POST('/v1/commands/socialcontent.content.post_now', {
            body: { workspaceId, postId: p.id },
          })
          .then(unwrap),
      W.post.postNowAsked,
    );
  const copyWords = () =>
    void navigator.clipboard
      .writeText(postText(p.network as PostingNetwork, p.words, p.hashtags))
      .then(() => toast.success(W.post.copied))
      .catch(() => undefined);
  const skip = (skipIt: boolean) =>
    act(
      skipIt ? 'skip' : 'restore',
      () =>
        api
          .POST('/v1/commands/socialcontent.content.skip', {
            body: { workspaceId, postId: p.id, skip: skipIt },
          })
          .then(unwrap),
      skipIt ? W.post.skipped : W.post.restored,
    );
  const rewrite = () =>
    act(
      'rewrite',
      () =>
        workerPost(REWRITE, {
          workspaceId,
          input: { postId: p.id, ...(ask.trim() ? { ask: ask.trim() } : {}) },
        }),
      W.post.rewritten,
    ).then(() => setAsk(''));
  const makePicture = (way: 'design' | 'photo') =>
    act(
      `picture:${way}`,
      () =>
        workerPost(PICTURE, {
          workspaceId,
          input: { postId: p.id, way, ...(pictureAsk.trim() ? { ask: pictureAsk.trim() } : {}) },
        }),
      W.post.makeAsked,
    ).then(() => setPictureAsk(''));
  const setPictures = (fileIds: string[], key: string, done: string) =>
    act(
      key,
      () =>
        api
          .POST('/v1/commands/socialcontent.content.save', {
            body: {
              workspaceId,
              postId: p.id,
              fileIds,
              ...(fileIds.length > p.pictures.length ? { pictureWay: 'own' as const } : {}),
            },
          })
          .then(unwrap),
      done,
    );
  /** Adds the person's photos to its pictures, or puts their video in place of the one it had (part 10). */
  const upload = async (files: FileList | null, video = false) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const added: string[] = [];
      for (const f of Array.from(files))
        added.push(await uploadFile(workspaceId, 'custom_record', p.id, f));
      const kept = p.pictures
        .filter((x) => !video || !x.mimeType?.startsWith('video/'))
        .map((x) => x.fileId);
      await setPictures([...kept, ...added], 'upload', W.post.saved);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
      if (videoInput.current) videoInput.current.value = '';
    }
  };

  const making = p.pictureState === 'waiting' || p.pictureState === 'making';
  const pictures = hasPictures(d.format);
  const videos = p.pictures.filter((x) => x.mimeType?.startsWith('video/'));
  const stills = p.pictures.filter((x) => !x.mimeType?.startsWith('video/'));
  // How it did, 2 and 7 days after it went up (part 11).
  const numbers = numbersLines(p, (n) => networkName(n as PostingNetwork));
  const other = (busyKey: string) => busy !== null && busy !== busyKey;
  // The extension puts posts up on these networks (part 9); the rest are copied and posted by hand for now.
  const postsHere = (POSTING.networks as readonly string[]).includes(p.network);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        title={p.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{networkName(p.network)}</span>
            <Badge variant={STATE_BADGE[p.state]}>{W.post.states[p.state]}</Badge>
            {p.angle ? <Badge variant="accent">{ANGLE_LABELS[p.angle]}</Badge> : null}
            {p.state === 'ready' && p.approvedAt
              ? W.post.approvedBy(p.approvedBy, daysAgo(p.approvedAt))
              : null}
            {p.topic ? (
              <span className="basis-full text-[12.5px]" data-testid="socialcontent-post-topic">
                {W.post.about(p.topic.line)}
              </span>
            ) : null}
          </span>
        }
      >
        <div className="space-y-4" data-testid="socialcontent-post-sheet">
          {p.postedTo.length ? (
            <div className="space-y-1" data-testid="socialcontent-post-went">
              {p.state === 'posted' ? (
                <p className="text-[13px] font-medium text-text">
                  {W.post.postedOn(p.postedAt ? daysAgo(p.postedAt) : null)}
                </p>
              ) : null}
              {p.postedTo.map((w) =>
                w.link ? (
                  <a
                    key={w.place}
                    href={w.link}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-[13px] text-accent-text underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    {w.place === 'feed'
                      ? W.post.seeIt.feed(networkName(p.network))
                      : W.post.seeIt[w.place]}
                  </a>
                ) : (
                  <p key={w.place} className="text-[13px] text-text-2">
                    {w.place === 'feed'
                      ? W.post.wentUp.feed(networkName(p.network))
                      : W.post.wentUp[w.place]}
                  </p>
                ),
              )}
            </div>
          ) : p.postLink ? (
            <a
              href={p.postLink}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] text-accent-text underline"
            >
              {p.postLink}
            </a>
          ) : null}
          {numbers.length ? (
            <div className="space-y-1" data-testid="socialcontent-post-numbers">
              <div className="text-[13px] font-medium">{W.post.numbers.title}</div>
              {numbers.map((l) => (
                <p
                  key={l.text}
                  className={
                    l.well ? 'text-[13px] font-medium text-success-text' : 'text-[13px] text-text-2'
                  }
                >
                  {l.text}
                </p>
              ))}
            </div>
          ) : null}
          {p.failure ? (
            <div
              className="rounded-card bg-danger-soft p-3 text-[13px] text-danger-text"
              data-testid="socialcontent-post-failure"
            >
              <p>{p.failure}</p>
              {p.state === 'failed' && postsHere ? (
                <p className="mt-1 text-text-2">{W.post.tryAgain}</p>
              ) : null}
            </div>
          ) : null}

          <Field label={W.post.title} htmlFor="post-title">
            <Input
              id="post-title"
              value={d.title}
              maxLength={120}
              disabled={!changeable}
              onChange={(e) => set('title', e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={W.post.network} htmlFor="post-network">
              <Select
                id="post-network"
                value={d.network}
                disabled={!changeable}
                onChange={(e) => {
                  // A format the network doesn't take turns into one it does (no carousel on Threads or X).
                  const network = e.target.value as PostingNetwork;
                  setD((x) => ({ ...x, network, format: formatFor(network, x.format) }));
                }}
              >
                {POSTING_NETWORKS.map((n) => (
                  <option key={n} value={n}>
                    {networkName(n)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={W.post.format} htmlFor="post-format">
              <Select
                id="post-format"
                value={d.format}
                disabled={!changeable}
                onChange={(e) => set('format', e.target.value as ContentFormat)}
              >
                {CONTENT_FORMATS.filter(
                  (f) =>
                    !(f === 'text' && d.network === 'instagram') &&
                    !(f === 'carousel' && isShortNetwork(d.network)),
                ).map((f) => (
                  <option key={f} value={f}>
                    {W.post.formats[f]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={W.post.when} htmlFor="post-day" hint={d.day ? undefined : W.post.noDay}>
              <Input
                id="post-day"
                type="date"
                value={d.day}
                disabled={!changeable}
                onChange={(e) => set('day', e.target.value)}
              />
            </Field>
            <Field label={W.post.time} htmlFor="post-time">
              <Input
                id="post-time"
                type="time"
                value={d.time}
                disabled={!changeable || !d.day}
                onChange={(e) => set('time', e.target.value)}
              />
            </Field>
          </div>

          {d.network === 'facebook' ? (
            <div>
              <div className="mb-1.5 text-[13px] font-medium">{W.post.facebookWhere}</div>
              <div className="flex flex-wrap gap-4">
                {FACEBOOK_WHERE.map((w) => (
                  <Checkbox
                    key={w}
                    label={W.post.facebookWhereOptions[w]}
                    checked={d.facebookWhere.includes(w)}
                    disabled={!changeable}
                    onChange={(e) =>
                      set(
                        'facebookWhere',
                        e.target.checked
                          ? [...d.facebookWhere, w]
                          : d.facebookWhere.filter((x) => x !== w),
                      )
                    }
                  />
                ))}
              </div>
              {d.facebookWhere.includes('page') && !facebookPage ? (
                <p className="mt-1.5 text-[12.5px] text-warning-text">{W.post.needsPage}</p>
              ) : null}
            </div>
          ) : null}

          <Field label={W.post.hook} htmlFor="post-hook">
            <Input
              id="post-hook"
              value={d.hook}
              maxLength={300}
              disabled={!changeable}
              onChange={(e) => set('hook', e.target.value)}
            />
          </Field>
          <Field label={W.post.words} htmlFor="post-words">
            <Textarea
              id="post-words"
              value={d.words}
              rows={9}
              maxLength={3000}
              disabled={!changeable}
              onChange={(e) => set('words', e.target.value)}
            />
          </Field>
          <Field label={W.post.hashtags} htmlFor="post-tags" hint={W.post.hashtagsHint}>
            <Input
              id="post-tags"
              value={d.hashtags}
              disabled={!changeable}
              onChange={(e) => set('hashtags', e.target.value)}
            />
          </Field>
          {isShortNetwork(d.network) ? (
            <ShortChain
              network={d.network}
              words={d.words}
              hashtags={d.hashtags}
              chain={d.chain}
              changeable={changeable}
              onChange={(chain) => set('chain', chain)}
            />
          ) : null}

          {d.format === 'carousel' ? (
            <div className="space-y-3">
              <div className="text-[13px] font-medium">{W.post.slides}</div>
              {d.slides.map((s, i) => (
                <div key={i} className="space-y-2 rounded-card border border-border p-3">
                  <div className="flex items-center justify-between text-[12.5px] text-text-3">
                    {W.post.slide(i + 1)}
                    {changeable ? (
                      <button
                        type="button"
                        className="text-text-3 hover:text-danger-text"
                        aria-label={W.post.remove}
                        onClick={() =>
                          set(
                            'slides',
                            d.slides.filter((_, j) => j !== i),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    ) : null}
                  </div>
                  <Input
                    value={s.heading}
                    maxLength={80}
                    disabled={!changeable}
                    onChange={(e) =>
                      set(
                        'slides',
                        d.slides.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)),
                      )
                    }
                  />
                  <Textarea
                    value={s.body}
                    rows={2}
                    maxLength={260}
                    disabled={!changeable}
                    onChange={(e) =>
                      set(
                        'slides',
                        d.slides.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)),
                      )
                    }
                  />
                </div>
              ))}
              {changeable && d.slides.length < 10 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => set('slides', [...d.slides, { heading: '', body: '' }])}
                >
                  {W.post.addSlide}
                </Button>
              ) : null}
            </div>
          ) : null}

          {d.format === 'video' ? (
            <div className="space-y-3">
              <div className="text-[13px] font-medium">{W.post.script}</div>
              <Field label={W.post.lines} htmlFor="post-lines">
                <Textarea
                  id="post-lines"
                  value={d.lines}
                  rows={5}
                  disabled={!changeable}
                  onChange={(e) => set('lines', e.target.value)}
                />
              </Field>
              <Field label={W.post.shots} htmlFor="post-shots">
                <Textarea
                  id="post-shots"
                  value={d.shots}
                  rows={4}
                  disabled={!changeable}
                  onChange={(e) => set('shots', e.target.value)}
                />
              </Field>
              <div className="space-y-2" data-testid="socialcontent-post-video">
                <div className="text-[13px] font-medium">{W.post.video}</div>
                {videos.map((v) => (
                  <div key={v.fileId} className="relative w-[180px]">
                    <PostPicture
                      picture={v}
                      controls
                      className="aspect-[9/16] w-full rounded-md bg-black object-cover"
                    />
                    {changeable ? (
                      <button
                        type="button"
                        aria-label={W.post.remove}
                        className="absolute right-1 top-1 rounded-full bg-card/90 p-1 text-text-2 hover:text-danger-text"
                        disabled={busy !== null}
                        onClick={() =>
                          void setPictures(
                            p.pictures.filter((x) => x.fileId !== v.fileId).map((x) => x.fileId),
                            `remove:${v.fileId}`,
                            W.post.saved,
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    ) : null}
                  </div>
                ))}
                {changeable ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={uploading}
                      disabled={busy !== null}
                      onClick={() => videoInput.current?.click()}
                      data-testid="socialcontent-post-add-video"
                    >
                      <Video className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                      {uploading
                        ? W.post.uploading
                        : videos.length
                          ? W.post.otherVideo
                          : W.post.addVideo}
                    </Button>
                    <input
                      ref={videoInput}
                      type="file"
                      accept="video/mp4,video/quicktime,video/webm"
                      className="hidden"
                      onChange={(e) => void upload(e.target.files, true)}
                    />
                  </>
                ) : null}
                <p className="text-[12.5px] text-text-3">{W.post.videoHint}</p>
              </div>
            </div>
          ) : null}

          {pictures ? (
            <div className="space-y-3" data-testid="socialcontent-post-pictures">
              <div className="flex items-center gap-2">
                <div className="text-[13px] font-medium">{W.post.picture}</div>
                <span className="text-[12.5px] text-text-3">{W.post.ways[p.pictureWay]}</span>
              </div>
              {p.pictures.length ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {p.pictures.map((pic) => (
                    <div key={pic.fileId} className="relative w-[132px] flex-none">
                      {stills.includes(pic) ? (
                        <button
                          type="button"
                          className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                          aria-label={W.post.fullScreen(pic.name)}
                          title={W.post.fullScreen(pic.name)}
                          onClick={() => setViewing(stills.indexOf(pic))}
                          data-testid={`socialcontent-post-picture-${pic.fileId}`}
                        >
                          <PostPicture
                            picture={pic}
                            className="aspect-[4/5] w-full rounded-md object-cover"
                          />
                        </button>
                      ) : (
                        <PostPicture
                          picture={pic}
                          className="aspect-[4/5] w-full rounded-md object-cover"
                        />
                      )}
                      {changeable ? (
                        <button
                          type="button"
                          aria-label={W.post.remove}
                          className="absolute right-1 top-1 rounded-full bg-card/90 p-1 text-text-2 hover:text-danger-text"
                          disabled={busy !== null}
                          onClick={() =>
                            void setPictures(
                              p.pictures
                                .filter((x) => x.fileId !== pic.fileId)
                                .map((x) => x.fileId),
                              `remove:${pic.fileId}`,
                              W.post.saved,
                            )
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {making ? (
                <p className="text-[13px] text-text-2">{W.post.pictureStates.making}</p>
              ) : p.pictureState === 'failed' ? (
                <p className="text-[13px] text-danger-text">
                  {W.post.pictureStates.failed} {p.pictureFailure}
                </p>
              ) : null}
              <Field label={W.post.pictureShows} htmlFor="post-picture">
                <Textarea
                  id="post-picture"
                  value={d.picture}
                  rows={2}
                  maxLength={600}
                  disabled={!changeable}
                  onChange={(e) => set('picture', e.target.value)}
                />
              </Field>
              {changeable ? (
                <>
                  <Input
                    value={pictureAsk}
                    maxLength={500}
                    placeholder={W.post.makeAsk}
                    onChange={(e) => setPictureAsk(e.target.value)}
                    aria-label={W.post.makeAsk}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === 'picture:design'}
                      disabled={making || other('picture:design')}
                      onClick={() => void makePicture('design')}
                    >
                      {p.pictureWay === 'design' && p.pictures.length
                        ? W.post.makeAgain
                        : W.post.switchTo(W.post.ways.design)}
                    </Button>
                    {d.format === 'photo' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === 'picture:photo'}
                        disabled={making || other('picture:photo')}
                        onClick={() => void makePicture('photo')}
                      >
                        {p.pictureWay === 'photo' && p.pictures.length
                          ? W.post.makeAgain
                          : W.post.switchTo(W.post.ways.photo)}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={uploading}
                      disabled={busy !== null}
                      onClick={() => fileInput.current?.click()}
                    >
                      <ImagePlus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                      {uploading ? W.post.uploading : W.post.upload}
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic"
                      multiple={d.format === 'carousel'}
                      className="hidden"
                      onChange={(e) => void upload(e.target.files)}
                    />
                  </div>
                  <p className="text-[12.5px] text-text-3">
                    {d.format === 'photo' ? W.post.waysHint.photo : W.post.waysHint.design}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          {p.state === 'draft' && p.stillNeeds && !dirty ? (
            <p className="rounded-card bg-warning-soft p-3 text-[13px] text-warning-text">
              {p.stillNeeds}
            </p>
          ) : null}

          {changeable ? (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex flex-wrap gap-2">
                {dirty ? (
                  <Button
                    loading={busy === 'save'}
                    disabled={other('save')}
                    onClick={() => void save()}
                  >
                    {W.post.save}
                  </Button>
                ) : p.state === 'draft' ? (
                  <Button
                    loading={busy === 'ok'}
                    disabled={other('ok') || making}
                    onClick={() => void approve(true)}
                    data-testid="socialcontent-post-ok"
                  >
                    {W.post.approve}
                  </Button>
                ) : p.state === 'ready' || p.state === 'failed' ? (
                  <>
                    {postsHere ? (
                      <Button
                        loading={busy === 'now'}
                        disabled={other('now') || making}
                        onClick={() => void postNow()}
                        data-testid="socialcontent-post-now"
                      >
                        {W.post.postNow}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      loading={busy === 'unok'}
                      disabled={other('unok')}
                      onClick={() => void approve(false)}
                    >
                      {W.post.takeBack}
                    </Button>
                  </>
                ) : null}
                {!postsHere && !dirty ? (
                  <Button variant="ghost" onClick={copyWords}>
                    <Copy className="h-4 w-4" aria-hidden />
                    {W.post.copy}
                  </Button>
                ) : null}
                {p.state === 'skipped' ? (
                  <Button
                    variant="secondary"
                    loading={busy === 'restore'}
                    disabled={other('restore')}
                    onClick={() => void skip(false)}
                  >
                    {W.post.restore}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    loading={busy === 'skip'}
                    disabled={other('skip')}
                    onClick={() => void skip(true)}
                  >
                    {W.post.skip}
                  </Button>
                )}
                {canRemove ? (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setRemoving(true)}
                    data-testid="socialcontent-post-remove"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                    {W.post.remove}
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-0 flex-1"
                  value={ask}
                  maxLength={500}
                  placeholder={W.post.rewriteAsk}
                  onChange={(e) => setAsk(e.target.value)}
                  aria-label={W.post.rewriteAsk}
                />
                <Button
                  variant="secondary"
                  loading={busy === 'rewrite'}
                  disabled={other('rewrite')}
                  onClick={() => void rewrite()}
                >
                  {W.post.rewrite}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <PictureViewer
          pictures={stills}
          at={viewing}
          onAt={setViewing}
          onClose={() => setViewing(null)}
        />
        <RemovePostDialog
          workspaceId={workspaceId}
          post={removing ? p : null}
          onClose={() => setRemoving(false)}
          onRemoved={onClose}
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * On Threads and X (decision 41): how many characters the words and tags take of what the network allows, and the
 * posts that go under the first one for a longer tip, up to 4.
 */
function ShortChain({
  network,
  words,
  hashtags,
  chain,
  changeable,
  onChange,
}: {
  network: 'threads' | 'x';
  words: string;
  hashtags: string;
  chain: string[];
  changeable: boolean;
  onChange: (chain: string[]) => void;
}) {
  const most = POSTING.textMost[network];
  const used = postLength(words, hashtags.split(/[\s,]+/).filter(Boolean));
  return (
    <div className="space-y-2" data-testid="socialcontent-post-chain">
      <p
        className={`text-[12.5px] ${used > most ? 'text-danger-text' : 'text-text-3'}`}
        data-testid="socialcontent-post-characters"
      >
        {W.post.characters(used, most)}
      </p>
      <div>
        <div className="text-[13px] font-medium">{W.post.chain}</div>
        <p className="text-[12.5px] text-text-3">{W.post.chainHint(networkName(network))}</p>
      </div>
      {chain.map((t, i) => (
        <div key={i} className="space-y-1 rounded-card border border-border p-3">
          <div className="flex items-center justify-between text-[12.5px] text-text-3">
            <span>
              {W.post.chainPost(i + 2)}
              {' · '}
              <span className={t.trim().length > most ? 'text-danger-text' : undefined}>
                {t.trim().length}/{most}
              </span>
            </span>
            {changeable ? (
              <button
                type="button"
                className="text-text-3 hover:text-danger-text"
                aria-label={W.post.removeChainPost(i + 2)}
                onClick={() => onChange(chain.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
          <Textarea
            value={t}
            rows={3}
            maxLength={most}
            disabled={!changeable}
            aria-label={W.post.chainPost(i + 2)}
            data-testid={`socialcontent-post-chain-${i}`}
            onChange={(e) => onChange(chain.map((x, j) => (j === i ? e.target.value : x)))}
          />
        </div>
      ))}
      {changeable && chain.length < SHORT_POSTS.chainMost ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="socialcontent-post-chain-add"
          onClick={() => onChange([...chain, ''])}
        >
          {W.post.addChainPost}
        </Button>
      ) : null}
    </div>
  );
}
