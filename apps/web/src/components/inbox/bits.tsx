'use client';
import {
  segmentCounterLabel,
  unreadLabel,
  waitingFor,
  type SocialChannel,
  type WordPart,
} from '@hfos/core';
import { Clock, Globe, Image as ImageIcon, Moon, Phone, Play } from 'lucide-react';
import { Fragment, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Dialog, DialogTrigger } from '@/components/ui/dialog';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { MediaViewer } from './media-viewer';
import { SOCIAL_ICONS } from './social-bits';

export type IconType = ComponentType<{ className?: string; strokeWidth?: number }>;

/** Unread messages in one conversation (list rows). */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full bg-accent px-[5px] text-[11px] font-semibold leading-none text-white',
        className,
      )}
    >
      <span aria-hidden>{unreadLabel(count)}</span>
      <span className="sr-only">{count} unread</span>
    </span>
  );
}

/** Amber once a customer has waited past the reminder threshold with no reply. */
export function WaitChip({ minutes }: { minutes: number }) {
  return (
    <span
      data-testid="wait-chip"
      className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] bg-warning-soft px-1.5 text-[11.5px] font-medium text-warning-text"
    >
      <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
      {waitingFor(minutes, { capital: true })}
    </span>
  );
}

export function Pill({
  children,
  icon: Icon,
  className,
  testId,
}: {
  children: ReactNode;
  icon?: IconType;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] bg-card-2 px-1.5 text-[11.5px] font-medium text-text-2',
        className,
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" strokeWidth={1.75} /> : null}
      {children}
    </span>
  );
}

const TONES = {
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
} as const;
const TILE = { 24: 'h-6 w-6', 32: 'h-8 w-8', 40: 'h-10 w-10', 44: 'h-11 w-11' } as const;

/** One round tile per channel, the same in the list, the thread, the timeline and settings. */
export function ChannelIcon({
  icon: Icon,
  tone = 'accent',
  size = 32,
  className,
}: {
  icon: IconType;
  tone?: keyof typeof TONES;
  size?: keyof typeof TILE;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-full',
        TONES[tone],
        TILE[size],
        className,
      )}
    >
      <Icon className={size >= 40 ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5'} strokeWidth={1.5} />
    </span>
  );
}

/** A number that isn't in Contacts yet. */
export function PhoneAvatar({
  size = 'md',
  chat = false,
  social = null,
}: {
  size?: 'sm' | 'md' | 'panel';
  /** A website chat's visitor: a globe, like the chat's channel mark, instead of a phone. */
  chat?: boolean;
  /** Somebody on Messenger or Instagram: its mark. */
  social?: SocialChannel | null;
}) {
  const Icon = social ? SOCIAL_ICONS[social] : chat ? Globe : Phone;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-full bg-card-3 text-text-2',
        size === 'sm' ? 'h-6 w-6' : size === 'panel' ? 'h-12 w-12' : 'h-8 w-8',
      )}
    >
      <Icon
        className={
          size === 'panel' ? 'h-[18px] w-[18px]' : size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'
        }
        strokeWidth={1.5}
      />
    </span>
  );
}

/** The customer's avatar, or the phone tile for a number nobody has linked. */
export function ContactAvatar({
  person,
  size = 'md',
  chat = false,
  social = null,
}: {
  person: { id: string; fullName: string } | null;
  size?: 'sm' | 'md' | 'panel';
  /** A website chat: its visitor shows a globe until they're a customer. */
  chat?: boolean;
  /** Messenger or Instagram: its mark until they're a customer. */
  social?: SocialChannel | null;
}) {
  if (!person) return <PhoneAvatar size={size} chat={chat} social={social} />;
  return (
    <Avatar
      name={person.fullName}
      seed={person.id}
      size={size === 'panel' ? 'md' : size}
      className={size === 'panel' ? 'h-12 w-12 text-base' : undefined}
    />
  );
}

export function DayDivider({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 mt-[18px] self-center text-xs font-medium text-text-3" role="separator">
      {children}
    </div>
  );
}

export function SystemEntry({ icon: Icon, children }: { icon: IconType; children: ReactNode }) {
  return (
    <div className="mb-0.5 mt-3 inline-flex items-center gap-1.5 self-center text-xs text-text-3">
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      {children}
    </div>
  );
}

export function QuietStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      data-testid="quiet-strip"
      className={cn(
        'flex items-center gap-2 rounded-[10px] bg-warning-soft px-3 py-2 text-[13px] text-warning-text',
        className,
      )}
    >
      <Moon className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A short-lived link to a stored photo (the telephony bucket or a customer file), read with the user's session. */
export function useSignedUrl(bucket: string, path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void supabaseBrowser()
      .storage.from(bucket)
      .createSignedUrl(path, 3600)
      .then(({ data }) => {
        if (!cancelled) setUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, path]);
  return url;
}

/**
 * A photo or a video in a message: the picture (or the video's first frame, with a play mark) once its link is
 * ready, a quiet tile until then. Opens full size over the thread.
 */
export function MediaThumb({
  bucket,
  objectPath,
  name,
  contentType,
  className,
}: {
  bucket: string;
  objectPath: string;
  name: string;
  contentType: string;
  className?: string;
}) {
  const url = useSignedUrl(bucket, objectPath);
  const image = contentType.startsWith('image/');
  const video = contentType.startsWith('video/');
  const [viewing, setViewing] = useState(false);
  const tile = cn(
    'relative flex h-[150px] w-[200px] items-center justify-center overflow-hidden rounded-[14px] border border-border bg-[linear-gradient(135deg,var(--card-3),var(--card-2))] text-text-3 max-md:h-[136px] max-md:w-[180px]',
    className,
  );
  // A file that's neither (a PDF, a contact card) opens the way the browser opens that kind of file.
  if (!image && !video)
    return (
      <a
        href={url ?? undefined}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${name}`}
        data-testid="media-thumb"
        className={tile}
      >
        <ImageIcon className="h-[18px] w-[18px]" strokeWidth={1.5} />
      </a>
    );
  return (
    <Dialog open={viewing} onOpenChange={setViewing}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={!url}
          aria-label={`${video ? 'Play' : 'Open'} ${name}`}
          data-testid="media-thumb"
          className={cn(tile, url && (video ? 'cursor-pointer' : 'cursor-zoom-in'))}
        >
          {url && image ? (
            // A signed Storage link: plain <img>, nothing for an image optimizer to cache.
            <img src={url} alt={name} className="h-full w-full object-cover" />
          ) : url && video ? (
            // Its first frame: `#t=0.1` makes Safari draw one, and a carrier's 3GP that won't play stays dark.
            <video
              src={`${url}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              tabIndex={-1}
              aria-hidden
              className="h-full w-full bg-black object-cover"
            />
          ) : (
            <ImageIcon className="h-[18px] w-[18px]" strokeWidth={1.5} />
          )}
          {video ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white">
                <Play className="ml-0.5 h-5 w-5 fill-current" strokeWidth={1.5} />
              </span>
            </span>
          ) : null}
        </button>
      </DialogTrigger>
      {url ? (
        <MediaViewer
          url={url}
          bucket={bucket}
          objectPath={objectPath}
          name={name}
          video={video}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </Dialog>
  );
}

/** Characters, the per-text limit and how many texts it becomes (carrier math from core). */
export function SegmentCounter({ text, photos = 0 }: { text: string; photos?: number }) {
  return (
    <span
      className="whitespace-nowrap px-1.5 text-xs tabular-nums text-text-3"
      data-testid="segment-counter"
    >
      {segmentCounterLabel(text, photos)}
    </span>
  );
}

/** A sentence from core's words, with its bold parts in <strong>. */
export function Words({ parts }: { parts: readonly WordPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <strong key={i}>{p.strong}</strong>
        ),
      )}
    </>
  );
}
