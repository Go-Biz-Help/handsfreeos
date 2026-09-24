/**
 * A rich text in the thread (RCS, 0103), the phone's side of the web's `rich-message.tsx`: its buttons, card or
 * carousel drawn the way an RCS phone showed them, what a phone without RCS got instead, the button a customer's
 * reply came from, and how each text went. Here they only show — the business reads what its customer could tap.
 */
import { buttonReplyLine, THREAD_WORDS, transportWord, type ThreadItemShape } from '@hfos/core';
import * as React from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';

import {
  ChevronDown,
  ExternalLink,
  Hash,
  MessageSquareText,
  MousePointerClick,
  Phone,
  Reply,
} from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSignedUrl } from '@/inbox/storage';
import { cn } from '@/lib/utils';

type Rich = NonNullable<ThreadItemShape['rich']>;
type RichButton = Rich['buttons'][number];
type RichCardShape = Rich['cards'][number];
type ButtonReply = NonNullable<ThreadItemShape['buttonReply']>;
/** What a card's picture needs: where it is kept, and a name to read out. */
type Picture = { readonly bucket: string; readonly objectPath: string; readonly name: string };

const BUTTON_ICON = { reply: Reply, link: ExternalLink, call: Phone } as const;

/** One button as the customer's phone showed it. Pressing it here does nothing: it is a record. */
function ButtonChip({ button, block }: { button: RichButton; block?: boolean }) {
  const where = button.type === 'link' ? button.url : button.type === 'call' ? button.phone : null;
  return (
    <View
      testID="rich-button"
      accessible
      accessibilityLabel={where ? `${button.title}: ${where}` : button.title}
      className={cn(
        'h-7 flex-row items-center justify-center gap-1.5 rounded-full border border-border bg-card px-3',
        block && 'w-full rounded-[10px]',
      )}
    >
      <Icon
        as={BUTTON_ICON[button.type]}
        className="size-3.5 text-accent-text"
        strokeWidth={1.75}
      />
      <Text numberOfLines={1} className="shrink text-[12.5px] font-medium text-accent-text">
        {button.title}
      </Text>
    </View>
  );
}

/** The buttons under a message: what an RCS phone showed to tap. */
export function RichButtons({ buttons, out }: { buttons: readonly RichButton[]; out: boolean }) {
  if (buttons.length === 0) return null;
  return (
    <View
      testID="rich-buttons"
      className={cn('max-w-full flex-row flex-wrap gap-1.5', out ? 'justify-end' : 'justify-start')}
    >
      {buttons.map((b) => (
        <ButtonChip key={b.id} button={b} />
      ))}
    </View>
  );
}

/** A card's picture once its link is ready (with signal), a quiet tile until then. */
function CardPicture({ media }: { media: Picture }) {
  const url = useSignedUrl(media.bucket, media.objectPath);
  return (
    <View className="h-[140px] w-full overflow-hidden bg-card-2">
      {url ? (
        <Image
          source={{ uri: url }}
          accessibilityLabel={media.name}
          accessibilityIgnoresInvertColors
          className="size-full"
          resizeMode="cover"
        />
      ) : null}
    </View>
  );
}

/** A card: the picture on top, its title and words, and its buttons, as an RCS phone shows it. */
export function RichCard({
  title,
  body,
  media,
  buttons,
  className,
}: {
  title: string | null;
  body: string | null;
  media: Picture | null;
  buttons: readonly RichButton[];
  className?: string;
}) {
  return (
    <View
      testID="rich-card"
      className={cn(
        'w-[260px] max-w-full overflow-hidden rounded-2xl border border-border bg-card',
        className,
      )}
    >
      {media ? <CardPicture media={media} /> : null}
      <View className="gap-1 px-3.5 py-3">
        {title ? <Text className="text-[14px] font-semibold leading-[19px]">{title}</Text> : null}
        {body ? (
          <Text selectable className="text-[13.5px] leading-[19px] text-text-2">
            {body}
          </Text>
        ) : null}
      </View>
      {buttons.length ? (
        <View className="gap-1.5 px-3 pb-3">
          {buttons.map((b) => (
            <ButtonChip key={b.id} button={b} block />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A carousel: its cards side by side, swiped sideways like on the customer's phone. */
export function RichCarousel({ cards }: { cards: readonly RichCardShape[] }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="rich-carousel"
      className="max-w-full"
      contentContainerClassName="gap-2"
    >
      {cards.map((c, i) => (
        <RichCard
          key={i}
          title={c.title}
          body={c.body}
          media={c.media}
          buttons={c.buttons}
          className="w-[200px]"
        />
      ))}
    </ScrollView>
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
  item: Pick<ThreadItemShape, 'rich' | 'body' | 'media' | 'direction'>;
  bubble: React.ReactNode;
}) {
  const rich = item.rich;
  if (!rich) return <>{bubble}</>;
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
        <RichButtons buttons={rich.buttons} out={item.direction === 'outbound'} />
      )}
    </>
  );
}

/** Under a rich text that went to a phone without RCS: the plain text that phone got, a press away. */
export function PlainFace({ smsText }: { smsText: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View className="max-w-full items-end gap-1 px-1" testID="plain-face">
      <Pressable
        role="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        className="min-h-7 flex-row items-center gap-1"
        testID="plain-face-toggle"
      >
        <Icon as={MessageSquareText} className="size-3.5 text-text-3" strokeWidth={1.75} />
        <Text className="text-xs text-text-3">{THREAD_WORDS.wentAsText}</Text>
        <Icon as={ChevronDown} className={cn('size-3.5 text-text-3', open ? '' : '-rotate-90')} />
      </Pressable>
      {open ? (
        <View className="rounded-[10px] bg-card-2 px-3 py-2">
          <Text
            selectable
            className="text-[12.5px] leading-[18px] text-text-2"
            testID="plain-face-text"
          >
            {smsText}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Under a customer's reply that came from a button: "Tapped “Confirm”", "Texted 2 for “Reschedule”". */
export function ButtonReplyNote({ reply, body }: { reply: ButtonReply; body: string | null }) {
  return (
    <View className="flex-row items-center gap-1 px-1" testID="button-reply">
      <Icon
        as={reply.via === 'tap' ? MousePointerClick : Hash}
        className="size-3.5 text-text-3"
        strokeWidth={1.75}
      />
      <Text className="shrink text-xs text-text-3">{buttonReplyLine(reply, body)}</Text>
    </View>
  );
}

/** How a text went, in the line under it: RCS stands out; SMS and MMS are plain words. */
export function TransportTag({ transport }: { transport: ThreadItemShape['transport'] }) {
  const word = transportWord(transport);
  if (!word) return null;
  return transport === 'rcs' ? (
    <View testID="transport" className="rounded-[4px] bg-accent-soft px-1">
      <Text className="text-[10.5px] font-semibold leading-4 text-accent-text">{word}</Text>
    </View>
  ) : (
    <Text testID="transport" className="text-xs text-text-3">{`· ${word}`}</Text>
  );
}
