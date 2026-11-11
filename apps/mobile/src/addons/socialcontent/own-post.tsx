import {
  addDays,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  localDateOf,
  localInstant,
} from '@hfos/core';
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
import type { Content, ContentPicture } from '@hfos/core/addons/socialcontent/content-shapes';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  SOCIALCONTENT_WORDS as W,
  clockOf,
  clockShown,
  daysAgo,
  dayShown,
  numbersLines,
} from '@hfos/core/addons/socialcontent/words';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as React from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { change } from '@/changes';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImagePlus,
  Play,
  Share as ShareIcon,
  Video,
  X,
} from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { workerPost } from '@/lib/worker';
import { signedUrl } from '@/inbox/storage';

import {
  Group,
  NeedsSignal,
  Note,
  openOutside,
  useAct,
  useSocialcontentAnswer,
  useSocialcontentContext,
} from './kit';

/**
 * One of the business's own posts on the phone, as the web's sheet (docs/socialcontent.md, "Making posts", "Posting"
 * and part 12): where it went up and how it did, why it didn't post, its words, hook, hashtags, a carousel's slides or
 * a video's script, its pictures or the person's video, where on Facebook it goes and when. Anyone who uses the add-on
 * changes it, has the AI write it again or make its picture again, adds their own photos or video from the phone, OKs
 * it, puts it up now, or skips it. Changing an OK'd post takes the OK back. It opens at the web's own address
 * (`calendar?post=<id>`), and needs signal.
 */

const REWRITE = '/v1/addons/socialcontent/actions/socialcontent.content.rewrite';
const PICTURE = '/v1/addons/socialcontent/actions/socialcontent.content.picture';

/** How each state looks, as on the web. */
export const STATE_BADGE: Record<
  Content['state'],
  'pending' | 'ok' | 'accent' | 'danger' | 'gray'
> = {
  draft: 'pending',
  ready: 'ok',
  posting: 'accent',
  posted: 'ok',
  failed: 'danger',
  skipped: 'gray',
};

/** The days a post can be put on: today and the next 13, as the Calendar shows. */
const DAYS_AHEAD = 14;
/** Its times, every half hour. */
const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
);

const isVideo = (p: ContentPicture) => !!p.mimeType?.startsWith('video/');
const networkNameOf = (n: string) => networkName(n as PostingNetwork);

/** One of a post's pictures, through a short-lived link (with signal); a video shows a play mark, opening it. */
export function PostPictureTile({
  picture,
  className,
  fit = 'cover',
}: {
  picture: ContentPicture;
  className?: string;
  /** 'contain' shows all of it, as full screen does. */
  fit?: 'cover' | 'contain';
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let gone = false;
    void signedUrl(picture.bucket, picture.objectPath).then((u) => !gone && setUrl(u));
    return () => {
      gone = true;
    };
  }, [picture.bucket, picture.objectPath]);
  if (isVideo(picture))
    return (
      <Pressable
        role="button"
        onPress={() => openOutside(url)}
        disabled={!url}
        accessibilityLabel={`${W.post.video}: ${picture.name}`}
        className={cn('size-full items-center justify-center bg-black', className)}
      >
        <Icon as={Play} className="size-6 text-white" />
      </Pressable>
    );
  return url ? (
    <Image
      source={{ uri: url }}
      accessibilityLabel={picture.name}
      accessibilityIgnoresInvertColors
      className={cn('size-full', className)}
      resizeMode={fit}
    />
  ) : null;
}

/**
 * A post's pictures full screen, to see them properly (the owner, 11 Nov): swipe between them, pinch to zoom in on
 * iPhone, ✕ or Back closes.
 */
export function PictureViewer({
  pictures,
  at,
  onClose,
}: {
  pictures: readonly ContentPicture[];
  at: number | null;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = React.useState(at ?? 0);
  const pager = React.useRef<ScrollView>(null);
  React.useEffect(() => {
    if (at === null) return;
    setShown(at);
    // Opened on the picture pressed.
    requestAnimationFrame(() => pager.current?.scrollTo({ x: at * width, animated: false }));
  }, [at, width]);
  const go = (to: number) => {
    setShown(to);
    pager.current?.scrollTo({ x: to * width, animated: true });
  };
  const many = pictures.length > 1;
  const round = 'size-10 items-center justify-center rounded-full bg-white/20';
  return (
    <Modal
      visible={at !== null && pictures.length > 0}
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      testID="socialcontent-picture-viewer"
    >
      <View className="flex-1 bg-black">
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: (at ?? 0) * width, y: 0 }}
          onMomentumScrollEnd={(e) =>
            setShown(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width)))
          }
        >
          {pictures.map((pic) => (
            <ScrollView
              key={pic.fileId}
              style={{ width, height }}
              contentContainerStyle={{ width, height }}
              maximumZoomScale={3}
              minimumZoomScale={1}
              centerContent
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              testID={`socialcontent-picture-viewer-${pic.fileId}`}
            >
              <PostPictureTile picture={pic} fit="contain" />
            </ScrollView>
          ))}
        </ScrollView>
        <Pressable
          role="button"
          accessibilityLabel={W.post.viewerClose}
          hitSlop={8}
          onPress={onClose}
          className={cn('absolute right-4', round)}
          style={{ top: insets.top + 12 }}
          testID="socialcontent-picture-viewer-close"
        >
          <Icon as={X} className="size-5 text-white" />
        </Pressable>
        {many ? (
          <View
            className="absolute inset-x-0 flex-row items-center justify-center gap-4"
            style={{ bottom: insets.bottom + 16 }}
            pointerEvents="box-none"
          >
            <Pressable
              role="button"
              accessibilityLabel={W.post.viewerPrevious}
              disabled={shown === 0}
              onPress={() => go(shown - 1)}
              className={cn(round, shown === 0 && 'opacity-40')}
              testID="socialcontent-picture-viewer-previous"
            >
              <Icon as={ChevronLeft} className="size-5 text-white" />
            </Pressable>
            <Text className="text-[14px] text-white" testID="socialcontent-picture-viewer-count">
              {W.post.viewerOf(shown + 1, pictures.length)}
            </Text>
            <Pressable
              role="button"
              accessibilityLabel={W.post.viewerNext}
              disabled={shown >= pictures.length - 1}
              onPress={() => go(shown + 1)}
              className={cn(round, shown >= pictures.length - 1 && 'opacity-40')}
              testID="socialcontent-picture-viewer-next"
            >
              <Icon as={ChevronRight} className="size-5 text-white" />
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/** What's changed on the post while it's open: its fields as the person types. */
export interface PostDraft {
  readonly title: string;
  readonly network: PostingNetwork;
  readonly format: ContentFormat;
  readonly words: string;
  readonly hook: string;
  readonly hashtags: string;
  readonly slides: readonly { heading: string; body: string }[];
  readonly lines: string;
  readonly shots: string;
  readonly facebookWhere: readonly FacebookWhere[];
  /** "YYYY-MM-DD" in the business's zone, or '' for no day yet. */
  readonly day: string;
  readonly time: string;
}

export function draftOf(p: Content, timeZone: string): PostDraft {
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
    facebookWhere: [...p.facebookWhere],
    day: p.postAt ? localDateOf(Date.parse(p.postAt), timeZone) : '',
    time: p.postAt ? clockOf(p.postAt, timeZone) : '09:00',
  };
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** What saving sends: the post's fields as `socialcontent.content.save` takes them. */
export function saveInput(p: Content, d: PostDraft, timeZone: string) {
  return {
    postId: p.id,
    title: d.title.trim() || p.title,
    network: d.network,
    format: d.format,
    words: d.words,
    hook: d.hook.trim() || null,
    hashtags: d.hashtags.split(/[\s,]+/).filter(Boolean),
    slides: d.slides.map((s) => ({ ...s })),
    script: d.format === 'video' ? { lines: lines(d.lines), shots: lines(d.shots) } : null,
    facebookWhere: [...d.facebookWhere],
    postAt: d.day ? new Date(localInstant(d.day, d.time || '09:00', timeZone)).toISOString() : null,
  };
}

/** What the post's screen does: each press, as the screen runs it. */
export interface PostActions {
  save(d: PostDraft): Promise<unknown>;
  approve(ok: boolean): void;
  postNow(): void;
  skip(skipIt: boolean): void;
  rewrite(ask: string): void;
  makePicture(way: 'design' | 'photo', ask: string): void;
  /** Adds the person's photos from the phone, or puts their video in place of the one it had. */
  add(video: boolean): void;
  remove(fileId: string): void;
  share(): void;
}

export function PostScreen({ postId }: { postId: string }) {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const answer = useSocialcontentAnswer<{
    post: Content;
    timeZone: string;
    facebookPage: string | null;
  }>(
    async () => {
      const [post, cal] = await Promise.all([
        api
          .POST('/v1/queries/socialcontent.content.get', { body: { workspaceId: ws, postId } })
          .then(unwrap),
        // Its time zone and the Page's link, as the Calendar has them (no days asked: just today).
        api
          .POST('/v1/queries/socialcontent.calendar.get', { body: { workspaceId: ws, days: 1 } })
          .then(unwrap),
      ]);
      return { post, timeZone: cal.timeZone, facebookPage: cal.facebookPage };
    },
    `socialcontent-post:${ws}:${postId}`,
    W.calendar.title,
    // Pictures being made and a post going up show as they're done.
    { everySeconds: 15 },
  );
  const { busy, act } = useAct(answer.reload);
  const [adding, setAdding] = React.useState(false);
  const p = answer.data?.post ?? null;
  const tz = answer.data?.timeZone ?? 'UTC';

  const actions: PostActions = {
    save: (d) =>
      act(
        'save',
        async () =>
          (await change('socialcontent.content.save', { workspaceId: ws, ...saveInput(p!, d, tz) }))
            .output,
        (out) => (p?.state === 'ready' && out?.state === 'draft' ? W.post.unOkd : W.post.saved),
      ),
    approve: (ok) =>
      void act(
        ok ? 'ok' : 'unok',
        async () =>
          (await change('socialcontent.content.approve', { workspaceId: ws, postId, ok })).output,
        ok ? W.post.approved : W.post.takenBack,
      ),
    postNow: () =>
      void act(
        'now',
        async () =>
          (await change('socialcontent.content.post_now', { workspaceId: ws, postId })).output,
        W.post.postNowAsked,
      ),
    skip: (skipIt) =>
      void act(
        skipIt ? 'skip' : 'restore',
        async () =>
          (await change('socialcontent.content.skip', { workspaceId: ws, postId, skip: skipIt }))
            .output,
        skipIt ? W.post.skipped : W.post.restored,
      ),
    rewrite: (ask) =>
      void act(
        'rewrite',
        () =>
          workerPost(REWRITE, {
            workspaceId: ws,
            input: { postId, ...(ask.trim() ? { ask: ask.trim() } : {}) },
          }),
        W.post.rewritten,
      ),
    makePicture: (way, ask) =>
      void act(
        `picture:${way}`,
        () =>
          workerPost(PICTURE, {
            workspaceId: ws,
            input: { postId, way, ...(ask.trim() ? { ask: ask.trim() } : {}) },
          }),
        W.post.makeAsked,
      ),
    add: (video) => {
      if (!p) return;
      setAdding(true);
      void act(
        'upload',
        async () => {
          const added = await pickAndUpload(ws, postId, video, p.format === 'carousel');
          if (!added.length) return null;
          const kept = p.pictures.filter((x) => !video || !isVideo(x)).map((x) => x.fileId);
          return (
            await change('socialcontent.content.save', {
              workspaceId: ws,
              postId,
              fileIds: [...kept, ...added],
              ...(video ? {} : { pictureWay: 'own' as const }),
            })
          ).output;
        },
        (out) => (out ? W.post.saved : ''),
      ).finally(() => setAdding(false));
    },
    remove: (fileId) =>
      void act(
        `remove:${fileId}`,
        async () =>
          (
            await change('socialcontent.content.save', {
              workspaceId: ws,
              postId,
              fileIds: (p?.pictures ?? []).filter((x) => x.fileId !== fileId).map((x) => x.fileId),
            })
          ).output,
        W.post.saved,
      ),
    share: () => {
      if (!p) return;
      void Share.share({ message: postText(p.network as PostingNetwork, p.words, p.hashtags) });
    },
  };

  return (
    <PostBody
      post={p}
      timeZone={tz}
      facebookPage={answer.data?.facebookPage ?? null}
      error={answer.error}
      online={ctx.online}
      busy={busy}
      uploading={adding}
      onRetry={answer.reload}
      actions={actions}
    />
  );
}

/**
 * Picks photos (or one video) from the phone and keeps each as a file on the post: a photo shrunk to a JPEG about
 * 2,048 px on its longest side, a video as it is, up to 25 MB. The ids of the files kept.
 */
async function pickAndUpload(
  workspaceId: string,
  postId: string,
  video: boolean,
  several: boolean,
): Promise<string[]> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: video ? ['videos'] : ['images'],
    allowsMultipleSelection: !video && several,
    selectionLimit: video ? 1 : several ? 10 : 1,
    quality: 1,
    exif: false,
  });
  if (picked.canceled) return [];
  const ids: string[] = [];
  for (const asset of picked.assets) {
    let uri = asset.uri;
    let mimeType = asset.mimeType ?? (video ? 'video/mp4' : 'image/jpeg');
    let name = asset.fileName ?? (video ? 'video.mp4' : 'photo.jpg');
    if (!video) {
      const longest = Math.max(asset.width, asset.height);
      const context = ImageManipulator.manipulate(asset.uri);
      if (longest > 2048)
        context.resize(asset.width >= asset.height ? { width: 2048 } : { height: 2048 });
      const saved = await (
        await context.renderAsync()
      ).saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.85,
      });
      uri = saved.uri;
      mimeType = 'image/jpeg';
      name = name.replace(/\.[^.]+$/, '') + '.jpg';
    }
    if (!(ATTACHMENT_TYPES as readonly string[]).includes(mimeType))
      throw new Error(`${name}: that kind of file can’t go on a post. Pick an MP4 or MOV video.`);
    const file = new File(uri);
    const size = file.size ?? asset.fileSize ?? 0;
    if (size > ATTACHMENT_MAX_BYTES)
      throw new Error(
        `${name} is over 25 MB. Make it smaller first (most phones offer that when sharing it), then add it.`,
      );
    const bytes = await file.bytes();
    // Straight to HandsFreeOS with signal, not through the phone's queue: the post needs the file's id now.
    const { bucket, objectPath, fileId } = unwrap(
      await api.POST('/v1/commands/file.begin_upload', {
        body: {
          workspaceId,
          recordType: 'custom_record',
          recordId: postId,
          name: name.slice(0, 200),
          mimeType: mimeType as (typeof ATTACHMENT_TYPES)[number],
          sizeBytes: bytes.byteLength,
        },
      }),
    );
    const { error } = await supabase.storage
      .from(bucket)
      .upload(objectPath, bytes, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`${name} didn’t upload. Try again in a minute.`);
    unwrap(await api.POST('/v1/commands/file.confirm', { body: { workspaceId, fileId } }));
    ids.push(fileId);
  }
  return ids;
}

export function PostBody({
  post: p,
  timeZone,
  facebookPage,
  error,
  online,
  busy,
  uploading,
  onRetry,
  actions,
}: {
  post: Content | null;
  timeZone: string;
  facebookPage: string | null;
  error: string | null;
  online: boolean;
  busy: string | null;
  uploading: boolean;
  onRetry: () => void;
  actions: PostActions;
}) {
  const [d, setD] = React.useState<PostDraft | null>(p ? draftOf(p, timeZone) : null);
  const [ask, setAsk] = React.useState('');
  const [pictureAsk, setPictureAsk] = React.useState('');
  const [viewing, setViewing] = React.useState<number | null>(null);
  const was = p ? draftOf(p, timeZone) : null;
  const dirty = !!d && !!was && JSON.stringify(d) !== JSON.stringify(was);
  // What the post changed to while it was open (pictures made, written again) shows unless it's being edited.
  React.useEffect(() => {
    if (p && !dirty) setD(draftOf(p, timeZone));
  }, [p?.updatedAt, p?.id, timeZone]);

  if (!p || !d)
    return (
      <Screen title={W.calendar.title} leading="back" testID="socialcontent-post-screen">
        {error ? (
          <NeedsSignal words={error} onRetry={onRetry} testID="socialcontent-post-needs-signal" />
        ) : null}
      </Screen>
    );

  const set = <K extends keyof PostDraft>(k: K, v: PostDraft[K]) =>
    setD((x) => (x ? { ...x, [k]: v } : x));
  const changeable = p.state !== 'posted' && p.state !== 'posting';
  const other = (key: string) => !online || (busy !== null && busy !== key);
  const making = p.pictureState === 'waiting' || p.pictureState === 'making';
  const pictures = hasPictures(d.format);
  const videos = p.pictures.filter(isVideo);
  const stills = p.pictures.filter((x) => !isVideo(x));
  const numbers = numbersLines(p, networkNameOf);
  const postsHere = (POSTING.networks as readonly string[]).includes(p.network);
  const today = localDateOf(Date.now(), timeZone);
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));
  if (d.day && !days.includes(d.day)) days.unshift(d.day);

  return (
    <Screen title={p.title} leading="back" testID="socialcontent-post-screen">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-[13px] text-text-3">{networkName(p.network)}</Text>
        <Badge variant={STATE_BADGE[p.state]}>{W.post.states[p.state]}</Badge>
        {p.state === 'ready' && p.approvedAt ? (
          <Text className="text-[12.5px] text-text-3">
            {W.post.approvedBy(p.approvedBy, daysAgo(p.approvedAt))}
          </Text>
        ) : null}
      </View>

      {p.postedTo.length ? (
        <Card className="gap-2 p-4" testID="socialcontent-post-went">
          {p.state === 'posted' ? (
            <Text className="text-[13.5px] font-semibold">
              {W.post.postedOn(p.postedAt ? daysAgo(p.postedAt) : null)}
            </Text>
          ) : null}
          {p.postedTo.map((w) =>
            w.link ? (
              <Button
                key={w.place}
                size="sm"
                variant="ghost"
                icon={ExternalLink}
                className="self-start"
                onPress={() => openOutside(w.link)}
                testID={`socialcontent-post-see-${w.place}`}
              >
                {w.place === 'feed'
                  ? W.post.seeIt.feed(networkName(p.network))
                  : W.post.seeIt[w.place]}
              </Button>
            ) : (
              <Note key={w.place}>
                {w.place === 'feed'
                  ? W.post.wentUp.feed(networkName(p.network))
                  : W.post.wentUp[w.place]}
              </Note>
            ),
          )}
        </Card>
      ) : null}

      {numbers.length ? (
        <Card className="gap-1.5 p-4" testID="socialcontent-post-numbers">
          <Text className="text-[14px] font-semibold">{W.post.numbers.title}</Text>
          {numbers.map((l) => (
            <Text
              key={l.text}
              className={cn(
                'text-[13px] leading-[18px]',
                l.well ? 'font-semibold text-success-text' : 'text-text-2',
              )}
            >
              {l.text}
            </Text>
          ))}
        </Card>
      ) : null}

      {p.failure ? (
        <Card
          className="gap-1 border-danger-soft bg-danger-soft/40 p-4"
          testID="socialcontent-post-failure"
        >
          <Text className="text-[13.5px] leading-[19px] text-danger-text">{p.failure}</Text>
          {p.state === 'failed' && postsHere ? <Note>{W.post.tryAgain}</Note> : null}
        </Card>
      ) : null}

      <Card className="gap-3 p-4">
        <Field label={W.post.title}>
          <Input
            value={d.title}
            maxLength={120}
            editable={changeable}
            onChangeText={(v) => set('title', v)}
            testID="socialcontent-post-title"
          />
        </Field>
        <Field label={W.post.network}>
          <Chips>
            {POSTING_NETWORKS.map((n) => (
              <FilterChip
                key={n}
                label={networkName(n)}
                on={d.network === n}
                disabled={!changeable}
                onPress={() => set('network', n)}
                testID={`socialcontent-post-network-${n}`}
              />
            ))}
          </Chips>
        </Field>
        <Field label={W.post.format}>
          <Chips>
            {CONTENT_FORMATS.filter((f) => !(f === 'text' && d.network === 'instagram')).map(
              (f) => (
                <FilterChip
                  key={f}
                  label={W.post.formats[f]}
                  on={d.format === f}
                  disabled={!changeable}
                  onPress={() => set('format', f)}
                  testID={`socialcontent-post-format-${f}`}
                />
              ),
            )}
          </Chips>
        </Field>
        <Field label={W.post.when} hint={d.day ? null : W.post.noDay}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-1.5"
          >
            {days.map((day) => (
              <FilterChip
                key={day}
                label={dayShown(day, today)}
                on={d.day === day}
                disabled={!changeable}
                onPress={() => set('day', d.day === day ? '' : day)}
                testID={`socialcontent-post-day-${day}`}
              />
            ))}
          </ScrollView>
        </Field>
        {d.day ? (
          <Field label={W.post.time}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-1.5"
              contentOffset={{ x: 17 * 80, y: 0 }}
            >
              {TIMES.map((t) => (
                <FilterChip
                  key={t}
                  label={clockShown(t)}
                  on={d.time === t}
                  disabled={!changeable}
                  onPress={() => set('time', t)}
                  testID={`socialcontent-post-time-${t}`}
                />
              ))}
            </ScrollView>
          </Field>
        ) : null}
        {d.network === 'facebook' ? (
          <Field
            label={W.post.facebookWhere}
            hint={d.facebookWhere.includes('page') && !facebookPage ? W.post.needsPage : null}
            warn
          >
            <Chips>
              {FACEBOOK_WHERE.map((w) => (
                <FilterChip
                  key={w}
                  label={W.post.facebookWhereOptions[w]}
                  on={d.facebookWhere.includes(w)}
                  disabled={!changeable}
                  onPress={() =>
                    set(
                      'facebookWhere',
                      d.facebookWhere.includes(w)
                        ? d.facebookWhere.filter((x) => x !== w)
                        : [...d.facebookWhere, w],
                    )
                  }
                  testID={`socialcontent-post-where-${w}`}
                />
              ))}
            </Chips>
          </Field>
        ) : null}
      </Card>

      <Card className="gap-3 p-4">
        <Field label={W.post.hook}>
          <Input
            value={d.hook}
            maxLength={300}
            editable={changeable}
            onChangeText={(v) => set('hook', v)}
            testID="socialcontent-post-hook"
          />
        </Field>
        <Field label={W.post.words}>
          <Input
            value={d.words}
            maxLength={3000}
            multiline
            editable={changeable}
            className="min-h-[180px] py-2.5"
            textAlignVertical="top"
            onChangeText={(v) => set('words', v)}
            testID="socialcontent-post-words"
          />
        </Field>
        <Field label={W.post.hashtags} hint={W.post.hashtagsHint}>
          <Input
            value={d.hashtags}
            editable={changeable}
            autoCapitalize="none"
            onChangeText={(v) => set('hashtags', v)}
            testID="socialcontent-post-hashtags"
          />
        </Field>
      </Card>

      {d.format === 'carousel' ? (
        <Card className="gap-3 p-4" testID="socialcontent-post-slides">
          <Group>{W.post.slides}</Group>
          {d.slides.map((s, i) => (
            <View key={i} className="gap-2 rounded-card border border-border p-3">
              <View className="flex-row items-center">
                <Text className="flex-1 text-[12.5px] text-text-3">{W.post.slide(i + 1)}</Text>
                {changeable ? (
                  <Pressable
                    role="button"
                    accessibilityLabel={W.post.remove}
                    hitSlop={8}
                    onPress={() =>
                      set(
                        'slides',
                        d.slides.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Icon as={X} className="size-4 text-text-3" />
                  </Pressable>
                ) : null}
              </View>
              <Input
                value={s.heading}
                maxLength={80}
                editable={changeable}
                onChangeText={(v) =>
                  set(
                    'slides',
                    d.slides.map((x, j) => (j === i ? { ...x, heading: v } : x)),
                  )
                }
              />
              <Input
                value={s.body}
                maxLength={260}
                multiline
                editable={changeable}
                className="min-h-[64px] py-2.5"
                textAlignVertical="top"
                onChangeText={(v) =>
                  set(
                    'slides',
                    d.slides.map((x, j) => (j === i ? { ...x, body: v } : x)),
                  )
                }
              />
            </View>
          ))}
          {changeable && d.slides.length < 10 ? (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onPress={() => set('slides', [...d.slides, { heading: '', body: '' }])}
            >
              {W.post.addSlide}
            </Button>
          ) : null}
        </Card>
      ) : null}

      {d.format === 'video' ? (
        <Card className="gap-3 p-4" testID="socialcontent-post-video">
          <Group>{W.post.script}</Group>
          <Field label={W.post.lines}>
            <Input
              value={d.lines}
              multiline
              editable={changeable}
              className="min-h-[110px] py-2.5"
              textAlignVertical="top"
              onChangeText={(v) => set('lines', v)}
            />
          </Field>
          <Field label={W.post.shots}>
            <Input
              value={d.shots}
              multiline
              editable={changeable}
              className="min-h-[90px] py-2.5"
              textAlignVertical="top"
              onChangeText={(v) => set('shots', v)}
            />
          </Field>
          <Group>{W.post.video}</Group>
          {videos.map((v) => (
            <Tile
              key={v.fileId}
              picture={v}
              tall
              onRemove={changeable ? () => actions.remove(v.fileId) : null}
              disabled={busy !== null}
            />
          ))}
          {changeable ? (
            <Button
              variant="secondary"
              icon={Video}
              loading={uploading}
              disabled={other('upload')}
              onPress={() => actions.add(true)}
              testID="socialcontent-post-add-video"
            >
              {uploading ? W.post.uploading : videos.length ? W.post.otherVideo : W.post.addVideo}
            </Button>
          ) : null}
          <Note>{W.post.videoHint}</Note>
        </Card>
      ) : null}

      {pictures ? (
        <Card className="gap-3 p-4" testID="socialcontent-post-pictures">
          <View className="flex-row items-center gap-2">
            <Text className="text-[14px] font-semibold">{W.post.picture}</Text>
            <Text className="text-[12.5px] text-text-3">{W.post.ways[p.pictureWay]}</Text>
          </View>
          {stills.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2"
            >
              {stills.map((pic, i) => (
                <Tile
                  key={pic.fileId}
                  picture={pic}
                  onOpen={() => setViewing(i)}
                  onRemove={changeable ? () => actions.remove(pic.fileId) : null}
                  disabled={busy !== null}
                />
              ))}
            </ScrollView>
          ) : null}
          {making ? (
            <Note>{W.post.pictureStates.making}</Note>
          ) : p.pictureState === 'failed' ? (
            <Text className="text-[13px] leading-[18px] text-danger-text">
              {W.post.pictureStates.failed} {p.pictureFailure}
            </Text>
          ) : null}
          {p.picture ? (
            <Text className="text-[13px] leading-[18px] text-text-2">
              <Text className="text-text-3">{W.post.pictureShows}: </Text>
              {p.picture}
            </Text>
          ) : null}
          {changeable ? (
            <>
              <Input
                value={pictureAsk}
                maxLength={500}
                placeholder={W.post.makeAsk}
                accessibilityLabel={W.post.makeAsk}
                onChangeText={setPictureAsk}
              />
              <View className="flex-row flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'picture:design'}
                  disabled={making || other('picture:design')}
                  onPress={() => {
                    actions.makePicture('design', pictureAsk);
                    setPictureAsk('');
                  }}
                  testID="socialcontent-post-make-design"
                >
                  {p.pictureWay === 'design' && stills.length
                    ? W.post.makeAgain
                    : W.post.switchTo(W.post.ways.design)}
                </Button>
                {d.format === 'photo' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === 'picture:photo'}
                    disabled={making || other('picture:photo')}
                    onPress={() => {
                      actions.makePicture('photo', pictureAsk);
                      setPictureAsk('');
                    }}
                    testID="socialcontent-post-make-photo"
                  >
                    {p.pictureWay === 'photo' && stills.length
                      ? W.post.makeAgain
                      : W.post.switchTo(W.post.ways.photo)}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ImagePlus}
                  loading={uploading}
                  disabled={other('upload')}
                  onPress={() => actions.add(false)}
                  testID="socialcontent-post-add-photo"
                >
                  {uploading ? W.post.uploading : W.post.upload}
                </Button>
              </View>
              <Note>{d.format === 'photo' ? W.post.waysHint.photo : W.post.waysHint.design}</Note>
            </>
          ) : null}
        </Card>
      ) : null}

      {p.state === 'draft' && p.stillNeeds && !dirty ? (
        <Card
          className="border-warning-soft bg-warning-soft/40 p-4"
          testID="socialcontent-post-still-needs"
        >
          <Text className="text-[13.5px] leading-[19px] text-warning-text">{p.stillNeeds}</Text>
        </Card>
      ) : null}

      {changeable ? (
        <View className="gap-2" testID="socialcontent-post-actions">
          {dirty ? (
            <Button
              loading={busy === 'save'}
              disabled={other('save')}
              onPress={() => void actions.save(d)}
              testID="socialcontent-post-save"
            >
              {W.post.save}
            </Button>
          ) : p.state === 'draft' ? (
            <Button
              loading={busy === 'ok'}
              disabled={other('ok') || making}
              onPress={() => actions.approve(true)}
              testID="socialcontent-post-ok"
            >
              {W.post.approve}
            </Button>
          ) : p.state === 'ready' || p.state === 'failed' ? (
            <>
              {postsHere ? (
                <Button
                  loading={busy === 'now'}
                  disabled={other('now') || making}
                  onPress={actions.postNow}
                  testID="socialcontent-post-now"
                >
                  {W.post.postNow}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                loading={busy === 'unok'}
                disabled={other('unok')}
                onPress={() => actions.approve(false)}
                testID="socialcontent-post-unok"
              >
                {W.post.takeBack}
              </Button>
            </>
          ) : null}
          {!postsHere && !dirty ? (
            <Button
              variant="ghost"
              icon={ShareIcon}
              onPress={actions.share}
              testID="socialcontent-post-share"
            >
              {W.phone.shareWords}
            </Button>
          ) : null}
          {p.state === 'skipped' ? (
            <Button
              variant="secondary"
              loading={busy === 'restore'}
              disabled={other('restore')}
              onPress={() => actions.skip(false)}
              testID="socialcontent-post-restore"
            >
              {W.post.restore}
            </Button>
          ) : (
            <Button
              variant="ghost"
              loading={busy === 'skip'}
              disabled={other('skip')}
              onPress={() => actions.skip(true)}
              testID="socialcontent-post-skip"
            >
              {W.post.skip}
            </Button>
          )}
          <Card className="mt-2 gap-2 p-4">
            <Input
              value={ask}
              maxLength={500}
              placeholder={W.post.rewriteAsk}
              accessibilityLabel={W.post.rewriteAsk}
              onChangeText={setAsk}
              testID="socialcontent-post-rewrite-ask"
            />
            <Button
              variant="secondary"
              loading={busy === 'rewrite'}
              disabled={other('rewrite')}
              onPress={() => {
                actions.rewrite(ask);
                setAsk('');
              }}
              testID="socialcontent-post-rewrite"
            >
              {W.post.rewrite}
            </Button>
          </Card>
        </View>
      ) : null}
      <PictureViewer pictures={stills} at={viewing} onClose={() => setViewing(null)} />
    </Screen>
  );
}

/** A field's name over it, with a line of help (or a warning) under it. */
function Field({
  label,
  hint,
  warn = false,
  children,
}: {
  label: string;
  hint?: string | null;
  warn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-[13.5px] font-medium">{label}</Text>
      {children}
      {hint ? (
        <Text
          className={cn('text-[12.5px] leading-[17px]', warn ? 'text-warning-text' : 'text-text-3')}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function Chips({ children }: { children: React.ReactNode }) {
  return <View className="flex-row flex-wrap gap-1.5">{children}</View>;
}

/**
 * One of its pictures (or its video, taller), with a cross to take it off the post. A picture opens full screen
 * when pressed.
 */
function Tile({
  picture,
  tall = false,
  onOpen,
  onRemove,
  disabled,
}: {
  picture: ContentPicture;
  tall?: boolean;
  onOpen?: () => void;
  onRemove: (() => void) | null;
  disabled: boolean;
}) {
  return (
    <View
      className={cn(
        'overflow-hidden rounded-md bg-card-2',
        tall ? 'h-[240px] w-[135px]' : 'h-[165px] w-[132px]',
      )}
      testID={`socialcontent-post-file-${picture.fileId}`}
    >
      {onOpen ? (
        <Pressable
          role="button"
          accessibilityLabel={W.post.fullScreen(picture.name)}
          onPress={onOpen}
          className="size-full"
          testID={`socialcontent-post-picture-${picture.fileId}`}
        >
          <PostPictureTile picture={picture} />
        </Pressable>
      ) : (
        <PostPictureTile picture={picture} />
      )}
      {onRemove ? (
        <Pressable
          role="button"
          accessibilityLabel={W.post.remove}
          hitSlop={8}
          disabled={disabled}
          onPress={onRemove}
          className="absolute right-1 top-1 rounded-full bg-card/90 p-1"
          testID={`socialcontent-post-remove-${picture.fileId}`}
        >
          <Icon as={X} className="size-3.5 text-text-2" />
        </Pressable>
      ) : null}
    </View>
  );
}
