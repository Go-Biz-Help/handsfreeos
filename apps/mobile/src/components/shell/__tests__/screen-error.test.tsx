import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import * as React from 'react';
import { Text } from 'react-native';

import { errorDetail, ScreenError } from '../screen-error';

/**
 * A screen that can't draw shows why instead of closing the app (TestFlight builds 8 and 9 closed about a second after
 * opening, with nothing on the phone to say why): the error's words, Try again, and every route that draws the
 * signed-in app wearing the boundary.
 */

const GROWS = "Cannot read properties of undefined (reading 'grows')";

describe('a screen that throws', () => {
  // renderRouter turns on fake timers; the rest of the suite runs on real ones.
  afterEach(() => jest.useRealTimers());

  it('shows what broke in place of closing the app', async () => {
    function Broken(): React.ReactElement {
      throw new TypeError(GROWS);
    }
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderRouter({ index: { default: Broken, ErrorBoundary: ScreenError } });
    expect(await screen.findByTestId('screen-error')).toBeOnTheScreen();
    expect(screen.getByText('This screen didn’t open')).toBeOnTheScreen();
    expect(screen.getByTestId('screen-error-detail')).toHaveTextContent(GROWS);
    quiet.mockRestore();
  });

  it('draws the screen again on Try again', async () => {
    let broken = true;
    function Flaky(): React.ReactElement {
      if (broken) throw new Error('not yet');
      return <Text>Home</Text>;
    }
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderRouter({ index: { default: Flaky, ErrorBoundary: ScreenError } });
    expect(await screen.findByTestId('screen-error')).toBeOnTheScreen();
    broken = false;
    await fireEvent.press(screen.getByTestId('screen-error-retry'));
    expect(await screen.findByText('Home')).toBeOnTheScreen();
    expect(screen.queryByTestId('screen-error')).toBeNull();
    quiet.mockRestore();
  });
});

describe('the error’s words', () => {
  it('are its message, or whatever was thrown', () => {
    expect(errorDetail(new TypeError(GROWS))).toBe(GROWS);
    expect(errorDetail('a string')).toBe('a string');
    expect(errorDetail(undefined)).toBe('Unknown error');
    expect(errorDetail(Object.assign(new Error(''), { name: 'RangeError' }))).toBe('RangeError');
  });

  it('stop short of a wall of text', () => {
    const text = errorDetail(new Error('x'.repeat(1000)));
    expect(text).toHaveLength(300);
    expect(text.endsWith('…')).toBe(true);
  });
});

it('guards the root, each business and every tab', () => {
  const app = join(__dirname, '../../../app');
  for (const route of [
    '_layout.tsx',
    'app/w/[workspaceId]/_layout.tsx',
    'app/w/[workspaceId]/(tabs)/index.tsx',
    'app/w/[workspaceId]/(tabs)/inbox.tsx',
    'app/w/[workspaceId]/(tabs)/pipeline.tsx',
    'app/w/[workspaceId]/(tabs)/calendar.tsx',
    'app/w/[workspaceId]/(tabs)/(more)/_layout.tsx',
  ])
    expect(readFileSync(join(app, route), 'utf8')).toContain(
      "export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';",
    );
});
