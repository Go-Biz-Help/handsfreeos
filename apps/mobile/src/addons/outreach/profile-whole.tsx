/**
 * The whole profile on the phone (docs/outreach.md, decision 84), as on the web (apps/web/src/addons/outreach/
 * profile-whole.tsx): how it comes across, then its username, name and links, each as it is and as written, who does
 * it, and Put these in. A new username asks first: what changes shows before it's picked. The cover's made to
 * download on the computer; pictures stay the person's to change (decision 64). Everything listed and decided is
 * core's (profile-parts.ts).
 */
import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { shownUsername, type ProfileCheck } from '@hfos/core/addons/outreach/profile-check';
import {
  EVERY_PART_WORDS as E,
  featuredEdit,
  firstUsername,
  linkChangesEdit,
  linkChangesFor,
  LOOK_WORDS,
  linksToAdd,
  serviceLine,
  workEdit,
  workLine,
  partStepsWords,
  PICTURE_WORDS,
  profileParts,
  PROFILE_PART_WORDS as W,
  USERNAME_WORDS as U,
  type ProfilePartRow,
  type ProfilesKnown,
} from '@hfos/core/addons/outreach/profile-parts';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Check, CircleCheck } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { AskButton, type AskActions } from './asks';
import { useOptionalBusiness } from '@/components/shell/business-context';

import { Note, useOutreachAnswer } from './kit';

/** How the whole profile comes across: right as a person who does this work, or what clashes. */
export function ProfileLook({ check }: { check: ProfileCheck | null }) {
  const look = check?.look;
  if (!look) return null;
  if (look.ok)
    return (
      <View className="rounded-menu bg-success-soft px-3 py-2.5" testID="ready-profile-look">
        <Text className="text-[13.5px] leading-[19px] text-success-text">
          {look.title || LOOK_WORDS.person}
        </Text>
      </View>
    );
  return (
    <View className="gap-1.5 rounded-card bg-warning-soft px-3.5 py-3" testID="ready-profile-look">
      <Text className="text-[15px] font-semibold leading-[20px] text-warning-text">
        {look.title || LOOK_WORDS.unclear}
      </Text>
      {look.clashes.map((c) => (
        <Text key={c} className="text-[13.5px] leading-[19px] text-warning-text">
          • {c}
        </Text>
      ))}
      <Note>{W.stays}</Note>
    </View>
  );
}

const badgeClass: Readonly<Record<ProfilePartRow['how'] | 'ok' | 'first', string>> = {
  ok: 'bg-success-soft text-success-text',
  first: 'bg-accent-soft text-accent-text',
  auto: 'bg-success-soft text-success-text',
  steps: 'bg-warning-soft text-warning-text',
  app: 'bg-warning-soft text-warning-text',
  tip: 'bg-card-2 text-text-2',
};

function PartBadge({ row }: { row: ProfilePartRow }) {
  const kind = row.ok ? 'ok' : row.part === 'username' ? 'first' : row.how;
  const words = row.ok ? W.right : row.part === 'username' ? W.asksFirst : W.how[row.how];
  return (
    <Text
      className={cn(
        'overflow-hidden rounded-full px-2 py-0.5 text-[12px] font-medium',
        badgeClass[kind],
      )}
    >
      {words}
    </Text>
  );
}

/** The parts listed here: from decision 99 the work and what's featured too, where the person's computer puts them in. */
const REST_PARTS: readonly string[] = ['username', 'name', 'links', 'work', 'featured'];

/**
 * The username, name and links, and from decision 99 the work and what's featured (Alignable's ideal customer and
 * partner, and its services): as they are, as written, who does each, and Put these in for the ones ticked.
 */
export function ProfileRestList({
  platform,
  check,
  asks,
  actions,
}: {
  platform: Platform;
  check: ProfileCheck | null;
  asks: AsksOutput | null;
  actions: AskActions | null;
}) {
  // Every network's checks, for the links to add: where the screen has its business (never in a test's bare card).
  const ws = useOptionalBusiness()?.business.id ?? null;
  const loaded = useOutreachAnswer(
    check && ws
      ? async () =>
          unwrap(await api.POST('/v1/queries/outreach.profiles', { body: { workspaceId: ws } }))
      : null,
    `profiles:${ws}:${check?.at ?? 'none'}`,
    'Your profile',
  );
  const known = React.useMemo<ProfilesKnown | null>(
    () =>
      check
        ? {
            ...((loaded.data as unknown as ProfilesKnown | null) ?? { booking: {}, website: null }),
            checks: {
              ...((loaded.data as unknown as ProfilesKnown | null)?.checks ?? {}),
              [platform]: check,
            },
          }
        : null,
    [loaded.data, check, platform],
  );
  // Who does each goes by the person's computer's build: one before 0.93.0 hands Facebook's username and links over,
  // and one before 0.94.0 Facebook's name and Instagram's username and name (decision 89).
  const rows = known
    ? profileParts(platform, known, asks?.computer?.version).filter(
        (r) => REST_PARTS.includes(r.part) && r.how !== 'tip',
      )
    : [];
  // Facebook's links to take off or change (answer 16a), and when they started the work (LinkedIn asks).
  const changes = rows.some((r) => r.part === 'links')
    ? linkChangesFor(platform, check, asks?.computer?.version)
    : [];
  const [changesOn, setChangesOn] = React.useState<ReadonlySet<string>>(new Set());
  const [since, setSince] = React.useState('');
  const links = known
    ? linksToAdd(platform, known)
        .filter((l) => !l.held)
        .map((l) => l.url)
    : [];
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(new Set());
  const [username, setUsername] = React.useState<string | null>(null);
  const [asking, setAsking] = React.useState(false);
  React.useEffect(() => {
    setTicked(
      new Set(
        rows
          .filter(
            (r) =>
              !r.ok &&
              r.part !== 'username' &&
              (r.next.length > 0 || (r.part === 'links' && changes.length > 0)),
          )
          .map((r) => r.part),
      ),
    );
    setUsername(null);
    // A link is taken off or changed only once it's switched on (answer 16a).
    setChangesOn(new Set());
    setSince('');
    // A new check, or new links, starts afresh.
  }, [check?.at, links.length]);
  // A check from before the whole profile was has nothing to say of these: read it again for that.
  if (!check?.look || !rows.length) return null;
  const name = check.names?.[0] ?? check.nameDraft ?? null;
  const offered = firstUsername(check);
  const pickedChanges = linkChangesEdit(check, changesOn);
  // The rest (decision 99), as the web works them out.
  const work = workEdit(platform, check, since);
  const featured = known ? featuredEdit(platform, check, known) : null;
  const ideal = platform === 'alignable' ? (check.idealDraft ?? null) : null;
  const services = platform === 'alignable' ? (check.services ?? []) : [];
  const can = (part: string): boolean =>
    part === 'username'
      ? !!username
      : part === 'name'
        ? !!name
        : part === 'links'
          ? links.length > 0 || pickedChanges.length > 0
          : part === 'work'
            ? platform === 'alignable'
              ? !!ideal
              : work.edit !== null
            : platform === 'alignable'
              ? services.length > 0
              : featured !== null;
  const on = (part: string) => ticked.has(part) && can(part);
  const edit = {
    ...(on('name') && name ? { name } : {}),
    ...(on('username') && username ? { username } : {}),
    ...(on('links') && links.length ? { links } : {}),
    ...(on('links') && pickedChanges.length ? { linkChanges: pickedChanges } : {}),
    ...(on('work') && work.edit ? { work: work.edit } : {}),
    ...(on('work') && ideal ? { ideal } : {}),
    ...(on('featured') && featured ? { featured } : {}),
    ...(on('featured') && services.length ? { services } : {}),
  };
  const count = rows.filter((r) => on(r.part)).length;
  const toggle = (part: string) =>
    setTicked((was) => {
      const next = new Set(was);
      if (next.has(part)) next.delete(part);
      else next.add(part);
      return next;
    });
  return (
    <View className="gap-2" testID="ready-profile-rest">
      <Text className="text-[14px] font-semibold">{W.whatToChange}</Text>
      {rows.map((row) => {
        const value =
          row.part === 'username'
            ? username
              ? shownUsername(platform, username)
              : null
            : row.part === 'name'
              ? name
              : row.part === 'links'
                ? links.length
                  ? links.join(', ')
                  : null
                : row.part === 'work' && check.workDraft && platform !== 'alignable'
                  ? workLine(check.workDraft)
                  : null;
        const lines =
          row.part === 'featured' && platform === 'alignable'
            ? services.map(serviceLine)
            : row.part === 'featured' || (row.part === 'work' && platform === 'alignable')
              ? row.next
              : [];
        const ok = on(row.part);
        return (
          <View
            key={row.part}
            className="gap-1.5 border-t border-border pt-2.5"
            testID={`ready-part-${row.part}`}
          >
            <View className="flex-row items-center justify-between gap-2">
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{
                  checked: ok,
                  disabled: !can(row.part) || row.ok,
                }}
                disabled={!can(row.part) || row.ok}
                onPress={() => toggle(row.part)}
                className="min-h-[44px] flex-1 flex-row items-center gap-2.5"
                testID={`ready-part-${row.part}-tick`}
              >
                {row.ok ? (
                  <Icon as={CircleCheck} className="size-5 text-success" />
                ) : (
                  <View
                    className={cn(
                      'size-5 items-center justify-center rounded-[6px] border-[1.5px]',
                      ok ? 'border-accent bg-accent' : 'border-border-strong bg-card',
                    )}
                  >
                    {ok ? <Icon as={Check} className="size-3.5 text-white" /> : null}
                  </View>
                )}
                <Text className="text-[14px] font-semibold">{row.name}</Text>
              </Pressable>
              <PartBadge row={row} />
            </View>
            {row.now ? (
              <Text className="text-[13px] leading-[18px] text-text-3">
                {W.now}: {row.part === 'username' ? shownUsername(platform, row.now) : row.now}
              </Text>
            ) : null}
            {value && !row.ok ? (
              <Text selectable className="text-[14px] leading-[20px]">
                {value}
              </Text>
            ) : null}
            {!row.ok && lines.length ? (
              <View className="gap-1.5" testID={`ready-part-${row.part}-next`}>
                {lines.map((line) => (
                  <View key={line} className="rounded-menu bg-accent-soft px-3 py-2">
                    {row.part === 'featured' && platform !== 'alignable' ? (
                      <Text className="text-[12px] font-medium text-text-2">
                        {featured?.link === line ? E.link : E.post}
                      </Text>
                    ) : null}
                    <Text selectable className="text-[14px] leading-[20px]">
                      {line}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            {row.part === 'work' && !row.ok && check.workDraft && platform !== 'alignable' ? (
              <View className="gap-1.5">
                {check.workDraft.words ? <Note>{check.workDraft.words}</Note> : null}
                <Text className="text-[13px] font-medium">{E.since}</Text>
                <Input
                  value={since}
                  onChangeText={setSince}
                  placeholder="March 2021"
                  invalid={!!work.why && !!since.trim()}
                  accessibilityLabel={E.since}
                  testID="ready-work-since"
                />
                <Note>{work.why && since.trim() ? work.why : E.sinceHint(platform)}</Note>
              </View>
            ) : null}
            {row.part === 'links' && !row.ok && changes.length ? (
              <View className="gap-2 rounded-menu bg-card-2 p-3" testID="ready-link-changes">
                <Text className="text-[13px] font-semibold">{E.changes}</Text>
                {changes.map((c) => (
                  <View key={c.link} className="flex-row items-center gap-3">
                    <View className="flex-1 gap-0.5">
                      <Text className="text-[12.5px] text-text-3 line-through">{c.link}</Text>
                      <Text className="text-[14px] font-medium">
                        {c.to ? E.changeTo(c.to) : E.takeOff}
                      </Text>
                      <Note>{c.why}</Note>
                    </View>
                    <Switch
                      label={c.to ? E.changeTo(c.to) : `${E.takeOff}: ${c.link}`}
                      checked={changesOn.has(c.link)}
                      onCheckedChange={(next) =>
                        setChangesOn((was) => {
                          const s = new Set(was);
                          if (next) s.add(c.link);
                          else s.delete(c.link);
                          return s;
                        })
                      }
                    />
                  </View>
                ))}
                <Note>{E.changesHint}</Note>
              </View>
            ) : null}
            {row.part === 'username' && !row.ok && offered && !username ? (
              asking ? (
                <View className="gap-1.5 rounded-menu bg-card-2 p-3" testID="ready-username-ask">
                  <Text className="text-[13px] font-semibold">{U.changes}</Text>
                  {row.now ? <Note>{U.oldLinks(shownUsername(platform, row.now))}</Note> : null}
                  <Note>{U.search}</Note>
                  <Note>{U.limit(platform)}</Note>
                  <View className="flex-row flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="secondary" onPress={() => setAsking(false)}>
                      <Text>{U.keep}</Text>
                    </Button>
                    <Button
                      size="sm"
                      onPress={() => {
                        setUsername(offered.value);
                        setTicked((was) => new Set([...was, 'username']));
                        setAsking(false);
                      }}
                      testID="ready-username-use"
                    >
                      <Text>{U.use(shownUsername(platform, offered.value))}</Text>
                    </Button>
                  </View>
                </View>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => setAsking(true)}
                  testID="ready-username-open"
                >
                  <Text>{U.title(platform).replace('?', '…')}</Text>
                </Button>
              )
            ) : null}
            {row.ok ? null : (
              <Note>{row.how === 'app' ? W.howHint.app(platform) : W.howHint[row.how]}</Note>
            )}
          </View>
        );
      })}
      {asks && actions ? (
        <AskButton
          asks={asks}
          ask={{ kind: 'profile_edit', ...edit }}
          platform={platform}
          label={W.putIn(Math.max(count, 1))}
          variant="primary"
          actions={actions}
          disabled={count === 0}
          testID="ready-rest-put-in"
        />
      ) : null}
      <Note>{W.putInHint}</Note>
    </View>
  );
}

/** The photo, judged, and where pictures are changed: the person's own (decision 64). */
export function ProfilePicturesNote({
  platform,
  check,
}: {
  platform: Platform;
  check: ProfileCheck | null;
}) {
  const photo = check?.items.picture;
  if (!check?.look) return null;
  return (
    <View className="gap-1 rounded-menu bg-card-2 px-3 py-2.5" testID="ready-pictures">
      <Text className="text-[14px] font-semibold">{PICTURE_WORDS.titleOn(platform)}</Text>
      {photo ? (
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          {photo.ok ? photo.why : (photo.fix ?? photo.why)}
        </Text>
      ) : null}
      <Note>{partStepsWords(platform, 'picture')}</Note>
    </View>
  );
}
