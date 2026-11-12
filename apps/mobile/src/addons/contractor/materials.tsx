import { amountWords, type MaterialCount } from '@hfos/core/addons/contractor/materials';
import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import type { PhoneMaterial } from '@hfos/core/addons/contractor/views/phone';
import {
  CONTRACTOR_WORDS as W,
  MATERIAL_COUNT_HINTS,
  MATERIAL_COUNT_WORDS,
  MATERIAL_STATE_WORDS,
} from '@hfos/core/addons/contractor/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { SectionLabel } from './kit';

/**
 * A job's materials on the phone, or only what one visit needs (the owner's decision 9): how much of each is here,
 * and a count of what was used, wasted or sent back, which adds to what's counted already and waits with no signal.
 * Never a cost (decision 11). Ordering and deliveries are the office's, on the web.
 */

export type CountAmounts = Partial<Record<'used' | 'wasted' | 'returned', number>>;
const COUNTED: readonly ('used' | 'wasted' | 'returned')[] = ['used', 'wasted', 'returned'];

/** What was typed for one count: a number above nothing, nothing at all, or not a number. */
export function amountOf(text: string): number | null | 'bad' {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return 'bad';
  return n === 0 ? null : Math.round(n * 1000) / 1000;
}

export function MaterialsCard({
  title,
  materials,
  missing,
  none,
  waiting,
  canCount,
  onCount,
}: {
  title: string;
  materials: readonly PhoneMaterial[];
  missing: number;
  none: string;
  /** Materials with a count of the person's still on this phone. */
  waiting: ReadonlySet<string>;
  /** false on a job that's done or cancelled. */
  canCount: boolean;
  onCount: (material: PhoneMaterial, amounts: CountAmounts) => Promise<boolean>;
}) {
  const [counting, setCounting] = React.useState<PhoneMaterial | null>(null);
  return (
    <View className="gap-1.5" testID="co-materials">
      <SectionLabel>{title}</SectionLabel>
      {materials.length === 0 ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px] text-text-2">{none}</Text>
        </Card>
      ) : (
        <View className="overflow-hidden rounded-card border border-border bg-card">
          {materials.map((m, i) => (
            <Pressable
              key={m.id}
              role="button"
              disabled={!canCount}
              accessibilityLabel={P.materials.count(m.name)}
              onPress={() => setCounting(m)}
              testID={`co-material-${m.id}`}
              className={cn(
                'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
                i > 0 && 'border-t border-border',
              )}
            >
              <View className="min-w-0 flex-1 gap-px">
                <Text className="text-[15px]">{m.name}</Text>
                <Text className="text-[13px] text-text-3">
                  {[
                    W.materials.of(
                      amountWords(m.delivered, m.unitLabel),
                      amountWords(m.needed, m.unitLabel),
                    ),
                    m.used > 0 || m.wasted > 0 || m.returned > 0
                      ? P.materials.counts(
                          amountWords(m.used, m.unitLabel),
                          amountWords(m.left, m.unitLabel),
                        )
                      : null,
                    waiting.has(m.id) ? P.kept.waitingToSend : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {m.note ? (
                  <Text className="text-[13px] text-text-3" numberOfLines={2}>
                    {m.note}
                  </Text>
                ) : null}
              </View>
              <Badge variant={m.short > 0 ? 'pending' : m.state === 'used' ? 'gray' : 'ok'}>
                <Text>
                  {m.short > 0
                    ? W.materials.short(amountWords(m.short, m.unitLabel))
                    : MATERIAL_STATE_WORDS[m.state]}
                </Text>
              </Badge>
            </Pressable>
          ))}
        </View>
      )}
      {materials.length > 0 ? (
        <Text className="px-1 text-[12.5px] text-text-3" testID="co-materials-missing">
          {missing > 0 ? W.materials.missing(missing) : W.materials.allHere}
        </Text>
      ) : null}
      <CountSheet
        material={counting}
        onClose={() => setCounting(null)}
        onCount={async (amounts) => {
          if (!counting) return false;
          const ok = await onCount(counting, amounts);
          if (ok) setCounting(null);
          return ok;
        }}
      />
    </View>
  );
}

/** What was used, wasted or sent back just now, a field each: it adds to the count, so two people both count. */
export function CountSheet({
  material,
  onClose,
  onCount,
}: {
  material: PhoneMaterial | null;
  onClose: () => void;
  onCount: (amounts: CountAmounts) => Promise<boolean>;
}) {
  const [typed, setTyped] = React.useState<Record<string, string>>({});
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const id = material?.id;
  React.useEffect(() => {
    setTyped({});
    setProblem(null);
  }, [id]);

  const save = async () => {
    const amounts: CountAmounts = {};
    for (const key of COUNTED) {
      const n = amountOf(typed[key] ?? '');
      if (n === 'bad') {
        setProblem(P.materials.notANumber);
        return;
      }
      if (n !== null) amounts[key] = n;
    }
    if (Object.keys(amounts).length === 0) {
      setProblem(P.materials.nothing);
      return;
    }
    setBusy(true);
    await onCount(amounts);
    setBusy(false);
  };

  return (
    <Sheet
      open={material !== null}
      onClose={onClose}
      title={material ? P.materials.countTitle(material.name) : undefined}
      description={P.materials.countHint}
      testID="co-count-sheet"
    >
      {material ? (
        <View className="mt-2 gap-3">
          {COUNTED.map((key: MaterialCount & ('used' | 'wasted' | 'returned')) => (
            <View key={key} className="gap-1">
              <Text className="text-[13px] font-medium">
                {MATERIAL_COUNT_WORDS[key]}
                {material.unitLabel ? ` (${material.unitLabel})` : ''}
              </Text>
              <Input
                value={typed[key] ?? ''}
                onChangeText={(t) => {
                  setProblem(null);
                  setTyped((all) => ({ ...all, [key]: t }));
                }}
                keyboardType="decimal-pad"
                placeholder="0"
                accessibilityLabel={MATERIAL_COUNT_WORDS[key]}
                accessibilityHint={MATERIAL_COUNT_HINTS[key]}
                testID={`co-count-${key}`}
              />
            </View>
          ))}
          {problem ? (
            <Text className="text-[13px] text-danger-text" testID="co-count-problem">
              {problem}
            </Text>
          ) : null}
          <Button loading={busy} onPress={() => void save()} testID="co-count-save">
            {P.materials.add}
          </Button>
        </View>
      ) : null}
    </Sheet>
  );
}
