import {
  goingInto,
  MAIN_OFFER_BAR,
  MAIN_OFFER_LIMITS,
  MAIN_OFFER_PHONE_WORDS as PW,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  OFFER_DIRECTION_PICKS,
  OFFER_NOTE_PICKS,
  offerChecks,
  partSays,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  underBarTitle,
  type MainOfferNotes,
  type MainOfferParts,
  type MainOfferScore,
  type ScoredPart,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { TextArea } from '@/components/ai-setup/fields';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Compass,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Sparkles,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The main offer's Review step on the phone, as the web's (apps/web/src/components/main-offer/review.tsx) and the
 * boards (design/main-offer, 12): the score at a glance, each part as a card, and the owner's direction. What they
 * say and decide is core's.
 */

/** A line added to a note or the direction: after what's there, with a space. */
export const withLine = (was: string, line: string) => {
  const t = was.trim();
  return t ? `${t} ${line}` : line;
};

const low = (score: number) => score < MAIN_OFFER_BAR;

/** A part's number in a round badge, green at the bar and over, amber under it. */
export function ScoreDot({ part, score }: { part: ScoredPart; score: number }) {
  return (
    <View
      className={cn(
        'size-8 shrink-0 items-center justify-center rounded-full',
        low(score) ? 'bg-warning-soft' : 'bg-success-soft',
      )}
      accessibilityLabel={PW.scoreOutOf(SCORED_PART_LABELS[part], score)}
    >
      <Text
        className={cn(
          'text-[14px] font-semibold tabular-nums',
          low(score) ? 'text-warning-text' : 'text-success-text',
        )}
      >
        {score}
      </Text>
    </View>
  );
}

/** A small chip on a part: kept as is, your note, scored with your direction. */
function Tag({
  tone,
  icon,
  children,
}: {
  tone: 'plain' | 'accent';
  icon?: typeof Lock;
  children: string;
}) {
  return (
    <View
      className={cn(
        'h-[22px] flex-row items-center gap-1 self-start rounded-[6px] px-[7px]',
        tone === 'plain' ? 'bg-card-2' : 'bg-accent-soft',
      )}
    >
      {icon ? (
        <Icon
          as={icon}
          className={cn('size-3', tone === 'plain' ? 'text-text-2' : 'text-accent-text')}
        />
      ) : null}
      <Text
        className={cn('text-xs font-medium', tone === 'plain' ? 'text-text-2' : 'text-accent-text')}
      >
        {children}
      </Text>
    </View>
  );
}

/** "Scored with your direction", beside a part the owner's direction changed the judging of. */
export function WithDirection() {
  return <Tag tone="accent">{TW.withDirection}</Tag>;
}

const Overline = ({ children, className }: { children: string; className?: string }) => (
  <Text
    className={cn('text-[11.5px] font-semibold uppercase tracking-[0.46px] text-text-3', className)}
  >
    {children}
  </Text>
);

/** The score at a glance: which parts are under the bar, every part's number, and the quick checks. */
export function ScoreGlance({ score }: { score: MainOfferScore }) {
  return (
    <Card className="gap-3 px-4 py-3.5" testID="offer-score">
      <View className="gap-1">
        <Text className="text-[16px] font-semibold" testID="offer-score-title">
          {underBarTitle(score)}
        </Text>
        <Text className="text-[13.5px] leading-[19px] text-text-2">{score.fix}</Text>
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {SCORED_PARTS.map((p) => {
          const n = score.parts[p].score;
          return (
            <View
              key={p}
              className={cn(
                'h-8 flex-row items-center gap-[7px] rounded-full border bg-card pl-[11px] pr-[5px]',
                low(n) ? 'border-warning' : 'border-border',
              )}
              accessibilityLabel={PW.scoreOutOf(SCORED_PART_LABELS[p], n)}
            >
              <Text className="text-[13px] font-medium">{SCORED_PART_LABELS[p]}</Text>
              <View
                className={cn(
                  'h-[22px] min-w-[22px] items-center justify-center rounded-full px-1',
                  low(n) ? 'bg-warning-soft' : 'bg-success-soft',
                )}
              >
                <Text
                  className={cn(
                    'text-xs font-semibold tabular-nums',
                    low(n) ? 'text-warning-text' : 'text-success-text',
                  )}
                >
                  {n}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      <View className="gap-2 border-t border-border pt-3">
        {offerChecks(score).map(({ text, ok }) => (
          <View key={text} className="flex-row items-center gap-2">
            <Badge variant={ok ? 'ok' : 'pending'}>{ok ? W.yes : W.notYet}</Badge>
            <Text className="flex-1 text-[13.5px]">{text}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

/** What a part needs from the owner on the review: a note for the AI, whether to keep it, and editing it. */
export interface PartEdits {
  readonly note: string;
  readonly onNote: (note: string) => void;
  readonly kept: boolean;
  readonly onKeep: (kept: boolean) => void;
  readonly onEdit: () => void;
}

/**
 * One part of the offer, scored: its name, the line on why, its number and its tags, and opened, what it says now,
 * what's working, what's holding it back and the AI's fix. With `edits`, also a note for the AI, Keep this part as is
 * and Edit it myself.
 */
export function PartCard({
  part,
  parts,
  score,
  edits,
  defaultOpen = false,
}: {
  part: ScoredPart;
  parts: MainOfferParts;
  score: MainOfferScore;
  edits?: PartEdits;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const s = score.parts[part];
  const label = SCORED_PART_LABELS[part];
  const kept = edits?.kept ?? false;
  const noted = !!edits?.note.trim();
  return (
    <Card className={cn(low(s.score) && 'border-warning')} testID={`offer-part-${part}`}>
      <Pressable
        role="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        className="min-h-16 flex-row items-center gap-3 py-3 pl-4 pr-3.5 active:bg-card-2"
        testID={`offer-part-${part}-toggle`}
      >
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-semibold">{label}</Text>
          <Text numberOfLines={open ? undefined : 2} className="text-[13px] text-text-2">
            {s.why}
          </Text>
          {kept || noted || s.followedDirection ? (
            <View className="flex-row flex-wrap gap-1.5 pt-0.5">
              {kept ? (
                <Tag tone="plain" icon={Lock}>
                  {TW.keptAsIs}
                </Tag>
              ) : null}
              {noted ? (
                <Tag tone="accent" icon={MessageSquare}>
                  {TW.hasNote}
                </Tag>
              ) : null}
              {s.followedDirection ? <WithDirection /> : null}
            </View>
          ) : null}
        </View>
        <ScoreDot part={part} score={s.score} />
        <View style={open ? { transform: [{ rotate: '180deg' }] } : undefined}>
          <Icon as={ChevronDown} className="size-[18px] text-text-3" />
        </View>
      </Pressable>
      {open ? (
        <View className="gap-3.5 border-t border-border px-4 pb-4 pt-3.5">
          <View className="gap-1 rounded-menu bg-card-2 px-3.5 py-3">
            <Overline>{TW.saysNow}</Overline>
            <Text className="leading-[22px]">{partSays(parts, part) || W.notYet}</Text>
          </View>
          <Lines title={TW.working} tone="ok" lines={s.good ?? []} />
          <Lines title={TW.holding} tone="low" lines={s.holding ?? []} />
          {s.fix ? (
            <View className="flex-row items-start gap-2 rounded-menu bg-warning-soft px-3.5 py-3">
              <Icon as={Sparkles} className="mt-0.5 size-4 text-warning-text" />
              <Text className="flex-1 text-[14px] leading-[20px] text-warning-text">
                <Text className="text-[14px] font-semibold text-warning-text">{TW.aiFix}</Text>{' '}
                {s.fix}
              </Text>
            </View>
          ) : null}
          {edits ? <PartNote part={part} edits={edits} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function Lines({ title, tone, lines }: { title: string; tone: 'ok' | 'low'; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <View className="gap-2">
      <Overline className={tone === 'ok' ? 'text-success-text' : 'text-warning-text'}>
        {title}
      </Overline>
      {lines.map((l) => (
        <View key={l} className="flex-row items-start gap-2">
          <Icon
            as={tone === 'ok' ? Check : CircleAlert}
            className={cn('mt-0.5 size-4', tone === 'ok' ? 'text-success' : 'text-warning')}
          />
          <Text className="flex-1 text-[14px] leading-[20px]">{l}</Text>
        </View>
      ))}
    </View>
  );
}

/** Quick picks that add a line to a note or the direction. */
function Picks({
  picks,
  onPick,
  testID,
}: {
  picks: readonly (readonly [string, string])[];
  onPick: (line: string) => void;
  testID: string;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {picks.map(([label, line], i) => (
        <Pressable
          key={label}
          role="button"
          onPress={() => onPick(line)}
          className="h-10 flex-row items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 active:bg-card-2"
          testID={`${testID}-${i}`}
        >
          <Icon as={Plus} className="size-3.5 text-text-2" />
          <Text className="text-[13.5px] text-text-2">{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function PartNote({ part, edits }: { part: ScoredPart; edits: PartEdits }) {
  return (
    <>
      <View className="gap-2">
        <Text className="text-[14px] font-medium" nativeID={`offer-note-${part}-label`}>
          {TW.yourNote}
        </Text>
        <TextArea
          value={edits.note}
          onChangeText={edits.onNote}
          maxLength={MAIN_OFFER_LIMITS.note}
          placeholder={TW.notePlaceholder}
          accessibilityLabelledBy={`offer-note-${part}-label`}
          testID={`offer-part-${part}-note`}
        />
        <Picks
          picks={OFFER_NOTE_PICKS}
          onPick={(line) => edits.onNote(withLine(edits.note, line))}
          testID={`offer-part-${part}-pick`}
        />
      </View>
      <View className="min-h-12 flex-row items-center justify-between gap-3.5">
        <Text className="flex-1 text-[14px] font-medium">{TW.keepAsIs}</Text>
        <Switch
          label={TW.keepAsIs}
          checked={edits.kept}
          onCheckedChange={edits.onKeep}
          testID={`offer-part-${part}-keep`}
        />
      </View>
      <View className="flex-row">
        <Button
          variant="ghost"
          size="sm"
          icon={Pencil}
          className="-ml-3"
          onPress={edits.onEdit}
          testID={`offer-part-${part}-edit`}
        >
          {TW.editMyself}
        </Button>
      </View>
    </>
  );
}

/** The owner's direction for the whole offer, what goes into the next try, and Make a try. */
export function DirectionBox({
  direction,
  onDirection,
  notes,
  keep,
  nextTry,
  busy,
  disabled,
  onMake,
}: {
  direction: string;
  onDirection: (direction: string) => void;
  notes: MainOfferNotes;
  keep: readonly ScoredPart[];
  nextTry: string;
  busy: boolean;
  disabled: boolean;
  onMake: () => void;
}) {
  const going = goingInto(direction, notes, keep);
  return (
    <Card className="gap-3.5 border-accent p-4" testID="offer-direction-box">
      <View className="flex-row items-start gap-3">
        <View className="size-[38px] items-center justify-center rounded-menu bg-accent-soft">
          <Icon as={Compass} className="size-[18px] text-accent-text" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-lg font-semibold tracking-[-0.18px]" role="heading">
            {TW.directionTitle}
          </Text>
          <Text className="text-[13.5px] leading-[19px] text-text-2">{TW.directionHint}</Text>
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-[14px] font-medium" nativeID="offer-direction-label">
          {TW.directionLabel}
        </Text>
        <TextArea
          value={direction}
          onChangeText={onDirection}
          maxLength={MAIN_OFFER_LIMITS.direction}
          placeholder={TW.directionPlaceholder}
          className="h-44"
          accessibilityLabelledBy="offer-direction-label"
          testID="offer-direction"
        />
        <Picks
          picks={OFFER_DIRECTION_PICKS}
          onPick={(line) => onDirection(withLine(direction, line))}
          testID="offer-direction-pick"
        />
      </View>
      <View className="gap-2 rounded-menu bg-card-2 px-3.5 py-3">
        <Overline>{TW.goingInto(nextTry)}</Overline>
        <View className="flex-row flex-wrap gap-1.5" testID="offer-going-into">
          {going.map((g) => (
            <Tag key={g.key} tone={g.kept ? 'plain' : 'accent'}>
              {g.text}
            </Tag>
          ))}
        </View>
      </View>
      <Button loading={busy} disabled={disabled} onPress={onMake} testID="offer-make-try">
        {busy ? TW.making(nextTry) : TW.makeTry(nextTry)}
      </Button>
      <Text className="text-[12.5px] leading-[17px] text-text-3">{PW.draftStays}</Text>
    </Card>
  );
}
