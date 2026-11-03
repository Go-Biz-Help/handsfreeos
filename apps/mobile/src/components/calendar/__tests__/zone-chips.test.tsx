import { localInstant } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { ZoneChips } from '@/components/calendar/zone-chips';
import { TaskSheet } from '@/components/customers/sheets';

/**
 * The phone's Time zone pick (core `zone-pick.ts`, as on the web): it starts on the business's zone with nothing to
 * explain, says where a time set on another zone lands, and finds a zone off the chips by its city. And a new task's
 * "Tomorrow" is the business's tomorrow, at noon there, whatever zone the phone is in.
 */

function Pick({ where }: { where?: string }) {
  const [zone, setZone] = React.useState('America/Chicago');
  return (
    <ZoneChips
      value={zone}
      onChange={setZone}
      homeZone="America/Chicago"
      at={localInstant('2026-11-10', '14:00', zone)}
      where={where}
      testID="zone"
    />
  );
}

describe('the phone’s time zone pick', () => {
  it('says where a time on another zone lands for the business', async () => {
    await render(<Pick where="for the business" />);
    expect(screen.queryByTestId('zone-note')).toBeNull();
    await fireEvent.press(screen.getByTestId('zone-America/Los_Angeles'));
    expect(screen.getByTestId('zone-note')).toHaveTextContent(
      'That’s 4:00 PM Central Time for the business.',
    );
  });

  it('finds a zone off the chips by its city', async () => {
    await render(<Pick />);
    await fireEvent.press(screen.getByTestId('zone-more'));
    await fireEvent.changeText(screen.getByTestId('zone-search'), 'manila');
    await fireEvent.press(screen.getByTestId('zone-found-Asia/Manila'));
    expect(screen.getByTestId('zone-note')).toHaveTextContent(
      'That’s 12:00 AM Central Time on your calendar.',
    );
  });
});

describe('a new task’s due day', () => {
  it('is the business’s tomorrow, at noon there', async () => {
    const save = jest.fn();
    await render(
      <TaskSheet
        open
        members={[]}
        myUserId="u1"
        timeZone="Pacific/Honolulu"
        onClose={jest.fn()}
        onSave={save}
      />,
    );
    await fireEvent.changeText(screen.getByTestId('task-title'), 'Order the capacitor');
    await fireEvent.press(screen.getByTestId('task-due-tomorrow'));
    await fireEvent.press(screen.getByTestId('task-save'));
    const dueAt = (save.mock.calls[0]![0] as { dueAt: string }).dueAt;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Pacific/Honolulu',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(dueAt));
    expect(parts).toBe('12');
  });
});
