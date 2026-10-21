import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import type { ScrollView, View } from 'react-native';

/**
 * A settings screen opened at one setting (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Phone: Settings search"):
 * `settings/notifications?setting=notifications.customer_waiting` scrolls to that row and flashes it, as the web's
 * jump rings one. The screen gives `scrollRef` to its `Screen` and `value` to `SettingFlashContext`; each row that is a
 * setting names its key (`ListRow`'s `settingKey`, or `useFlashRow`), and finds out from the context when it's the one.
 * Settings search on the same screen calls `flash` itself.
 */

/** How long a row stays lit. */
const FLASH_MS = 2500;
/** Room left above the row once it's scrolled to, under the top bar. */
const ABOVE = 96;

interface Flashing {
  readonly key: string;
  /** When it was asked for, so the same row asked for twice flashes twice. */
  readonly at: number;
}

/** React Native has had it since the new architecture, but its types don't say so yet. */
type WithInnerView = ScrollView & { getInnerViewRef(): View | null };

interface FlashContext {
  readonly flashing: Flashing | null;
  /** Scrolls the screen to a row. */
  readonly reveal: (row: View) => void;
}

export const SettingFlashContext = React.createContext<FlashContext>({
  flashing: null,
  reveal: () => undefined,
});

export function useSettingFlash(): {
  readonly scrollRef: React.RefObject<ScrollView | null>;
  readonly value: FlashContext;
  readonly flash: (key: string) => void;
} {
  const { setting } = useLocalSearchParams<{ setting?: string }>();
  const scrollRef = React.useRef<ScrollView>(null);
  const [flashing, setFlashing] = React.useState<Flashing | null>(null);
  const flash = React.useCallback((key: string) => setFlashing({ key, at: Date.now() }), []);

  React.useEffect(() => {
    if (typeof setting === 'string' && setting) flash(setting);
  }, [setting, flash]);

  React.useEffect(() => {
    if (!flashing) return;
    const timer = setTimeout(() => setFlashing(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashing]);

  const reveal = React.useCallback((row: View) => {
    const scroll = scrollRef.current;
    const content = (scroll as WithInnerView | null)?.getInnerViewRef();
    if (!scroll || !content) return;
    row.measureLayout(
      content,
      (_x, y) => scroll.scrollTo({ y: Math.max(0, y - ABOVE), animated: true }),
      () => undefined,
    );
  }, []);

  const value = React.useMemo(() => ({ flashing, reveal }), [flashing, reveal]);
  return { scrollRef, value, flash };
}

/** One row that is a setting: its ref and layout, and whether it's lit now. Scrolls itself into view when it is. */
export function useFlashRow(key: string | undefined): {
  readonly ref: React.RefObject<View | null>;
  readonly onLayout: () => void;
  readonly lit: boolean;
} {
  const { flashing, reveal } = React.useContext(SettingFlashContext);
  const ref = React.useRef<View>(null);
  const lit = !!key && flashing?.key === key;
  const at = lit ? flashing.at : null;

  React.useEffect(() => {
    if (at !== null && ref.current) reveal(ref.current);
  }, [at, reveal]);

  // A screen opened at a row draws the row after the flash was asked for: its first layout scrolls to it.
  const onLayout = React.useCallback(() => {
    if (lit && ref.current) reveal(ref.current);
  }, [lit, reveal]);

  return { ref, onLayout, lit };
}
