import {
  DESK_QUICK_LOOK_WORDS,
  DESK_SETUP_STATE_WORDS,
  deskActiveAgo,
  deskActivityBars,
  deskProblemReportLine,
  deskSetupScore,
  deskTrafficLines,
  type DeskFlag,
  type DeskFlagTone,
  type DeskSetupRow,
  type DeskSetupState,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import type { Ok } from '@/admin/live';
import { Line, Section } from '@/components/admin/bits';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * One business at a glance, in the pieces the quick look's sheet (business-quick-look.tsx) and the business's own
 * screen both show: the web's components/admin/business-glance.tsx at phone width. Each takes the test id it answers
 * to, so either screen names its own.
 */

type Glance = Ok<'/v1/queries/platform.business.glance'>;

const FLAG_TONE: Readonly<Record<DeskFlagTone, { box: string; text: string; dot: string }>> = {
  danger: { box: 'bg-danger-soft', text: 'text-danger-text', dot: 'bg-danger' },
  warning: { box: 'bg-warning-soft', text: 'text-warning-text', dot: 'bg-warning' },
  accent: { box: 'bg-accent-soft', text: 'text-accent-text', dot: 'bg-accent' },
};

const SETUP_BADGE: Readonly<Record<DeskSetupState, 'ok' | 'gray' | 'pending' | 'danger'>> = {
  yes: 'ok',
  no: 'gray',
  waiting: 'pending',
  problem: 'danger',
};

/** What needs a look, or that nothing does: `<testID>-flags`, `<testID>-flag-<key>`, `<testID>-calm`. */
export function GlanceFlags({ flags, testID }: { flags: readonly DeskFlag[]; testID: string }) {
  if (!flags.length)
    return (
      <View className="rounded-[10px] bg-success-soft px-3 py-2.5" testID={`${testID}-calm`}>
        <Text className="text-[13.5px] text-success-text">
          {DESK_QUICK_LOOK_WORDS.nothingNeedsALook}
        </Text>
      </View>
    );
  return (
    <View className="gap-1.5" testID={`${testID}-flags`}>
      {flags.map((f) => (
        <View
          key={f.key}
          className={cn('flex-row gap-2.5 rounded-[10px] px-3 py-2.5', FLAG_TONE[f.tone].box)}
          testID={`${testID}-flag-${f.key}`}
        >
          <View className={cn('mt-1.5 size-2 rounded-full', FLAG_TONE[f.tone].dot)} />
          <Text className={cn('min-w-0 flex-1 text-[13.5px]', FLAG_TONE[f.tone].text)}>
            {f.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The last 30 days: a bar a day, then texts, calls, emails and AI replies. */
export function GlanceActivity({ glance, testID }: { glance: Glance; testID: string }) {
  const total = glance.activity.reduce((a, n) => a + n, 0);
  const bars = deskActivityBars(glance.activity);
  return (
    <Section
      title={DESK_QUICK_LOOK_WORDS.lastThirtyDays}
      end={
        <Text className="text-[12.5px] text-text-3">
          {DESK_QUICK_LOOK_WORDS.activityTotal(total)}
        </Text>
      }
      testID={testID}
    >
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={DESK_QUICK_LOOK_WORDS.activityChart(total)}
        className="h-12 flex-row items-end gap-[2px]"
      >
        {bars.map((share, i) => (
          <View
            key={i}
            className={cn(
              'flex-1 rounded-[2px]',
              share === 0 ? 'bg-card-3' : i === bars.length - 1 ? 'bg-accent' : 'bg-accent-soft-2',
            )}
            style={{ height: `${Math.max(4, Math.round(share * 100))}%` }}
          />
        ))}
      </View>
      <View className="flex-row justify-between">
        <Text className="text-[11px] text-text-3">{DESK_QUICK_LOOK_WORDS.thirtyDaysAgo}</Text>
        <Text className="text-[11px] text-text-3">{DESK_QUICK_LOOK_WORDS.today}</Text>
      </View>
      <View className="gap-2">
        {deskTrafficLines(glance.traffic).map((t) => (
          <Line key={t.label} label={t.label} value={t.value} />
        ))}
      </View>
    </Section>
  );
}

/** A titled card of label and value lines: the plan, the balance, their money, more about them. */
export function GlanceLines({
  title,
  detail,
  lines,
  testID,
}: {
  title: string;
  detail?: string;
  lines: readonly {
    readonly label: string;
    readonly value: string;
    readonly tone?: 'danger' | null;
  }[];
  testID: string;
}) {
  return (
    <Section title={title} detail={detail} testID={testID}>
      <View className="gap-2">
        {lines.map((l) => (
          <Line
            key={l.label}
            label={l.label}
            value={l.value}
            tone={l.tone ?? undefined}
            testID={`${testID}-${l.label}`}
          />
        ))}
      </View>
    </Section>
  );
}

/** What is set up, row by row: `<testID>-<key>` each. */
export function GlanceSetup({
  setup,
  title,
  testID,
}: {
  setup: readonly DeskSetupRow[];
  title: string;
  testID: string;
}) {
  return (
    <Section
      title={title}
      end={<Text className="text-[12.5px] text-text-3">{deskSetupScore(setup)}</Text>}
      testID={testID}
    >
      <View className="gap-3">
        {setup.map((s) => (
          <View key={s.key} className="flex-row items-start gap-3" testID={`${testID}-${s.key}`}>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[13.5px] font-medium">{s.label}</Text>
              <Text className="text-[13px] text-text-3">{s.detail}</Text>
            </View>
            <Badge variant={SETUP_BADGE[s.state]}>{DESK_SETUP_STATE_WORDS[s.state]}</Badge>
          </View>
        ))}
      </View>
    </Section>
  );
}

/** Their last few problem reports, and whether somebody has handled each. */
export function GlanceProblemReports({ glance, testID }: { glance: Glance; testID: string }) {
  const reports = glance.problemReports.recent;
  return (
    <Section title={DESK_QUICK_LOOK_WORDS.problemReports} testID={testID}>
      {reports.length === 0 ? (
        <Text className="text-[13.5px] text-text-3">{DESK_QUICK_LOOK_WORDS.noProblemReports}</Text>
      ) : (
        reports.map((r) => (
          <View key={r.id} className="flex-row items-start gap-3" testID={`${testID}-${r.id}`}>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[13.5px]">{deskProblemReportLine(r)}</Text>
              <Text className="text-[12.5px] text-text-3">{deskActiveAgo(r.createdAt)}</Text>
            </View>
            <Badge variant={r.handled ? 'ok' : 'pending'}>
              {r.handled ? DESK_QUICK_LOOK_WORDS.handled : DESK_QUICK_LOOK_WORDS.notHandled}
            </Badge>
          </View>
        ))
      )}
    </Section>
  );
}
