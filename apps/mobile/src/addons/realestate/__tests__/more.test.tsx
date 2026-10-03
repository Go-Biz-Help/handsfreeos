import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { openWebPath } from '@/home/open';

import { RealestateMoreRows } from '../more';

/** Real Estate's places in More (board 76): each row's line, where it opens, and Deal settings left to the web. */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COUNTS = { openDeals: 12, atRisk: 3, dueToday: 5, late: 1, approvedVendors: 14 };

describe('Real Estate in More', () => {
  it('says what’s in each place, as the board does', async () => {
    await render(<RealestateMoreRows workspaceId={WS} counts={COUNTS} manages={false} />);
    expect(screen.getByText('12 open · 3 at risk')).toBeTruthy();
    expect(screen.getByText('5 today · 1 late')).toBeTruthy();
    expect(screen.getByText('Today, exceptions, waiting, workload')).toBeTruthy();
    expect(screen.getByText('14 approved')).toBeTruthy();
    expect(screen.queryByText(/opens on the web/)).toBeNull();
  });

  it('leaves out what isn’t there, and tells those who change Deal settings it’s on the web', async () => {
    await render(
      <RealestateMoreRows
        workspaceId={WS}
        counts={{ openDeals: 2, atRisk: 0, dueToday: 0, late: 0, approvedVendors: 1 }}
        manages
      />,
    );
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getByText('Nothing due today')).toBeTruthy();
    expect(screen.getByText('1 approved')).toBeTruthy();
    expect(
      screen.getByText('Deal settings (the duty list, alerts, connections) opens on the web.'),
    ).toBeTruthy();
  });

  it('opens each place at the web’s own address, which the route map sends to the phone’s screen', async () => {
    await render(<RealestateMoreRows workspaceId={WS} counts={COUNTS} manages={false} />);
    await fireEvent.press(screen.getByTestId('more-re-deals'));
    await fireEvent.press(screen.getByTestId('more-re-duties'));
    await fireEvent.press(screen.getByTestId('more-re-coordinate'));
    await fireEvent.press(screen.getByTestId('more-re-vendors'));
    expect(jest.mocked(openWebPath).mock.calls.map(([p]) => p)).toEqual([
      `/app/w/${WS}/a/realestate`,
      `/app/w/${WS}/a/realestate/duties`,
      `/app/w/${WS}/a/realestate/coordinate`,
      `/app/w/${WS}/a/realestate/vendors`,
    ]);
  });
});
