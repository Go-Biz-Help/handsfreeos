import {
  DESK_BUSINESS_WORDS,
  DESK_QUICK_LOOK_WORDS,
  DESK_SETUP_STATE_WORDS,
  deskActivityBars,
  deskBusinessFlags,
  deskMoreLines,
  deskPlanAndBalanceShort,
  deskPlanLabel,
  deskQuickLookCounts,
  deskSetupRows,
  deskSetupScore,
  deskTheirMoneyLines,
  deskTrafficLines,
  type DeskFlagTone,
  type DeskSetupState,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { desk, useLive, type Ok } from '@/admin/live';
import { dayWords } from '@/admin/words';
import { DeskWaiting, Line, Section, Stats } from '@/components/admin/bits';
import { deskHref } from '@/components/admin/staff-context';
import { ChevronLeft, ChevronRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** A business on the directory, as far as the quick look needs it before its details arrive. */
export interface QuickLookRow {
  readonly workspaceId: string;
  readonly name: string;
}

interface Look {
  readonly detail: Ok<'/v1/queries/platform.business.get'>;
  readonly wallet: Ok<'/v1/queries/platform.wallet.get'>;
  readonly glance: Ok<'/v1/queries/platform.business.glance'>;
}

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

/**
 * A business opened from the directory in a sheet over the list (the web's quick look, at phone width): what needs a
 * look, the numbers, 30 days of activity, the plan and balance, what is set up, what their customers paid them and
 * the rest worth knowing on a call. The arrows step through the list; the business's own screen, for its people,
 * tickets and changes, is a button away.
 */
export function BusinessQuickLook({
  rows,
  openId,
  onOpen,
  onClose,
}: {
  rows: readonly QuickLookRow[];
  openId: string | null;
  onOpen: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const index = rows.findIndex((r) => r.workspaceId === openId);
  const row = index >= 0 ? rows[index] : undefined;
  const step = (by: number) => {
    if (index < 0 || rows.length < 2) return;
    onOpen(rows[(index + by + rows.length) % rows.length]!.workspaceId);
  };

  // The business, its balance and its glance at once, as the web asks them. Nothing is asked while the sheet is shut.
  const live = useLive(
    () =>
      openId
        ? Promise.all([
            desk('/v1/queries/platform.business.get', { workspaceId: openId }),
            desk('/v1/queries/platform.wallet.get', { workspaceId: openId }),
            desk('/v1/queries/platform.business.glance', { workspaceId: openId }),
          ]).then(([detail, wallet, glance]) => ({ detail, wallet, glance }))
        : Promise.resolve(null),
    openId ?? '',
  );
  const look = live.data?.detail.business.workspaceId === openId ? live.data : null;

  const openBusiness = () => {
    if (!openId) return;
    onClose();
    router.push(deskHref(`businesses/${openId}`) as Href);
  };

  return (
    <Sheet
      open={openId !== null}
      onClose={onClose}
      title={row?.name ?? ''}
      scroll
      testID="business-quick-look"
    >
      <View className="mt-3 gap-3">
        <View className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1 gap-1.5">
            <Text className="text-[13px] text-text-3" testID="quick-look-headline">
              {look
                ? DESK_BUSINESS_WORDS.headline(
                    look.detail.business,
                    dayWords(look.detail.business.createdAt),
                  )
                : DESK_QUICK_LOOK_WORDS.loading}
            </Text>
            {look ? (
              <View className="flex-row flex-wrap gap-1.5">
                <Badge variant={look.glance.plan ? 'ok' : 'gray'} testID="quick-look-plan">
                  {deskPlanLabel(look.glance.plan)}
                </Badge>
                {look.detail.business.foundingSeat ? (
                  <Badge variant="ok">{look.detail.business.foundingSeat}</Badge>
                ) : null}
              </View>
            ) : null}
          </View>
          {rows.length > 1 ? (
            <View className="flex-row items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                icon={ChevronLeft}
                accessibilityLabel={DESK_QUICK_LOOK_WORDS.previous}
                onPress={() => step(-1)}
                testID="quick-look-previous"
              />
              <Text
                className="min-w-10 text-center text-xs text-text-3"
                testID="quick-look-position"
              >
                {DESK_QUICK_LOOK_WORDS.position(index + 1, rows.length)}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                icon={ChevronRight}
                accessibilityLabel={DESK_QUICK_LOOK_WORDS.next}
                onPress={() => step(1)}
                testID="quick-look-next"
              />
            </View>
          ) : null}
        </View>

        {look ? (
          <Glance look={look} />
        ) : openId ? (
          <DeskWaiting live={live} testID="quick-look" />
        ) : null}

        <Button variant="secondary" onPress={openBusiness} testID="quick-look-open">
          {DESK_BUSINESS_PHONE_WORDS.openBusiness}
        </Button>
      </View>
    </Sheet>
  );
}

function Glance({ look }: { look: Look }) {
  const { detail, wallet, glance } = look;
  const flags = deskBusinessFlags({ ...detail.business, tickets: detail.tickets }, glance, wallet);
  const setup = deskSetupRows(glance.setup);
  const total = glance.activity.reduce((a, n) => a + n, 0);
  const bars = deskActivityBars(glance.activity);

  return (
    <View className="gap-3">
      {flags.length ? (
        <View className="gap-1.5" testID="quick-look-flags">
          {flags.map((f) => (
            <View
              key={f.key}
              className={cn('flex-row gap-2.5 rounded-[10px] px-3 py-2.5', FLAG_TONE[f.tone].box)}
              testID={`quick-look-flag-${f.key}`}
            >
              <View className={cn('mt-1.5 size-2 rounded-full', FLAG_TONE[f.tone].dot)} />
              <Text className={cn('min-w-0 flex-1 text-[13.5px]', FLAG_TONE[f.tone].text)}>
                {f.text}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View className="rounded-[10px] bg-success-soft px-3 py-2.5" testID="quick-look-calm">
          <Text className="text-[13.5px] text-success-text">
            {DESK_QUICK_LOOK_WORDS.nothingNeedsALook}
          </Text>
        </View>
      )}

      <Stats items={deskQuickLookCounts(detail.counts, glance)} testID="quick-look-counts" />

      <Section
        title={DESK_QUICK_LOOK_WORDS.lastThirtyDays}
        end={
          <Text className="text-[12.5px] text-text-3">
            {DESK_QUICK_LOOK_WORDS.activityTotal(total)}
          </Text>
        }
        testID="quick-look-activity"
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
                share === 0
                  ? 'bg-card-3'
                  : i === bars.length - 1
                    ? 'bg-accent'
                    : 'bg-accent-soft-2',
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

      <Section title={DESK_QUICK_LOOK_WORDS.planAndBalance} testID="quick-look-plan-balance">
        <View className="gap-2">
          {deskPlanAndBalanceShort(glance.plan, wallet).map((l) => (
            <Line
              key={l.label}
              label={l.label}
              value={l.value}
              tone={l.tone ?? undefined}
              testID={`quick-look-line-${l.label}`}
            />
          ))}
        </View>
      </Section>

      <Section
        title={DESK_BUSINESS_WORDS.whatIsSetUp}
        end={<Text className="text-[12.5px] text-text-3">{deskSetupScore(setup)}</Text>}
        testID="quick-look-setup"
      >
        <View className="gap-3">
          {setup.map((s) => (
            <View
              key={s.key}
              className="flex-row items-start gap-3"
              testID={`quick-look-setup-${s.key}`}
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-[13.5px] font-medium">{s.label}</Text>
                <Text className="text-[13px] text-text-3">{s.detail}</Text>
              </View>
              <Badge variant={SETUP_BADGE[s.state]}>{DESK_SETUP_STATE_WORDS[s.state]}</Badge>
            </View>
          ))}
        </View>
      </Section>

      <Section title={DESK_QUICK_LOOK_WORDS.whatCustomersPayThem} testID="quick-look-their-money">
        <View className="gap-2">
          {deskTheirMoneyLines(glance).map((l) => (
            <Line key={l.label} label={l.label} value={l.value} tone={l.tone ?? undefined} />
          ))}
        </View>
      </Section>

      <Section title={DESK_QUICK_LOOK_WORDS.moreAboutThem} testID="quick-look-more">
        <View className="gap-2">
          {deskMoreLines(detail.business, glance, detail.phoneModel).map((m) => (
            <Line key={m.label} label={m.label} value={m.value} />
          ))}
        </View>
      </Section>
    </View>
  );
}
