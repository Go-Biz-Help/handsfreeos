import {
  buttonColorFor,
  isLookColor,
  isWideLogo,
  LOOK_DEFAULT_COLOR,
  LOOK_SWATCHES,
  LOOK_WAIT_MS,
  LOOK_WORDS as L,
  logoBox,
  lookProgressOf,
  type BusinessLook,
} from '@hfos/core';
import * as React from 'react';
import { ActivityIndicator, Image, Pressable, View } from 'react-native';

import { Check, CircleAlert, ImagePlus, RefreshCw, Trash } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn, initials } from '@/lib/utils';
import { logoSrc, lookCalls, pickLogo } from '@/look/calls';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

import { Note, type OwnScreenProps } from './screens';

/** While the logo is looked for or made ready, the setup is asked again this often: no live updates here. */
const POLL_MS = 4_000;

type Busy = 'upload' | 'remove' | 'find' | 'colour' | null;

/**
 * "Your logo and colour" on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8), as the web's
 * components/look/look-editor.tsx: the logo found on the website or uploaded from the phone's photos, the colour from
 * it until another is picked, and how a page looks with them. Each change is kept at once by core's look commands;
 * the setup is asked again while the worker looks for the logo or makes it ready.
 */
export function LookScreen({ workspaceId, state, can, refresh }: OwnScreenProps) {
  const { online } = useNetwork();
  const calls = React.useMemo(() => lookCalls(workspaceId), [workspaceId]);
  const canChange = can('workspace.update');
  // What a change here gave back, until the setup is asked again.
  const [given, setGiven] = React.useState<{ from: BusinessLook; look: BusinessLook } | null>(null);
  const look = given && given.from === state.look ? given.look : state.look;
  const [busy, setBusy] = React.useState<Busy>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [typed, setTyped] = React.useState('');
  const [now, setNow] = React.useState(() => Date.now());

  const progress = lookProgressOf(look, new Date(now));
  const waiting = progress !== 'idle';
  const color = look.color?.hex ?? LOOK_DEFAULT_COLOR;

  const ask = React.useRef(refresh);
  ask.current = refresh;
  React.useEffect(() => {
    if (!waiting || !online) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void ask.current();
    }, POLL_MS);
    const stop = setTimeout(() => setNow(Date.now()), LOOK_WAIT_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [waiting, online]);

  // "Logo saved" when the logo the worker was making arrives.
  const made = React.useRef<{ making: boolean; path: string | null }>({
    making: false,
    path: look.logo?.path ?? null,
  });
  React.useEffect(() => {
    const path = look.logo?.path ?? null;
    if (made.current.making && progress !== 'making' && path && path !== made.current.path)
      toast.show(L.logoReady);
    made.current = { making: progress === 'making', path };
  }, [progress, look.logo?.path]);

  async function run(kind: Exclude<Busy, null>, act: () => Promise<BusinessLook | null>) {
    if (!online) {
      setError(P.needsSignal);
      return false;
    }
    setBusy(kind);
    setError(null);
    try {
      const next = await act();
      if (!next) return false;
      setGiven({ from: state.look, look: next });
      setNow(Date.now());
      void refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const upload = () =>
    void run('upload', async () => {
      const picked = await pickLogo();
      return picked ? calls.upload(picked) : null;
    });
  const remove = async () => {
    if (await run('remove', calls.removeLogo)) toast.show(L.removed);
  };
  const pick = async (hex: string) => {
    if (hex === look.color?.hex && look.color.from === 'person') return;
    if (await run('colour', () => calls.setColor(hex))) toast.show(L.saved);
  };
  const pickTyped = () => {
    const hex = typed.trim().toLowerCase();
    const full = /^#?[0-9a-f]{6}$/.test(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : null;
    if (!full || !isLookColor(full)) {
      setError(L.typeColor);
      return;
    }
    setTyped('');
    void pick(full);
  };

  const problem =
    look.problem && progress !== 'making' && (!look.logo || look.problem.at > look.logo.at)
      ? look.problem.message
      : null;
  const notFound =
    !look.logo && progress === 'idle' && look.searched && !look.searched.found
      ? look.searched.url
      : null;
  const website = state.website;
  const swatches = [
    ...(look.color && !(LOOK_SWATCHES as readonly string[]).includes(look.color.hex)
      ? [look.color.hex]
      : []),
    ...LOOK_SWATCHES,
  ];
  const logo = look.logo
    ? { url: logoSrc(look.logo.path), width: look.logo.width, height: look.logo.height }
    : null;

  const status =
    progress === 'making' ? (
      <Working>{L.making}</Working>
    ) : progress === 'searching' ? (
      <Working>{L.searching(look.asked?.url ?? website ?? '')}</Working>
    ) : look.logo ? (
      <Text className="text-[13.5px] leading-[19px] text-text-2" testID="look-logo-from">
        {look.logo.from === 'website' && look.searched ? L.fromSite(look.searched.url) : L.uploaded}
      </Text>
    ) : (
      <Text className="text-[13.5px] leading-[19px] text-text-2" testID="look-no-logo">
        {notFound ? L.notFound(notFound) : L.noLogo}
      </Text>
    );

  return (
    <View className="gap-6" testID="look-editor">
      {canChange ? null : (
        <Note icon={CircleAlert} testID="look-cant-change">
          {L.cantChange}
        </Note>
      )}

      <View className="gap-2">
        <Label>{L.logo}</Label>
        <View className="gap-3 rounded-card border border-border bg-card p-4">
          <View className="flex-row items-center gap-3.5">
            <Mark name={state.businessName} logo={logo} color={color} size={logo ? 64 : 56} />
            <View className="min-w-0 flex-1">{status}</View>
          </View>
          {canChange ? (
            <View className="flex-row flex-wrap gap-2">
              <Button
                size="sm"
                variant={look.logo ? 'secondary' : 'primary'}
                icon={ImagePlus}
                onPress={upload}
                loading={busy === 'upload'}
                disabled={!!busy || progress === 'making'}
                testID="look-upload"
              >
                {look.logo ? L.change : L.upload}
              </Button>
              {look.logo ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Trash}
                  onPress={() => void remove()}
                  loading={busy === 'remove'}
                  disabled={!!busy}
                  testID="look-remove"
                >
                  {L.remove}
                </Button>
              ) : website && progress === 'idle' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={RefreshCw}
                  onPress={() => void run('find', calls.find)}
                  loading={busy === 'find'}
                  disabled={!!busy}
                  testID="look-find"
                >
                  {L.findAgain(website)}
                </Button>
              ) : null}
            </View>
          ) : null}
        </View>
        {problem ? (
          <Note tone="danger" icon={CircleAlert} testID="look-problem">
            {problem}
          </Note>
        ) : canChange ? (
          <Text className="text-[12.5px] leading-[17px] text-text-3">{L.uploadHint}</Text>
        ) : null}
      </View>

      <View className="gap-2">
        <Label>{L.color}</Label>
        <View className="flex-row flex-wrap items-center gap-3" role="radiogroup">
          {swatches.map((c) => (
            <Pressable
              key={c}
              role="radio"
              aria-checked={color === c}
              accessibilityLabel={L.pickColor(c)}
              disabled={!canChange || !!busy}
              onPress={() => void pick(c)}
              hitSlop={4}
              className={cn(
                'size-9 items-center justify-center rounded-full border border-border-strong',
                color === c && 'border-2 border-text',
              )}
              style={{ backgroundColor: c }}
              testID={`look-colour-${c.slice(1)}`}
            >
              {color === c ? <Icon as={Check} className="size-4 text-white" /> : null}
            </Pressable>
          ))}
          {busy === 'colour' ? <ActivityIndicator size="small" /> : null}
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="font-mono text-xs text-text-3" testID="look-colour-value">
            {color}
          </Text>
          {look.color && look.color.from !== 'person' ? (
            <Text className="text-xs text-text-3" testID="look-colour-from">
              {look.color.from === 'logo' ? L.fromLogo : L.fromWebsite}
            </Text>
          ) : null}
        </View>
        {canChange ? (
          <View className="flex-row items-center gap-2">
            <Input
              className="flex-1"
              value={typed}
              onChangeText={setTyped}
              placeholder={L.anyColor}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={pickTyped}
              accessibilityLabel={L.anyColor}
              testID="look-colour-any"
            />
            <Button
              size="md"
              variant="secondary"
              onPress={pickTyped}
              disabled={!typed.trim() || !!busy}
              testID="look-colour-use"
            >
              {typed.trim() ? L.pickColor(typed.trim()) : L.anyColor}
            </Button>
          </View>
        ) : null}
        <Text className="text-[12.5px] leading-[17px] text-text-3">{L.colorHint}</Text>
      </View>

      <View className="gap-2">
        <Label>{L.preview}</Label>
        <Preview name={state.businessName} logo={logo} color={color} />
      </View>

      {error ? <FieldError testID="look-error">{error}</FieldError> : null}
    </View>
  );
}

export interface ShownLogo {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** The logo on white, or the initials in the colour's square, `size` high. */
export function Mark({
  name,
  logo,
  color,
  size,
}: {
  name: string;
  logo: ShownLogo | null;
  color: string;
  size: number;
}) {
  if (!logo)
    return (
      <View
        className="items-center justify-center rounded-[12px]"
        style={{ width: size, height: size, backgroundColor: buttonColorFor(color) }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="business-initials"
      >
        <Text
          className="font-bold text-white"
          style={{ fontSize: Math.round(size * 0.36), letterSpacing: 0.4 }}
        >
          {initials(name)}
        </Text>
      </View>
    );
  const box = logoBox(logo, size);
  return (
    <View
      className="items-center justify-center rounded-[12px] border border-border bg-white"
      style={{ height: size, minWidth: size, width: box.width + 6 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={{ uri: logo.url }}
        style={{ width: box.width, height: box.height }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
        testID="business-logo"
      />
    </View>
  );
}

/** A booking page's top and a time picked, in the business's colour. */
function Preview({ name, logo, color }: { name: string; logo: ShownLogo | null; color: string }) {
  const colors = useColors();
  const button = buttonColorFor(color);
  return (
    <View
      className="overflow-hidden rounded-card border border-border bg-bg"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="look-preview"
    >
      <View className="flex-row items-center gap-2.5 border-b border-border bg-card px-3.5 py-2.5">
        <Mark name={name} logo={logo} color={color} size={32} />
        {isWideLogo(logo) ? null : (
          <Text className="min-w-0 flex-1 text-[14px] font-medium" numberOfLines={1}>
            {name}
          </Text>
        )}
      </View>
      <View className="flex-row flex-wrap items-center gap-2 p-3.5">
        <View
          className="h-8 justify-center rounded-control border px-2.5"
          style={{ borderColor: button, backgroundColor: `${button}1a` }}
        >
          <Text className="text-[13px] font-medium" style={{ color: button }}>
            9:00 AM
          </Text>
        </View>
        <View className="h-8 justify-center rounded-control border border-border bg-card px-2.5">
          <Text className="text-[13px]" style={{ color: colors.text2 }}>
            10:30 AM
          </Text>
        </View>
        <View
          className="ml-auto h-8 justify-center rounded-control px-2.5"
          style={{ backgroundColor: button }}
        >
          <Text className="text-[13px] font-medium text-white">{L.previewButton}</Text>
        </View>
      </View>
    </View>
  );
}

function Working({ children }: { children: string }) {
  const colors = useColors();
  return (
    <View className="flex-row items-center gap-2" testID="look-working">
      <ActivityIndicator size="small" color={colors.accent} />
      <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">{children}</Text>
    </View>
  );
}
