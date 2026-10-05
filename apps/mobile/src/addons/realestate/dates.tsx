import { fmtTime, localDateOf } from '@hfos/core';
import type { TermSource } from '@hfos/core/addons/realestate/dates/key-dates';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_DATES_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { SOURCE_WORDS } from '@hfos/core/addons/realestate/rule-words';
import { isDoneDuty } from '@hfos/core/addons/realestate/states';
import {
  termEntriesOfCopy,
  type CopyTermEntry,
} from '@hfos/core/addons/realestate/views/deal-facts';
import { dealPageOfCopy, type DealPage } from '@hfos/core/addons/realestate/views/deal-page';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import {
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardCheck,
  TriangleAlert,
} from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { dayOf, Footnote, GroupLabel, KeptStrip } from './deal-bits';
import { NeedsSignalCard, openRe, useReContext } from './kit';

/**
 * Key dates (board 80): every date of the deal with where it came from, worked out on the phone from what it keeps
 * (business days and holidays too); a date that moved says when and from what. What's due today sits with them.
 */

export interface KeyDateRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  /** "Oct 3", or "Today". */
  readonly end: string;
  readonly date: string;
  readonly tone: 'ok' | 'warn' | 'plain' | 'duty';
  readonly dutyId?: string;
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const sourceWords = (source: string, ref: string | null) =>
  [capital(SOURCE_WORDS[source as TermSource]?.replace(/^(the|an?) /, '') ?? source), ref]
    .filter(Boolean)
    .join(' · ');

/** The deal's dates, coming up and done, with its duties due today among them. */
export function keyDateRows(
  page: DealPage,
  entries: readonly CopyTermEntry[],
  timeZone: string,
  now: number,
): { comingUp: KeyDateRow[]; done: KeyDateRow[] } {
  const today = localDateOf(now, timeZone);
  const rows: KeyDateRow[] = [];
  for (const t of page.terms) {
    if (t.kind !== 'date') continue;
    const e = t.entries[0];
    if (!e?.date) continue;
    // What it was before, if it moved: the newest entry it replaced with another date.
    const before = entries
      .filter(
        (x) => x.key === t.key && x.supersededAt !== null && x.valueDate && x.valueDate !== e.date,
      )
      .sort((a, b) => b.enteredAt.localeCompare(a.enteredAt))[0];
    const moved = before
      ? RE_DATES_WORDS.amended(
          dayOf(localDateOf(Date.parse(e.enteredAt), timeZone), timeZone, now)!,
          dayOf(before.valueDate, timeZone, now),
        )
      : null;
    rows.push({
      key: t.key,
      label: t.label,
      detail: [
        t.conflict ? RE_DATES_WORDS.disagree : null,
        moved ?? sourceWords(e.source, e.sourceRef),
        !t.confirmed && !t.conflict ? RE_DATES_WORDS.notConfirmed : null,
      ]
        .filter(Boolean)
        .join(' · '),
      end: dayOf(e.date, timeZone, now)!,
      date: e.date,
      tone: t.conflict ? 'warn' : e.date < today ? 'ok' : 'plain',
    });
  }
  for (const d of page.duties) {
    if (isDoneDuty(d.status) || !d.dueAt) continue;
    if (localDateOf(Date.parse(d.dueAt), timeZone) !== today) continue;
    rows.push({
      key: `duty:${d.dutyId}`,
      label: d.title,
      detail: [RE_DATES_WORDS.today, d.accountable?.name ?? null].filter(Boolean).join(' · '),
      end:
        fmtTime(d.dueAt, timeZone) === '11:59 PM'
          ? RE_DATES_WORDS.today
          : fmtTime(d.dueAt, timeZone),
      date: today,
      tone: 'duty',
      dutyId: d.dutyId,
    });
  }
  const order = (a: KeyDateRow, b: KeyDateRow) =>
    a.date.localeCompare(b.date) || Number(b.tone === 'duty') - Number(a.tone === 'duty');
  return {
    comingUp: rows.filter((r) => r.date >= today).sort(order),
    done: rows.filter((r) => r.date < today).sort(order),
  };
}

export function KeyDatesScreen({ dealId }: { dealId: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const page = React.useMemo(() => dealPageOfCopy(copy, dealId, ctx), [copy, dealId, ctx]);
  const entries = React.useMemo(() => termEntriesOfCopy(copy, dealId), [copy, dealId]);
  return (
    <KeyDatesView
      page={page}
      entries={entries}
      timeZone={ctx.timeZone}
      now={ctx.now}
      onDuty={(dutyId) => openRe(ctx.workspaceId, `deals/${dealId}?duty=${dutyId}`)}
    />
  );
}

export function KeyDatesView({
  page,
  entries,
  timeZone,
  now,
  onDuty,
}: {
  page: DealPage | null;
  entries: readonly CopyTermEntry[];
  timeZone: string;
  now: number;
  onDuty: (dutyId: string) => void;
}) {
  if (!page)
    return (
      <Screen title={RE_DATES_WORDS.title} leading="back" testID="re-dates">
        <NeedsSignalCard words={RE_PHONE_WORDS.notOnPhone} />
      </Screen>
    );
  const { comingUp, done } = keyDateRows(page, entries, timeZone, now);
  return (
    <Screen
      title={RE_DATES_WORDS.title}
      subtitle={page.deal.name}
      leading="back"
      testID="re-dates"
      header={<KeptStrip inset />}
    >
      {comingUp.length === 0 && done.length === 0 ? (
        <Card className="px-5 py-8">
          <Text className="text-center text-[14px] text-text-2">{RE_DATES_WORDS.empty}</Text>
        </Card>
      ) : null}
      {comingUp.length ? (
        <>
          <GroupLabel label={RE_DATES_WORDS.comingUp} />
          <DateList rows={comingUp} onDuty={onDuty} />
        </>
      ) : null}
      {done.length ? (
        <>
          <GroupLabel label={RE_DATES_WORDS.done} />
          <DateList rows={done} onDuty={onDuty} />
        </>
      ) : null}
      <Footnote>{RE_DATES_WORDS.footer}</Footnote>
    </Screen>
  );
}

function DateList({
  rows,
  onDuty,
}: {
  rows: readonly KeyDateRow[];
  onDuty: (dutyId: string) => void;
}) {
  return (
    <View className="overflow-hidden rounded-card border border-border bg-card">
      {rows.map((r, i) => {
        const icon =
          r.tone === 'ok'
            ? Check
            : r.tone === 'warn'
              ? TriangleAlert
              : r.tone === 'duty'
                ? ClipboardCheck
                : CalendarDays;
        const body = (
          <>
            <Icon
              as={icon}
              className={cn(
                'size-[18px]',
                r.tone === 'warn'
                  ? 'text-warning-text'
                  : r.tone === 'ok'
                    ? 'text-success'
                    : 'text-text-2',
              )}
            />
            <View className="min-w-0 flex-1 gap-px py-2">
              <Text className="text-[15px]">{r.label}</Text>
              {r.detail ? <Text className="text-[13px] text-text-3">{r.detail}</Text> : null}
            </View>
            <Text className="text-[14px] text-text-2">{r.end}</Text>
            {r.dutyId ? <Icon as={ChevronRight} className="size-4 text-text-3" /> : null}
          </>
        );
        const className = cn(
          'min-h-14 flex-row items-center gap-3 px-3.5',
          i > 0 && 'border-t border-border',
        );
        return r.dutyId ? (
          <Pressable
            key={r.key}
            role="button"
            onPress={() => onDuty(r.dutyId!)}
            className={cn(className, 'active:bg-card-2')}
            testID={`re-date-${r.key}`}
          >
            {body}
          </Pressable>
        ) : (
          <View key={r.key} className={className} testID={`re-date-${r.key}`}>
            {body}
          </View>
        );
      })}
    </View>
  );
}
