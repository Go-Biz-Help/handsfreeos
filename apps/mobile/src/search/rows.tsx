import {
  badgeLabel,
  hitLines,
  marksIn,
  SEARCH_WORDS,
  searchHref,
  searchProbes,
  SEARCH_MIN_CHARS,
  settingEntry,
  settingPhoneTarget,
  SETTINGS_SEARCH_WORDS,
  whyLabel,
  type HitLines,
  type SearchHit,
  type SearchSnippet,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { openAppPath } from '@/components/assistant/parts';
import { ExternalLink, MessageSquare, Phone, Search } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { startCall } from '@/inbox/calls';
import { routeFor } from '@/links/route-map';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';

import { searchScreenHref } from './href';

/**
 * Search's rows on the phone (boards 5 and 5b), drawn the same whether the server answered or the phone's own copy
 * did: the title with what matched marked, its badges, the grey line core works out (`hitLines`), why it matched, and
 * a stretch of the words it was found in. Marks are drawn as text, never markup. A row that opens on the web carries
 * the arrow out, as `ListRow`'s do.
 */

/** A text with the places that matched marked, as the web's `<mark>`. */
export function Marked({
  text,
  marks,
  className,
  numberOfLines,
  testID,
}: {
  text: string;
  marks: readonly (readonly [number, number])[];
  className?: string;
  numberOfLines?: number;
  testID?: string;
}) {
  const parts: { text: string; on: boolean }[] = [];
  let at = 0;
  for (const [start, end] of marks) {
    if (start < at || end > text.length || start >= end) continue;
    if (start > at) parts.push({ text: text.slice(at, start), on: false });
    parts.push({ text: text.slice(start, end), on: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), on: false });
  return (
    <Text className={className} numberOfLines={numberOfLines} testID={testID}>
      {parts.map((p, i) =>
        p.on ? (
          <Text key={i} className="rounded-[3px] bg-accent-soft-2 font-semibold text-text">
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

/** Where a hit opens on the phone: a setting where Settings search opens it, the rest through the route map. */
export function openHit(hit: SearchHit, workspaceId: string): void {
  if (hit.kind === 'settings') {
    const entry = settingEntry(hit.id);
    if (entry) {
      const target = settingPhoneTarget(workspaceId, entry);
      if (target.kind === 'web') void openWeb(target.path);
      else router.push(target.href as Href);
      return;
    }
  }
  openAppPath(hit.href);
}

/** Whether a hit opens in the browser rather than on a screen of the phone's. */
export function opensOnWeb(hit: SearchHit, workspaceId: string): boolean {
  if (hit.kind === 'settings') {
    const entry = settingEntry(hit.id);
    return !!entry && settingPhoneTarget(workspaceId, entry).kind === 'web';
  }
  return routeFor(hit.href).kind !== 'screen';
}

/**
 * A setting only the web changes says "Opens on the web" and its value, as Settings search shows it (decision 12);
 * null for every other row, whose line is core's.
 */
function settingLines(hit: SearchHit, web: boolean): HitLines | null {
  if (hit.kind !== 'settings' || !web) return null;
  const line = [SETTINGS_SEARCH_WORDS.opensOnWeb, hit.facts.status].filter(Boolean).join(' · ');
  return { line, chip: null, under: null };
}

/** A stretch of words worth showing under the row: where it was found, unless that's the title itself. */
function snippetOf(hit: SearchHit): SearchSnippet | null {
  const s = hit.why.snippet;
  if (!s?.text || s.text === hit.title) return null;
  return s;
}

export function SearchRow({
  hit,
  q,
  workspaceId,
  now,
  timeZone,
  onOpen,
  testID,
}: {
  hit: SearchHit;
  /** What was typed: the title's marks are worked out from it. */
  q: string;
  workspaceId: string;
  now: number;
  timeZone: string;
  /** Before the row opens (to keep the search among the recent ones). */
  onOpen?: () => void;
  testID?: string;
}) {
  const probes = React.useMemo(() => searchProbes(q), [q]);
  const web = opensOnWeb(hit, workspaceId);
  const lines = settingLines(hit, web) ?? hitLines(hit, { now, timeZone });
  const why = whyLabel(hit.why, hit.kind);
  const snippet = snippetOf(hit);
  const badges = hit.badges.map(badgeLabel).filter((b): b is string => !!b);
  const person = hit.kind === 'contacts' || (hit.kind === 'close' && !!hit.contact);
  return (
    <Pressable
      role={web ? 'link' : 'button'}
      accessibilityLabel={[hit.title, ...badges, lines.line, why].filter(Boolean).join('. ')}
      onPress={() => {
        onOpen?.();
        openHit(hit, workspaceId);
      }}
      className="min-h-14 flex-row items-center gap-3 px-4 py-1.5 active:bg-card-2"
      testID={testID ?? `search-hit-${hit.id}`}
    >
      {person ? <Avatar name={hit.title} seed={hit.id} /> : null}
      <View className="min-w-0 flex-1 gap-px">
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          <Marked
            text={hit.title}
            marks={marksIn(hit.title, probes)}
            className="shrink text-[15px] font-medium"
            numberOfLines={1}
          />
          {badges.map((b) => (
            <Badge key={b} variant={b === 'Client' ? 'ok' : b === 'Lead' ? 'accent' : 'gray'}>
              {b}
            </Badge>
          ))}
        </View>
        {lines.line ? (
          <Text className="text-[13px] leading-[18px] text-text-3" numberOfLines={1}>
            {lines.line}
          </Text>
        ) : null}
        {snippet ? (
          <Marked
            text={snippet.text}
            marks={snippet.marks}
            className="text-[13px] leading-[18px] text-text-2"
            numberOfLines={2}
          />
        ) : null}
      </View>
      {[lines.chip, why]
        .filter((c): c is string => !!c)
        .map((c) => (
          <Badge key={c} variant="gray">
            {c}
          </Badge>
        ))}
      {web ? <Icon as={ExternalLink} className="size-4 text-text-3" /> : null}
    </Pressable>
  );
}

/** The best match, with Call and Text for a contact, as board 5 draws it. */
export function BestMatch({
  hit,
  q,
  workspaceId,
  now,
  timeZone,
  canReach,
  onOpen,
}: {
  hit: SearchHit;
  q: string;
  workspaceId: string;
  now: number;
  timeZone: string;
  /** Call and Text show for whoever may use the inbox, on a customer with a number. */
  canReach: boolean;
  onOpen?: () => void;
}) {
  const personId = hit.contact?.personId ?? null;
  const reach = canReach && hit.kind === 'contacts' && !!personId && !!hit.contact?.phoneE164;
  return (
    <View className="flex-row items-center pr-3" testID="search-best">
      <View className="min-w-0 flex-1">
        <SearchRow
          hit={hit}
          q={q}
          workspaceId={workspaceId}
          now={now}
          timeZone={timeZone}
          onOpen={onOpen}
          testID="search-best-row"
        />
      </View>
      {reach ? (
        <View className="flex-row gap-2">
          <ReachButton
            icon={Phone}
            label={SEARCH_WORDS.call(hit.title)}
            onPress={() => startCall({ personId: personId! }, { workspaceId })}
            testID="search-best-call"
          />
          <ReachButton
            icon={MessageSquare}
            label={SEARCH_WORDS.text(hit.title)}
            onPress={() =>
              openAppPath(searchHref(workspaceId, { type: 'compose_text', personId: personId! }))
            }
            testID="search-best-text"
          />
        </View>
      ) : null}
    </View>
  );
}

function ReachButton({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: typeof Phone;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="size-11 items-center justify-center rounded-[10px] border border-border-strong bg-card active:bg-card-2"
      testID={testID}
    >
      <Icon as={icon} className="size-[18px] text-text-2" />
    </Pressable>
  );
}

/** "CONTACTS" over a group, with "See all 7" when there's more than it shows. */
export function GroupHeading({
  label,
  seeAll,
  testID,
}: {
  label: string;
  seeAll?: { label: string; onPress: () => void } | null;
  testID?: string;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 pb-1.5 pt-3.5" testID={testID}>
      <Text variant="group">{label}</Text>
      <View className="flex-1" />
      {seeAll ? (
        <Pressable
          role="button"
          onPress={seeAll.onPress}
          hitSlop={8}
          testID={testID ? `${testID}-all` : undefined}
        >
          <Text className="text-[13px] font-medium text-accent-text">{seeAll.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A quiet line at the top of the results: offline, close matches, nobody active, or a group that didn't answer. */
export function SearchNote({
  children,
  tone = 'quiet',
  action,
  testID,
}: {
  children: React.ReactNode;
  tone?: 'quiet' | 'warning';
  action?: { label: string; onPress: () => void };
  testID?: string;
}) {
  return (
    <View
      className={cn(
        'mx-3 gap-1.5 rounded-card px-3.5 py-3',
        tone === 'warning' ? 'bg-warning-soft' : 'bg-card-2',
      )}
      testID={testID}
    >
      <Text
        className={cn(
          'text-[13.5px] leading-[19px]',
          tone === 'warning' ? 'text-warning-text' : 'text-text-2',
        )}
      >
        {children}
      </Text>
      {action ? (
        <Pressable role="button" onPress={action.onPress} hitSlop={8} className="self-start">
          <Text className="text-[13.5px] font-medium text-accent-text">{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The last row under the Contacts and Inbox boxes, which stay filters of their own lists: "Search everything for
 * “dana”", opening Search with what was typed. Nothing until there's enough to search.
 */
export function SearchEverythingRow({
  workspaceId,
  q,
  className,
  testID,
}: {
  workspaceId: string;
  q: string;
  className?: string;
  testID?: string;
}) {
  const typed = q.trim().slice(0, 120);
  if (typed.length < SEARCH_MIN_CHARS) return null;
  return (
    <Pressable
      role="button"
      onPress={() => router.push(searchScreenHref(workspaceId, typed) as Href)}
      className={cn('min-h-14 flex-row items-center gap-3 py-2.5 active:opacity-80', className)}
      testID={testID}
    >
      <View className="size-10 items-center justify-center rounded-card bg-accent-soft">
        <Icon as={Search} className="size-5 text-accent-text" />
      </View>
      <Text className="min-w-0 flex-1 text-[15px] font-medium text-accent-text" numberOfLines={2}>
        {SEARCH_WORDS.everythingFor(typed)}
      </Text>
    </Pressable>
  );
}
