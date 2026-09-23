'use client';
/**
 * A rich text in the thread (RCS, 0103): its buttons, card or carousel, drawn the way an RCS phone showed them.
 * Here they only show — the business reads what its customer could tap — and under a rich text that went to a
 * phone without RCS, the plain text that phone got instead is one click away.
 */
import { buttonReplyLine, transportWord, type ButtonReplyOut, type RichTextOut } from '@hfos/core';
import {
  ExternalLink,
  Hash,
  MessageSquareText,
  MousePointerClick,
  Phone,
  Reply,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ThreadItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useSignedUrl } from './bits';

type RichButton = RichTextOut['buttons'][number];
type Media = ThreadItem['media'][number];

const BUTTON_ICON = { reply: Reply, link: ExternalLink, call: Phone } as const;

/** One button as the customer's phone shows it. Nothing happens on a click here: it is a record. */
function ButtonChip({ button, block }: { button: RichButton; block?: boolean }) {
  const Icon = BUTTON_ICON[button.type];
  const where =
    button.type === 'link' ? button.url : button.type === 'call' ? button.phone : undefined;
  return (
    <span
      data-testid="rich-button"
      data-type={button.type}
      title={where ?? 'A reply the customer can tap'}
      className={cn(
        'inline-flex h-7 items-center justify-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-accent-text',
        block && 'w-full rounded-[10px]',
      )}
    >
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      <span className="truncate">{button.title}</span>
    </span>
  );
}

/** The buttons under a message: what an RCS phone showed to tap. */
export function RichButtons({ buttons, out }: { buttons: RichButton[]; out: boolean }) {
  if (buttons.length === 0) return null;
  return (
    <div
      data-testid="rich-buttons"
      className={cn('flex max-w-full flex-wrap gap-1.5', out ? 'justify-end' : 'justify-start')}
    >
      {buttons.map((b) => (
        <ButtonChip key={b.id} button={b} />
      ))}
    </div>
  );
}

function CardPicture({ media, className }: { media: Media; className?: string }) {
  const url = useSignedUrl(media.bucket, media.objectPath);
  return (
    <div className={cn('h-[140px] w-full overflow-hidden bg-card-2', className)}>
      {url ? (
        // A signed Storage link: plain <img>, nothing for an image optimizer to cache.
        <img src={url} alt={media.name} className="h-full w-full object-cover" />
      ) : null}
    </div>
  );
}

/** A card: the photo on top, its title and words, and its buttons, as an RCS phone shows it. */
export function RichCard({
  title,
  body,
  media,
  buttons,
  className,
}: {
  title: string | null;
  body: string | null;
  media: Media | null;
  buttons: RichButton[];
  className?: string;
}) {
  return (
    <div
      data-testid="rich-card"
      className={cn(
        'flex w-[260px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-left',
        className,
      )}
    >
      {media ? <CardPicture media={media} /> : null}
      <div className="flex flex-col gap-1 px-3.5 py-3">
        {title ? <div className="text-sm font-semibold leading-snug">{title}</div> : null}
        {body ? (
          <div className="whitespace-pre-wrap text-[13.5px] leading-[1.45] text-text-2 [overflow-wrap:anywhere]">
            {body}
          </div>
        ) : null}
      </div>
      {buttons.length ? (
        <div className="flex flex-col gap-1.5 px-3 pb-3">
          {buttons.map((b) => (
            <ButtonChip key={b.id} button={b} block />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A carousel: its cards side by side, scrolled sideways like on the customer's phone. */
export function RichCarousel({ cards }: { cards: RichTextOut['cards'] }) {
  return (
    <div
      data-testid="rich-carousel"
      className="flex max-w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
    >
      {cards.map((c, i) => (
        <RichCard
          key={i}
          title={c.title}
          body={c.body}
          media={c.media}
          buttons={c.buttons}
          className="w-[200px] flex-none"
        />
      ))}
    </div>
  );
}

/**
 * What a rich text carried, in place of (a card) or under (buttons, a carousel) its words. `bubble` is the
 * message's own words and photo, drawn by the thread as for any text.
 */
export function RichContent({
  item,
  bubble,
}: {
  item: Pick<ThreadItem, 'rich' | 'body' | 'media' | 'direction'>;
  bubble: ReactNode;
}) {
  const rich = item.rich;
  if (!rich) return <>{bubble}</>;
  const out = item.direction === 'outbound';
  if (rich.kind === 'card')
    return (
      <RichCard
        title={rich.title}
        body={item.body}
        media={item.media[0] ?? null}
        buttons={rich.buttons}
      />
    );
  return (
    <>
      {bubble}
      {rich.kind === 'carousel' ? (
        <RichCarousel cards={rich.cards} />
      ) : (
        <RichButtons buttons={rich.buttons} out={out} />
      )}
    </>
  );
}

/** Under a rich text that went to a phone without RCS: the plain text that phone got instead. */
export function PlainFace({ smsText }: { smsText: string }) {
  return (
    <details className="max-w-full px-1 text-right text-xs text-text-3" data-testid="plain-face">
      <summary className="cursor-pointer list-none">
        <span className="inline-flex items-center gap-1">
          <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.75} />
          Went as a text, with the choices listed
        </span>
      </summary>
      <div className="mt-1 whitespace-pre-wrap rounded-[10px] bg-card-2 px-3 py-2 text-left text-[12.5px] text-text-2 [overflow-wrap:anywhere]">
        {smsText}
      </div>
    </details>
  );
}

/** Under a customer's reply that came from a button: "Tapped “Confirm”", "Texted 2 for “Reschedule”". */
export function ButtonReplyNote({ reply, body }: { reply: ButtonReplyOut; body: string | null }) {
  const Icon = reply.via === 'tap' ? MousePointerClick : Hash;
  return (
    <div
      data-testid="button-reply"
      className="inline-flex items-center gap-1 px-1 text-xs text-text-3"
    >
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      {buttonReplyLine(reply, body)}
    </div>
  );
}

/** How a text went, in the line under it: RCS stands out; SMS and MMS are plain words. */
export function TransportTag({ transport }: { transport: ThreadItem['transport'] }) {
  const word = transportWord(transport);
  if (!word) return null;
  return transport === 'rcs' ? (
    <span
      data-testid="transport"
      title="RCS: branded, with pictures and buttons to tap"
      className="rounded-[4px] bg-accent-soft px-1 text-[10.5px] font-semibold leading-4 text-accent-text"
    >
      {word}
    </span>
  ) : (
    <span
      data-testid="transport"
      title={transport === 'mms' ? 'A picture message' : 'An ordinary text'}
    >
      · {word}
    </span>
  );
}
