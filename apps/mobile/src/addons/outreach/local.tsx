/**
 * The phone's Settings → You: Where you are and Focus on local groups, and a person's card: What they do and where
 * (docs/outreach.md, decision 177), as the web shows them. Asked with signal (`outreach.location.get`, the card's
 * `outreach.profile.marks`), saved with Save or the switch (`outreach.location.set`, `outreach.their_work.set`).
 */
import {
  LOCAL_WORDS as L,
  locationLine,
  RADIUS_CHOICES,
  REACH,
  REACH_KEYS,
  theirWorkLine,
  type LocationSetInput,
  type LocationShown,
  type Reach,
  type TheirWorkShown,
} from '@hfos/core/addons/outreach/local';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { Note, useOutreachContext } from './kit';
import { Tick } from './settings-bits';
import { ChangeRow, RowsCard } from './settings-hands-off';

/** Settings → You: the person's own town, how far is local, and the local focus switch. Each person's own. */
export function LocationPart() {
  const { workspaceId, online } = useOutreachContext();
  const [shown, setShown] = React.useState<LocationShown | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [area, setArea] = React.useState('');
  const [radius, setRadius] = React.useState<number>(RADIUS_CHOICES[1]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'where' | 'focus' | null>(null);

  const show = React.useCallback((l: LocationShown) => {
    setShown(l);
    setArea(l.area ?? l.suggested ?? '');
    setRadius(l.radiusMiles);
  }, []);

  React.useEffect(() => {
    if (!online) return;
    let alive = true;
    api
      .POST('/v1/queries/outreach.location.get', { body: { workspaceId } })
      .then((r) => {
        if (alive) show(unwrap(r));
      })
      .catch((e: unknown) => {
        if (alive) setProblem(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [online, workspaceId, show]);

  const save = async (key: 'where' | 'focus', body: Omit<LocationSetInput, 'workspaceId'>) => {
    setBusy(key);
    setError(null);
    try {
      show(
        unwrap(
          await api.POST('/v1/commands/outreach.location.set', { body: { workspaceId, ...body } }),
        ),
      );
      toast.show(L.saved);
    } catch (e) {
      if (key === 'where') setError(errorMessage(e));
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const radii = [...new Set<number>([...RADIUS_CHOICES, radius])].sort((a, b) => a - b);
  return (
    <RowsCard testID="settings-my-local">
      <ChangeRow
        title={L.where}
        about={shown ? locationLine(shown) : (problem ?? '…')}
        testID="settings-my-where"
      >
        <Note>{L.whereHint}</Note>
        <View className="gap-1.5">
          <Label nativeID="settings-my-town-label">{L.townLabel}</Label>
          <Input
            value={area}
            onChangeText={setArea}
            placeholder={L.townPlaceholder}
            invalid={!!error}
            maxLength={80}
            autoCapitalize="words"
            editable={online && !!shown}
            accessibilityLabelledBy="settings-my-town-label"
            testID="settings-my-town"
          />
          <FieldError testID="settings-my-town-error">{error}</FieldError>
        </View>
        <View className="gap-1.5">
          <Label>{L.radiusLabel}</Label>
          <Segmented
            value={String(radius)}
            onChange={(v) => setRadius(Number(v))}
            options={radii.map((m) => ({ value: String(m), label: L.miles(m) }))}
            label={L.radiusLabel}
            testID="settings-my-radius"
          />
        </View>
        <Button
          size="sm"
          loading={busy === 'where'}
          disabled={!online || !shown || busy !== null}
          onPress={() => void save('where', { area: area.trim() || null, radiusMiles: radius })}
          testID="settings-my-where-save"
        >
          <Text>{L.save}</Text>
        </Button>
        {shown?.area ? <Note testID="settings-my-near">{L.nearLine(shown)}</Note> : null}
      </ChangeRow>
      <View className="py-3">
        <Tick
          label={L.focus}
          about={shown && !shown.area ? L.focusNeedsTown : L.focusHint}
          checked={shown?.localFocus ?? false}
          onChange={(on) => void save('focus', { localFocus: on })}
          disabled={!online || !shown?.area || busy !== null}
          testID="settings-my-local-focus"
        />
      </View>
    </RowsCard>
  );
}

const HOW = { page: L.fromPage, chat: L.fromChat, typed: L.typed } as const;

/** A person's card: what they do and where, with Change to set it by hand, which the AI then never writes over. */
export function TheirWork({
  workspaceId,
  profileId,
  shown,
  online,
  onSaved,
}: {
  workspaceId: string;
  profileId: string;
  shown: TheirWorkShown;
  online: boolean;
  onSaved: (shown: TheirWorkShown) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [work, setWork] = React.useState(shown.work ?? '');
  const [area, setArea] = React.useState(shown.area ?? '');
  const [reach, setReach] = React.useState<Reach | 'none'>(shown.reach ?? 'none');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const line = theirWorkLine(shown);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = unwrap(
        await api.POST('/v1/commands/outreach.their_work.set', {
          body: {
            workspaceId,
            profileId,
            work: work.trim() || null,
            area: area.trim() || null,
            reach: reach === 'none' ? null : reach,
          },
        }),
      );
      setOpen(false);
      onSaved(saved.shown);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-2 border-t border-border pt-3" testID="person-their-work">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[12px] font-semibold uppercase tracking-[0.5px] text-text-3">
            {L.theirWork}
          </Text>
          <Text className="text-[14px]" testID="person-their-work-line">
            {line ?? L.theirWorkNone}
          </Text>
          {shown.how ? <Note>{HOW[shown.how]}</Note> : null}
        </View>
        <Button
          size="sm"
          variant="secondary"
          disabled={!online}
          onPress={() => setOpen((o) => !o)}
          testID="person-their-work-change"
        >
          <Text>{open ? L.cancel : L.change}</Text>
        </Button>
      </View>
      {open ? (
        <View className="gap-3 rounded-menu bg-card-2 p-3">
          <View className="gap-1.5">
            <Label nativeID="person-their-work-work-label">{L.workLabel}</Label>
            <Input
              value={work}
              onChangeText={setWork}
              placeholder={L.workPlaceholder}
              maxLength={80}
              accessibilityLabelledBy="person-their-work-work-label"
            />
          </View>
          <View className="gap-1.5">
            <Label nativeID="person-their-work-area-label">{L.areaLabel}</Label>
            <Input
              value={area}
              onChangeText={setArea}
              placeholder={L.areaPlaceholder}
              invalid={!!error}
              maxLength={80}
              autoCapitalize="words"
              accessibilityLabelledBy="person-their-work-area-label"
            />
            <FieldError>{error}</FieldError>
          </View>
          <View className="gap-1.5">
            <Label>{L.reachLabel}</Label>
            <Segmented
              value={reach}
              onChange={setReach}
              options={[
                ...REACH_KEYS.map((k) => ({ value: k, label: REACH[k] })),
                { value: 'none' as const, label: L.noReach },
              ]}
              label={L.reachLabel}
            />
          </View>
          <Button
            size="sm"
            loading={busy}
            disabled={!online}
            onPress={() => void save()}
            testID="person-their-work-save"
          >
            <Text>{L.save}</Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}
