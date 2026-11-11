'use client';
/**
 * One of the business's own posts, opened from the Calendar (docs/socialcontent.md, "Making posts"): its words,
 * hook, hashtags, a carousel's slides or a video's script, its pictures, where on Facebook it goes and when it goes.
 * Anyone who uses the add-on changes it, has the AI write it again or make its pictures again (designed, or
 * photo-style, decision 14), adds their own photo, OKs it (decision 15) or skips it. Changing an OK'd post takes the
 * OK back.
 */
import { localDateOf, localInstant } from '@hfos/core';
import {
  CONTENT_FORMATS,
  FACEBOOK_WHERE,
  hasPictures,
  POSTING,
  POSTING_NETWORKS,
  postText,
  type ContentFormat,
  type FacebookWhere,
  type PostingNetwork,
} from '@hfos/core/addons/socialcontent/calendar';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  SOCIALCONTENT_WORDS as W,
  clockOf,
  daysAgo,
  numbersLines,
  timeShown,
} from '@hfos/core/addons/socialcontent/words';
import { Copy, ExternalLink, ImagePlus, Trash2, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadFile } from '@/components/files/upload-zone';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
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

type Draft = {
  title: string;
  network: PostingNetwork;
  format: ContentFormat;
  words: string;
  hook: string;
  hashtags: string;
  slides: { heading: string; body: string }[];
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
    lines: p.script?.lines.join('\n') ?? '',
    shots: p.script?.shots.join('\n') ?? '',
    picture: p.picture ?? '',
    facebookWhere: [...p.facebookWhere],
    day: p.postAt ? localDateOf(Date.parse(p.postAt), timeZone) : '',
    time: p.postAt ? clockOf(p.postAt, timeZone) : '09:00',
  };
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
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const changeable = p.state !== 'posted' && p.state !== 'posting';
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
            {p.state === 'ready' && p.approvedAt
              ? W.post.approvedBy(p.approvedBy, daysAgo(p.approvedAt))
              : null}
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
                onChange={(e) => set('network', e.target.value as PostingNetwork)}
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
                {CONTENT_FORMATS.filter((f) => !(f === 'text' && d.network === 'instagram')).map(
                  (f) => (
                    <option key={f} value={f}>
                      {W.post.formats[f]}
                    </option>
                  ),
                )}
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
                      <PostPicture
                        picture={pic}
                        className="aspect-[4/5] w-full rounded-md object-cover"
                      />
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
      </SheetContent>
    </Sheet>
  );
}
