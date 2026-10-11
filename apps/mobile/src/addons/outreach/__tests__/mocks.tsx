import * as React from 'react';
import type * as ReactNative from 'react-native';

/**
 * The stand-in Screen Social Outreach's tests draw into: its title, subtitle and children, without the shell's
 * safe areas and navigation. Each test file mocks `@/components/shell/screen` with it.
 */
export function TestScreen({
  title,
  subtitle,
  children,
  testID,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  testID?: string;
}) {
  const RN = jest.requireActual<typeof ReactNative>('react-native');
  return (
    <RN.View testID={testID}>
      <RN.Text testID="screen-title">{title}</RN.Text>
      {subtitle ? <RN.Text testID="screen-subtitle">{subtitle}</RN.Text> : null}
      {children}
    </RN.View>
  );
}

export const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TZ = 'America/Chicago';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** One of the person's messages as the phone's copy holds it (`addon_phone_rows`, source `sends`). */
export function sendRow(
  n: number,
  over: Record<string, unknown> = {},
): { id: string; source: string; record_id: null; data: string } {
  return {
    id: `sends:${id(n)}`,
    source: 'sends',
    record_id: null,
    data: JSON.stringify({
      user_id: ME,
      profile_id: id(100 + n),
      kind: 'opener',
      thread_key: null,
      text: `Hi there, message ${n}`,
      state: 'waiting',
      handed_over: false,
      needs_you: null,
      name: `Person ${n}`,
      profile_url: `https://www.facebook.com/person.${n}`,
      created_at: `2026-10-09T1${n % 10}:00:00+00:00`,
      updated_at: `2026-10-09T1${n % 10}:00:00+00:00`,
      ...over,
    }),
  };
}
