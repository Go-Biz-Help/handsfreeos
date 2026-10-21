import {
  DESK_BUSINESS_WORDS,
  DESK_QUICK_LOOK_WORDS,
  deskBusinessFlags,
  deskMoreLines,
  deskPlanAndBalanceShort,
  deskPlanLabel,
  deskQuickLookCounts,
  deskSetupRows,
  deskTheirMoneyLines,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { desk, useLive, type Ok } from '@/admin/live';
import { dayWords } from '@/admin/words';
import { DeskWaiting, Stats } from '@/components/admin/bits';
import {
  GlanceActivity,
  GlanceFlags,
  GlanceLines,
  GlanceSetup,
} from '@/components/admin/business-glance';
import { deskHref } from '@/components/admin/staff-context';
import { ChevronLeft, ChevronRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

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
  return (
    <View className="gap-3">
      <GlanceFlags
        flags={deskBusinessFlags({ ...detail.business, tickets: detail.tickets }, glance, wallet)}
        testID="quick-look"
      />
      <Stats items={deskQuickLookCounts(detail.counts, glance)} testID="quick-look-counts" />
      <GlanceActivity glance={glance} testID="quick-look-activity" />
      <GlanceLines
        title={DESK_QUICK_LOOK_WORDS.planAndBalance}
        lines={deskPlanAndBalanceShort(glance.plan, wallet)}
        testID="quick-look-plan-balance"
      />
      <GlanceSetup
        title={DESK_BUSINESS_WORDS.whatIsSetUp}
        setup={deskSetupRows(glance.setup)}
        testID="quick-look-setup"
      />
      <GlanceLines
        title={DESK_QUICK_LOOK_WORDS.whatCustomersPayThem}
        lines={deskTheirMoneyLines(glance)}
        testID="quick-look-their-money"
      />
      <GlanceLines
        title={DESK_QUICK_LOOK_WORDS.moreAboutThem}
        lines={deskMoreLines(detail.business, glance, detail.phoneModel)}
        testID="quick-look-more"
      />
    </View>
  );
}
