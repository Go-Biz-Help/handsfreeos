import { firstNames } from '@hfos/core/addons/realestate/phone-words-buyer';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import type { RealestateCopy } from '@hfos/core/addons/realestate/views/synced';
import { dealPageOfCopy } from '@hfos/core/addons/realestate/views/deal-page';
import * as React from 'react';
import { Image, Platform, TextInput, View } from 'react-native';

import { ChangeError } from '@/changes';
import { SignalLow } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { useRealestateCopy } from './copy';
import { NeedsSignalCard, reHref, SummaryChip, useReContext, type ReContext } from './kit';

/**
 * What the buyer's pages (boards 82–84) share: the deal they're on and its clients, a card of label and value rows,
 * the small "needs signal" line under a button, a home's photo from the MLS, and a sheet for a typed note.
 */

export interface BuyerDeal {
  readonly id: string;
  readonly name: string;
  readonly side: 'buyer' | 'listing';
  /** The person holds the deal whole; false for one kept as its summary. */
  readonly full: boolean;
  readonly clients: readonly { readonly personId: string; readonly name: string }[];
  /** The clients' first names: "Linh", "Linh and Tuan", or "the client". */
  readonly who: string;
}

/** The deal a buyer's page is on, from core's deal page; null when the phone doesn't hold it. */
export function buyerDealOf(
  copy: RealestateCopy,
  dealId: string,
  ctx: Pick<ReContext, 'userId' | 'now'>,
): BuyerDeal | null {
  const page = dealPageOfCopy(copy, dealId, ctx);
  if (!page) return null;
  const clients = page.parties
    .filter((p) => p.role === 'client' && p.personId)
    .map((p) => ({ personId: p.personId!, name: p.name }));
  return {
    id: dealId,
    name: page.deal.name,
    side: page.deal.side,
    full: page.full,
    clients,
    who: firstNames(clients.map((c) => c.name)),
  };
}

/** One deal's copy, its page's context, and the deal itself. */
export function useBuyerDeal(dealId: string) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const deal = React.useMemo(() => buyerDealOf(copy, dealId, ctx), [copy, dealId, ctx]);
  return { ctx, copy, deal };
}

/** A page of a deal this phone doesn't hold. */
export function DealNotHere({ title, workspaceId }: { title: string; workspaceId: string }) {
  return (
    <Screen title={title} leading="back" back={reHref(workspaceId)} testID="re-deal-not-here">
      <NeedsSignalCard words={RE_PHONE_WORDS.notOnPhone} testID="re-not-on-phone" />
    </Screen>
  );
}

/** The chip and note over a page of a deal kept as its summary. */
export function SummaryHead() {
  return (
    <View className="gap-1.5" testID="re-summary-head">
      <SummaryChip />
      <Text className="text-[12.5px] leading-[17px] text-text-3">{RE_PHONE_WORDS.summaryNote}</Text>
    </View>
  );
}

/** "THE SEARCH", "NEW SINCE YESTERDAY 2": the label over a group, with a count when there is one. */
export function GroupLabel({ children, count }: { children: string; count?: number }) {
  return (
    <View className="flex-row items-center gap-1.5 px-1 pt-2">
      <Text variant="group">{children}</Text>
      {count !== undefined ? <Text className="text-xs text-text-3">{count}</Text> : null}
    </View>
  );
}

export interface KeyValue {
  readonly label: string;
  readonly value: string;
  /** A quieter part after the value: "(v1 $485,000)". */
  readonly was?: string;
  /** A line under the value: "from the MLS". */
  readonly sub?: string;
  readonly testID?: string;
}

/** A card of label and value rows, as the boards draw facts and terms. */
export function KeyValues({ rows, testID }: { rows: readonly KeyValue[]; testID?: string }) {
  if (!rows.length) return null;
  return (
    <Card testID={testID}>
      {rows.map((r, i) => (
        <View
          key={`${r.label}-${i}`}
          className={cn(
            'flex-row items-start gap-3 px-3.5 py-3',
            i > 0 && 'border-t border-border',
          )}
          testID={r.testID}
        >
          <Text className="text-[14.5px] text-text-2">{r.label}</Text>
          <View className="min-w-0 flex-1 items-end">
            <Text className="text-right text-[14.5px]">
              {r.value}
              {r.was ? <Text className="text-[14.5px] text-text-3">{` ${r.was}`}</Text> : null}
            </Text>
            {r.sub ? (
              <Text className="text-right text-[12.5px] leading-[17px] text-text-3">{r.sub}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </Card>
  );
}

/** The quiet line under a button about signal: "Changes wait on this phone; …". */
export function SignalNote({ words, testID }: { words: string; testID?: string }) {
  return (
    <View className="flex-row gap-2 px-1" testID={testID}>
      <Icon as={SignalLow} className="mt-0.5 size-3.5 text-text-3" />
      <Text className="flex-1 text-[12.5px] leading-[17px] text-text-3">{words}</Text>
    </View>
  );
}

/**
 * A photo from the MLS, as its supplier serves it. The phone keeps what it has shown in its image cache, so photos it
 * has seen stay with no signal; the rest load with signal. A plain frame when there's none.
 */
export function MlsPhoto({
  url,
  className,
  width,
  testID,
}: {
  url: string | null | undefined;
  className?: string;
  /** A set width, for a photo in a row that pages (the home's photos). */
  width?: number;
  testID?: string;
}) {
  const style = width ? { width } : undefined;
  if (!url)
    return (
      <View
        className={cn('bg-card-2', className)}
        style={style}
        testID={testID}
        accessible={false}
      />
    );
  return (
    <Image
      source={{ uri: url, cache: 'force-cache' }}
      style={style}
      className={cn('bg-card-2', className)}
      resizeMode="cover"
      accessibilityIgnoresInvertColors
      testID={testID}
    />
  );
}

/** What went wrong with a change, for a person: the refusal's own words, or why it couldn't go. */
export function problemWords(e: unknown): string {
  return e instanceof ChangeError ? e.message : errorMessage(e);
}

/** Runs a change and says how it went: the words when it's kept, or the problem. */
export async function attempt(run: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await run();
    if (done) toast.show(done);
    return true;
  } catch (e) {
    toast.error(problemWords(e));
    return false;
  }
}

/** A typed note or reason, in a sheet: Note at a home or a stop, why a stop was skipped. */
export function TextSheet({
  open,
  onClose,
  title,
  description,
  placeholder,
  submit,
  onSubmit,
  children,
  testID,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  placeholder?: string;
  submit: string;
  onSubmit: (text: string) => Promise<boolean>;
  /** What goes over the words: a choice of what kind of thing it is. */
  children?: React.ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setText('');
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} testID={testID}>
      {children}
      <View className="mt-3 gap-3">
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.placeholder}
          multiline
          autoFocus
          className="min-h-24 rounded-menu border border-border-strong bg-card px-3.5 py-3 font-sans text-base text-text"
          textAlignVertical="top"
          testID={testID ? `${testID}-text` : undefined}
        />
        <Button
          disabled={!text.trim()}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            const ok = await onSubmit(text.trim());
            setBusy(false);
            if (ok) onClose();
          }}
          testID={testID ? `${testID}-submit` : undefined}
        >
          {submit}
        </Button>
      </View>
    </Sheet>
  );
}

/** Directions through every stop in order: Apple Maps on an iPhone, Google Maps elsewhere. */
export function directionsUrl(addresses: readonly string[], os: string = Platform.OS): string {
  const stops = addresses.filter(Boolean);
  if (os === 'ios')
    return `http://maps.apple.com/?daddr=${stops.map(encodeURIComponent).join('+to:')}`;
  const destination = encodeURIComponent(stops.at(-1) ?? '');
  const waypoints = stops.slice(0, -1).map(encodeURIComponent).join('%7C');
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${waypoints ? `&waypoints=${waypoints}` : ''}`;
}
