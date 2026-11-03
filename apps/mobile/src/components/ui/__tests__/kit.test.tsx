import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';

import { Mail } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Toaster, toast } from '@/components/ui/toast';

describe('Button', () => {
  it('presses, and names itself for screen readers', async () => {
    const onPress = jest.fn();
    await render(
      <Button icon={Mail} onPress={onPress}>
        Email me a code
      </Button>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Email me a code' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('ignores presses while loading or disabled, and says so', async () => {
    const onPress = jest.fn();
    await render(
      <View>
        <Button loading onPress={onPress} testID="loading">
          Sign in
        </Button>
        <Button disabled onPress={onPress} testID="disabled">
          Delete my account
        </Button>
      </View>,
    );
    await fireEvent.press(screen.getByTestId('loading'));
    await fireEvent.press(screen.getByTestId('disabled'));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('loading')).toBeBusy();
    expect(screen.getByTestId('disabled')).toBeDisabled();
  });

  it('keeps small buttons at least 44 px to touch', async () => {
    await render(
      <Button size="sm" testID="small">
        Switch
      </Button>,
    );
    // 36 px tall, with 4 px more above and below.
    expect(screen.getByTestId('small').props.hitSlop).toEqual({
      top: 4,
      bottom: 4,
      left: 0,
      right: 0,
    });
  });
});

describe('Switch', () => {
  it('flips, and reports its state', async () => {
    function Keep() {
      const [on, setOn] = React.useState(true);
      return <Switch label="Keep Lone Star on this phone" checked={on} onCheckedChange={setOn} />;
    }
    await render(<Keep />);
    const control = screen.getByRole('switch', { name: 'Keep Lone Star on this phone' });
    expect(control).toBeChecked();
    await fireEvent.press(control);
    expect(control).not.toBeChecked();
  });

  it('doesn’t flip when disabled', async () => {
    const onChange = jest.fn();
    await render(
      <Switch label="Unlock with Face ID" checked={false} disabled onCheckedChange={onChange} />,
    );
    await fireEvent.press(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Segmented', () => {
  it('chooses one option and marks it selected', async () => {
    const onChange = jest.fn();
    await render(
      <Segmented
        label="Appearance"
        value="system"
        onChange={onChange}
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'System' })).toBeSelected();
    await fireEvent.press(screen.getByRole('tab', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
    await fireEvent.press(screen.getByRole('tab', { name: 'System' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('Sheet', () => {
  it('shows its content when open, and closes from the scrim', async () => {
    const onClose = jest.fn();
    await render(
      <Sheet open onClose={onClose} title="Businesses" testID="sheet">
        <Text>Lone Star HVAC &amp; Roofing</Text>
      </Sheet>,
    );
    expect(screen.getByText('Businesses')).toBeOnTheScreen();
    expect(screen.getByText('Lone Star HVAC & Roofing')).toBeOnTheScreen();
    // Screen readers skip the scrim (the sheet is modal to them); a finger on it closes the sheet.
    await fireEvent.press(screen.getByTestId('sheet-scrim', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // The phone's back button closes it too.
    await fireEvent(screen.root!, 'requestClose');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows a toast over itself, since its modal would cover the app’s', async () => {
    await render(
      <Sheet open onClose={jest.fn()} title="Businesses">
        <Text>Glow Red Light Studio</Text>
      </Sheet>,
    );
    await act(async () => {
      toast.show('Glow Red Light Studio opens only with signal.');
    });
    // Inside the part screen readers treat as modal, so they reach it too.
    expect(screen.getByText('Glow Red Light Studio opens only with signal.')).toBeOnTheScreen();
    await act(async () => {
      toast.dismiss();
    });
  });

  it('shows nothing when closed', async () => {
    await render(
      <Sheet open={false} onClose={jest.fn()} title="Sign out?">
        <Text>Stay signed in</Text>
      </Sheet>,
    );
    expect(screen.queryByText('Sign out?')).not.toBeOnTheScreen();
  });

  describe('closes when dragged down', () => {
    type Element = ReturnType<typeof screen.getByTestId>;

    /** One finger's touch history, as React Native's responder system keeps it, the finger at `y` at time `at`. */
    const history = (y: number, at: number, before: { y: number; at: number }) => ({
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: at,
      touchBank: [
        {
          touchActive: true,
          startPageX: 0,
          startPageY: 0,
          startTimeStamp: 0,
          currentPageX: 0,
          currentPageY: y,
          currentTimeStamp: at,
          previousPageX: 0,
          previousPageY: before.y,
          previousTimeStamp: before.at,
        },
      ],
    });

    /**
     * A finger put down on the sheet and moved through `ys` (points down from where it started), a step each `step` ms,
     * then lifted, as the responder system asks the sheet. Says whether the sheet took the finger.
     */
    async function drag(
      sheet: Element,
      ys: number[],
      { step = 16, on }: { step?: number; on?: unknown } = {},
    ): Promise<boolean> {
      const p = sheet.props;
      let before = { y: 0, at: 0 };
      const event = (y: number, at: number) => ({
        target: on,
        nativeEvent: { touches: [{}] },
        touchHistory: history(y, at, before),
      });
      let took = false;
      await act(async () => {
        p.onStartShouldSetResponderCapture(event(0, 0));
        let last = event(0, 0);
        ys.forEach((y, i) => {
          last = event(y, (i + 1) * step);
          if (took) p.onResponderMove(last);
          else {
            // The capture phase runs first on every move, and keeps the gesture's numbers.
            p.onMoveShouldSetResponderCapture(last);
            if (p.onMoveShouldSetResponder(last)) {
              p.onResponderGrant(last);
              took = true;
            }
          }
          before = { y, at: (i + 1) * step };
        });
        if (took) p.onResponderRelease(last);
        // Its check that whoever owns it really closed it.
        await new Promise((r) => setTimeout(r, 0));
      });
      return took;
    }

    const sheet = (onClose: () => void, scroll?: boolean) => (
      <Sheet open onClose={onClose} title="Notifications" scroll={scroll} testID="sheet">
        <Pressable role="button" onPress={jest.fn()}>
          <Text>jmartinez1127 wrote back</Text>
        </Pressable>
      </Sheet>
    );

    it('a third of the way down, or 120 points, held there and let go', async () => {
      const onClose = jest.fn();
      await render(sheet(onClose));
      // Held at 160 points before letting go: no flick, just far enough.
      expect(await drag(screen.getByTestId('sheet'), [10, 40, 80, 120, 160, 160, 160])).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('with a flick, however short', async () => {
      const onClose = jest.fn();
      await render(sheet(onClose));
      expect(await drag(screen.getByTestId('sheet'), [10, 30, 60])).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('but not from a short drag let go slowly, or one pushed back up', async () => {
      const onClose = jest.fn();
      await render(sheet(onClose));
      expect(await drag(screen.getByTestId('sheet'), [10, 30, 60, 60, 60])).toBe(true);
      expect(await drag(screen.getByTestId('sheet'), [10, 80, 160, 100])).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('and leaves a tap, a drag up and a swipe sideways to what’s under the finger', async () => {
      const onClose = jest.fn();
      await render(sheet(onClose));
      const s = screen.getByTestId('sheet');
      expect(s.props.onStartShouldSetResponder?.() ?? false).toBe(false);
      expect(await drag(s, [3, 6, 6])).toBe(false);
      expect(await drag(s, [-10, -40, -80])).toBe(false);
      // 60 points across for 20 down.
      const start = { y: 0, at: 0 };
      const across = { nativeEvent: { touches: [{}] }, touchHistory: history(20, 16, start) };
      across.touchHistory.touchBank[0]!.currentPageX = 60;
      await act(async () => {
        s.props.onStartShouldSetResponderCapture({
          nativeEvent: { touches: [{}] },
          touchHistory: history(0, 0, start),
        });
        s.props.onMoveShouldSetResponderCapture(across);
        expect(s.props.onMoveShouldSetResponder(across)).toBe(false);
      });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('but not from the field being typed in, which may be scrolling its own words', async () => {
      const onClose = jest.fn();
      await render(sheet(onClose));
      const field = {};
      const typing = jest
        .spyOn(TextInput.State, 'currentlyFocusedInput')
        .mockReturnValue(field as ReturnType<typeof TextInput.State.currentlyFocusedInput>);
      try {
        expect(await drag(screen.getByTestId('sheet'), [10, 80, 160, 160], { on: field })).toBe(
          false,
        );
        // Anywhere else on the sheet still drags it.
        expect(await drag(screen.getByTestId('sheet'), [10, 80, 160, 160], { on: {} })).toBe(true);
      } finally {
        typing.mockRestore();
      }
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('only once its list is back at the top, when it scrolls', async () => {
      const onClose = jest.fn();
      await render(sheet(onClose, true));
      const list = screen.getByTestId('sheet-scroll');
      await fireEvent.scroll(list, { nativeEvent: { contentOffset: { x: 0, y: 240 } } });
      // Partway down the list, a drag down scrolls it back up.
      expect(await drag(screen.getByTestId('sheet'), [10, 80, 160, 160])).toBe(false);
      await fireEvent.scroll(list, { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
      expect(await drag(screen.getByTestId('sheet'), [10, 80, 160, 160])).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('and gives the finger back to a list inside it that starts scrolling', async () => {
      await render(sheet(jest.fn()));
      expect(screen.getByTestId('sheet').props.onResponderTerminationRequest({})).toBe(true);
    });
  });

  describe('says when it has gone', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    // iOS shows no modal while another is still being dismissed, so a sheet that opens another waits for this.
    it('on iOS, once its modal reports it was dismissed', async () => {
      const onClosed = jest.fn();
      const { rerender } = await render(
        <Sheet open onClose={jest.fn()} onClosed={onClosed} title="Details and actions">
          <Text>Assign</Text>
        </Sheet>,
      );
      // The Modal's own dismissal callback, as the native side calls it once the modal is off the screen.
      const dismiss = screen.root!.props.onDismiss as () => void;
      await act(async () => dismiss());
      expect(onClosed).not.toHaveBeenCalled();
      await rerender(
        <Sheet open={false} onClose={jest.fn()} onClosed={onClosed} title="Details and actions">
          <Text>Assign</Text>
        </Sheet>,
      );
      await act(async () => jest.advanceTimersByTime(1_000));
      expect(screen.queryByText('Assign')).not.toBeOnTheScreen();
      // Slid down, but the modal has not said it is gone yet.
      expect(onClosed).not.toHaveBeenCalled();
      await act(async () => dismiss());
      expect(onClosed).toHaveBeenCalledTimes(1);
      await act(async () => dismiss());
      expect(onClosed).toHaveBeenCalledTimes(1);
    });

    it('on Android, once it has slid down', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'android');
      try {
        const onClosed = jest.fn();
        const { rerender } = await render(
          <Sheet open onClose={jest.fn()} onClosed={onClosed} title="Details and actions">
            <Text>Assign</Text>
          </Sheet>,
        );
        await rerender(
          <Sheet open={false} onClose={jest.fn()} onClosed={onClosed} title="Details and actions">
            <Text>Assign</Text>
          </Sheet>,
        );
        expect(onClosed).not.toHaveBeenCalled();
        await act(async () => jest.advanceTimersByTime(1_000));
        expect(screen.queryByText('Assign')).not.toBeOnTheScreen();
        expect(onClosed).toHaveBeenCalledTimes(1);
      } finally {
        os.restore();
      }
    });
  });
});

describe('Toast', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows a note, then goes after 2.6 seconds', async () => {
    await render(
      <View style={{ flex: 1 }}>
        <Toaster />
        <PortalHost />
      </View>,
    );
    await act(async () => {
      toast.show('Bayou Plumbing Co. opens only with signal.');
    });
    expect(screen.getByText('Bayou Plumbing Co. opens only with signal.')).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(2700);
    });
    expect(screen.queryByText('Bayou Plumbing Co. opens only with signal.')).not.toBeOnTheScreen();
  });
});

describe('Input and Badge', () => {
  it('passes typing through and marks a refused value', async () => {
    const onChangeText = jest.fn();
    await render(<Input accessibilityLabel="Email" invalid onChangeText={onChangeText} />);
    const field = screen.getByLabelText('Email');
    await fireEvent.changeText(field, 'dale@lonestarhvac.test');
    expect(onChangeText).toHaveBeenCalledWith('dale@lonestarhvac.test');
    expect(field.props['aria-invalid']).toBe(true);
  });

  it('draws a button inside the field at its end', async () => {
    const onPress = jest.fn();
    await render(
      <Input
        accessibilityLabel="Password"
        secureTextEntry
        trailing={<Pressable role="button" accessibilityLabel="Show password" onPress={onPress} />}
      />,
    );
    expect(screen.getByLabelText('Password')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Show password' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders its words', async () => {
    await render(
      <Badge variant="ok">
        <Text>Verified</Text>
      </Badge>,
    );
    expect(screen.getByText('Verified')).toBeOnTheScreen();
  });

  it('puts words handed to it straight in a Text, never loose in its View', async () => {
    const pending: boolean = true;
    await render(
      <View>
        <Badge variant="gray">Archived</Badge>
        <Badge>
          {'On the way'}
          {pending ? ' · waiting for signal' : ''}
        </Badge>
      </View>,
    );
    // getByText only finds words inside a Text: loose words in a View aren't found.
    expect(screen.getByText('Archived')).toBeOnTheScreen();
    expect(screen.getByText('On the way · waiting for signal')).toBeOnTheScreen();
  });
});
