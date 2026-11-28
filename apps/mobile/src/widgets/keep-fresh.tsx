import {
  addDays,
  BUILT_ADDONS,
  buildWidgetsData,
  findAddon,
  holds,
  localDateOf,
  type AddonWidgetFacts,
  type WidgetsInput,
} from '@hfos/core';
import * as React from 'react';
import { AppState } from 'react-native';

import { holdsAddon } from '@/addons/gate';
import { PHONE_ADDONS } from '@/addons/registry';
import { useCalendarRange, useCalendarZone } from '@/calendar/use-calendar';
import { useBusiness } from '@/components/shell/business-context';
import { useHome, useNow } from '@/home/use-home';
import { useGrants } from '@/lib/grants';
import { useMoneyRole, useMoneySummary } from '@/money/use-money';
import { useTasks } from '@/tasks/use-tasks';

import { onWidgetsRefresh, storeWidgets, useWidgetsStatus, widgetsHideNames } from './store';

/**
 * Keeps the home-screen widgets' copy of the business open now up to date (docs/phone-widgets.md): today's and
 * tomorrow's appointments, the person's tasks, what needs them, the money figures and each add-on's widget, all from
 * this phone's copy, rebuilt as it changes, when the app comes back to the front, and on Update now. Core works out
 * every moment ahead, so the widgets move along through the day on their own. Draws nothing but the add-ons' own
 * keepers, which draw nothing either. Not while viewing as a teammate: the widgets are the signed-in person's own.
 */

/** How often "now" moves while the app is open: the copy already holds every moment ahead, so rarely. */
const TICK_MS = 5 * 60_000;
/** Changes come in bursts (a sync brings many rows): build once they settle. */
const SETTLE_MS = 800;

const ADDON_WIDGETS = PHONE_ADDONS.filter((a) => a.WidgetFacts);

export function KeepWidgetsFresh() {
  const { business, me } = useBusiness();
  const grants = useGrants();
  const timeZone = useCalendarZone();
  const ticked = useNow(TICK_MS);
  const [woke, setWoke] = React.useState(0);
  const now = Math.max(ticked, woke);
  const today = localDateOf(now, timeZone);
  const days = React.useMemo(() => [today, addDays(today, 1)], [today]);
  const range = useCalendarRange(days, timeZone);
  const tasks = useTasks('mine');
  const home = useHome(null, now);
  const { whole, bill } = useMoneyRole();
  const moneyToday = useMoneySummary(timeZone, 0);
  const moneyWeek = useMoneySummary(timeZone, 6);
  const status = useWidgetsStatus();
  const userId = me.user.id;
  const hideNames = React.useMemo(() => widgetsHideNames(userId), [userId, status.version]);

  // Each add-on's figures, as its keeper reports them.
  const [facts, setFacts] = React.useState<Readonly<Record<string, AddonWidgetFacts>>>({});
  const reporters = React.useMemo(
    () =>
      Object.fromEntries(
        ADDON_WIDGETS.map((a) => [
          a.addonId,
          (f: AddonWidgetFacts) =>
            setFacts((was) => (was[a.addonId] === f ? was : { ...was, [a.addonId]: f })),
        ]),
      ),
    [],
  );
  const held = ADDON_WIDGETS.filter((a) => holdsAddon(grants, a.permission));

  // Back to the front: "now" is now, and anything that changed while away is in.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setWoke(Date.now());
    });
    return () => sub.remove();
  }, []);

  const input = React.useMemo((): WidgetsInput | null => {
    if (range.loading || home.loading || tasks.loading) return null;
    return {
      now,
      timeZone,
      business: { id: business.id, name: business.name },
      showBusiness: me.businesses.length > 1,
      hideNames,
      appointments: range.appointments,
      tasks: tasks.open.map((t) => ({ id: t.id, dueAt: t.dueAt, allDay: t.allDay })),
      needs: {
        items: home.list.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          detail: i.detail,
          urgent: i.urgent,
        })),
        total: home.list.counts.total,
        urgent: home.list.counts.urgent,
      },
      money:
        whole && moneyToday && moneyWeek
          ? {
              outstandingCents: moneyToday.outstandingCents,
              outstandingCount: moneyToday.outstandingCount,
              overdueCents: moneyToday.overdueCents,
              overdueCount: moneyToday.overdueCount,
              todayCents: moneyToday.collectedCents - moneyToday.refundedCents,
              weekCents: moneyWeek.collectedCents - moneyWeek.refundedCents,
            }
          : null,
      can: { contacts: holds(grants, 'records.write'), receipts: whole, invoices: bill },
      addons: ADDON_WIDGETS.map((a) => ({
        addonId: a.addonId,
        name: findAddon(BUILT_ADDONS, a.addonId)?.name ?? a.addonId,
        facts: holdsAddon(grants, a.permission) ? (facts[a.addonId] ?? null) : null,
      })),
    };
  }, [
    now,
    timeZone,
    business.id,
    business.name,
    me.businesses.length,
    hideNames,
    range.loading,
    range.appointments,
    home.loading,
    home.list,
    tasks.loading,
    tasks.open,
    whole,
    bill,
    moneyToday,
    moneyWeek,
    grants,
    facts,
  ]);

  const inputRef = React.useRef(input);
  inputRef.current = input;

  React.useEffect(() => {
    if (!input) return;
    const timer = setTimeout(() => storeWidgets(buildWidgetsData(input)), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  // Update now: built again from what the phone has, and saved even when nothing changed.
  React.useEffect(
    () =>
      onWidgetsRefresh(async () => {
        const latest = inputRef.current;
        if (latest) storeWidgets(buildWidgetsData({ ...latest, now: Date.now() }));
      }),
    [],
  );

  return (
    <>
      {held.map((a) => {
        const Facts = a.WidgetFacts!;
        return <Facts key={a.addonId} onFacts={reporters[a.addonId]!} />;
      })}
    </>
  );
}
