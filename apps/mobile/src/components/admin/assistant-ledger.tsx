import {
  DESK_LEDGER_WORDS,
  LEDGER_GAP_STATES,
  LEDGER_ITEM_STATES,
  LEDGER_VIEWS,
  type LedgerGapState,
  type LedgerItemState,
  type LedgerView,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { desk, useLive } from '@/admin/live';
import { DeskWaiting, FilterChips, Section } from '@/components/admin/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

const W = DESK_LEDGER_WORDS;
const PAGE = 50;

const coveredBadge = {
  yes: 'ok',
  partly: 'pending',
  no: 'danger',
  never: 'gray',
  person: 'gray',
} as const;
const severityBadge = { high: 'danger', medium: 'pending', low: 'gray' } as const;

/**
 * The web's checklist table on the phone (platform.assistant_ledger): every item on every screen and how the
 * Assistant covers it, the audit's gaps and the screens to check, picked by chips, fifty more at a time.
 */
export function AssistantLedgerSection() {
  const [view, setView] = React.useState<LedgerView>('items');
  const [area, setArea] = React.useState('');
  const [itemState, setItemState] = React.useState<LedgerItemState>('unmarked');
  const [gapState, setGapState] = React.useState<LedgerGapState>('open');
  const [q, setQ] = React.useState('');
  const [typed, setTyped] = React.useState('');
  const [limit, setLimit] = React.useState(PAGE);

  // Typing waits for a pause before asking.
  React.useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  React.useEffect(() => setLimit(PAGE), [view, area, itemState, gapState, q]);

  const live = useLive(
    () =>
      desk('/v1/queries/platform.assistant_ledger', {
        view,
        area: area || null,
        itemState,
        gapState,
        q,
        offset: 0,
        limit,
      }),
    `ledger-${view}-${area}-${itemState}-${gapState}-${q}-${limit}`,
  );
  // Show more keeps the rows already shown while the longer page comes.
  const answer = live.data && Array.isArray(live.data[view]) ? live.data : null;
  const last = React.useRef(answer);
  if (answer) last.current = answer;
  const data = answer ?? (limit > PAGE ? last.current : null);
  const shown = data ? data[view].length : 0;

  return (
    <Section title={W.title} detail={W.intro} testID="ledger">
      {data ? (
        <View className="flex-row flex-wrap gap-x-4 gap-y-1" testID="ledger-cards">
          <Text className="text-[13px] text-text-2">
            {W.cards.unmarked}: {W.showing(data.totals.unmarked, data.totals.items)}
          </Text>
          <Text className="text-[13px] text-text-2">
            {W.cards.changed}: {data.totals.changed}
          </Text>
          <Text className="text-[13px] text-text-2">
            {W.cards.newScreens}: {data.totals.newScreens}
          </Text>
          <Text className="text-[13px] text-text-2">
            {W.cards.gapsOpen}: {data.totals.gapsOpen}
          </Text>
        </View>
      ) : null}

      <FilterChips<LedgerView>
        options={LEDGER_VIEWS.map((v) => ({ key: v, label: W.views[v] }))}
        value={view}
        onChange={setView}
        testID="ledger-view"
      />
      <FilterChips<string>
        options={[
          { key: '', label: W.anyArea },
          ...(data?.areas ?? []).map((a) => ({
            key: a.key,
            label: a.title.split(':')[0] ?? a.key,
            count: view === 'gaps' ? a.gapsOpen : a.unmarked,
          })),
        ]}
        value={area}
        onChange={setArea}
        testID="ledger-area"
      />
      {view === 'items' ? (
        <FilterChips<LedgerItemState>
          options={LEDGER_ITEM_STATES.map((s) => ({ key: s, label: W.itemStates[s] }))}
          value={itemState}
          onChange={setItemState}
          testID="ledger-item-state"
        />
      ) : view === 'gaps' ? (
        <FilterChips<LedgerGapState>
          options={LEDGER_GAP_STATES.map((s) => ({ key: s, label: W.gapStates[s] }))}
          value={gapState}
          onChange={setGapState}
          testID="ledger-gap-state"
        />
      ) : null}
      <Input
        value={typed}
        onChangeText={setTyped}
        placeholder={W.search}
        accessibilityLabel={W.search}
        autoCapitalize="none"
        testID="ledger-search"
      />

      {!data ? (
        <DeskWaiting live={live} testID="ledger" />
      ) : (
        <View className="gap-2.5" testID={`ledger-${view}`}>
          <Text className="text-[12.5px] text-text-3" testID="ledger-count">
            {W.showing(shown, data.total)}
          </Text>
          {view === 'items' ? (
            data.items.length === 0 ? (
              <Text className="text-[13.5px] text-text-3">{W.none}</Text>
            ) : (
              data.items.map((i, n) => (
                <View key={`${i.area}-${n}`} className="gap-0.5 border-t border-border pt-2">
                  <View className="flex-row flex-wrap items-center gap-1.5">
                    <Badge variant={coveredBadge[i.covered]}>
                      <Text>{W.itemStates[i.covered]}</Text>
                    </Badge>
                    {i.changed ? (
                      <Badge variant="pending">
                        <Text>{W.itemStates.changed}</Text>
                      </Badge>
                    ) : null}
                    <Text className="text-[12.5px] text-text-3">{W.kind[i.kind]}</Text>
                  </View>
                  <Text className="text-[13.5px] font-medium">{i.path}</Text>
                  <Text className="text-[13px] leading-[18px] text-text-2">{i.by}</Text>
                  <Text selectable className="text-[11.5px] text-text-3">
                    {i.file}
                  </Text>
                </View>
              ))
            )
          ) : view === 'gaps' ? (
            data.gaps.length === 0 ? (
              <Text className="text-[13.5px] text-text-3">{W.noGaps}</Text>
            ) : (
              data.gaps.map((g) => (
                <View key={`${g.area}-${g.id}`} className="gap-0.5 border-t border-border pt-2">
                  <View className="flex-row flex-wrap items-center gap-1.5">
                    <Badge variant={severityBadge[g.severity]}>
                      <Text>{W.severity[g.severity]}</Text>
                    </Badge>
                    {g.status !== 'open' ? (
                      <Badge variant="ok">
                        <Text>{W.gapStates[g.status]}</Text>
                      </Badge>
                    ) : null}
                    {g.pr ? (
                      <Text className="text-[12.5px] text-text-3">{W.fixedIn(g.pr)}</Text>
                    ) : null}
                    <Text className="text-[12px] text-text-3">{g.id}</Text>
                  </View>
                  <Text className="text-[13.5px] font-medium">{g.where}</Text>
                  <Text className="text-[13px] leading-[18px] text-text-2">{g.gap}</Text>
                </View>
              ))
            )
          ) : data.screens.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{W.noScreens}</Text>
          ) : (
            data.screens.map((s) => (
              <View key={s.file} className="gap-0.5 border-t border-border pt-2">
                <Badge variant={s.state === 'new' ? 'pending' : 'danger'}>
                  <Text>{W.screenStates[s.state]}</Text>
                </Badge>
                <Text selectable className="text-[12px] text-text-2">
                  {s.file}
                </Text>
              </View>
            ))
          )}
          {shown < data.total && limit < 500 ? (
            <Button
              variant="secondary"
              onPress={() => setLimit((l) => Math.min(l + PAGE, 500))}
              testID="ledger-more"
            >
              <Text>{W.more}</Text>
            </Button>
          ) : null}
        </View>
      )}
    </Section>
  );
}
