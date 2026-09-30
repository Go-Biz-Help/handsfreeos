import { render } from '@testing-library/react-native';
import * as React from 'react';

import type { Staff } from '@/admin/staff';
import { DeskProvider } from '@/components/admin/staff-context';
import { api } from '@/lib/api';

/**
 * What the Support desk's screen tests share. Each test file still mocks `expo-router`, the status strip and
 * `@/lib/api` itself (jest hoists `jest.mock` only within the file that calls it); this is the rest: a support person,
 * the stand-in API and its record of what was sent.
 */

export const SAM = '11111111-1111-4111-8111-111111111111';
export const RILEY = '22222222-2222-4222-8222-222222222222';
export const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Every staff permission a support admin holds (core's `staff_admin`). */
export const ADMIN_PERMISSIONS = [
  'support.read',
  'support.reply',
  'support.assign',
  'support.manage',
  'platform.businesses.read',
  'platform.view_as',
  'platform.health.read',
  'platform.staff.manage',
  'platform.rates.manage',
  'platform.ai.manage',
  'platform.wallets.adjust',
  'platform.founding.manage',
  'platform.ideas.moderate',
  'platform.ideas.manage',
  'platform.addons.manage',
] as const;

/** A support agent's (core's `staff_agent`). */
export const AGENT_PERMISSIONS = [
  'support.read',
  'support.reply',
  'platform.businesses.read',
  'platform.view_as',
  'platform.ideas.moderate',
] as const;

export const admin: Staff = {
  userId: SAM,
  role: 'admin',
  displayName: 'Sam',
  permissions: ADMIN_PERMISSIONS,
  founder: false,
};

export const agent: Staff = {
  userId: SAM,
  role: 'agent',
  displayName: 'Sam',
  permissions: AGENT_PERMISSIONS,
  founder: false,
};

/** What the API says, per path. A path given `null` fails instead, as no signal does; a function is asked each time. */
export type Answers = Record<string, unknown>;

/** The stand-in API, typed plainly: openapi-fetch's own signature is too deep for a mock to wear. */
export const post = api.POST as unknown as jest.Mock<
  Promise<{ data: unknown }>,
  [string, { body: Record<string, unknown> }]
>;

/** Every request sent to one path, in order. */
export const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

/** The body of the last request sent to one path. */
export const lastBody = (path: string) => sent(path).at(-1)?.[1].body;

export function mockApi(answers: () => Answers) {
  post.mockImplementation(async (path, options) => {
    const answer = answers()[path];
    if (answer === undefined) return { data: {} };
    if (answer === null) throw new Error('No signal. Try again when you’re back online.');
    return {
      data:
        typeof answer === 'function'
          ? (answer as (body: Record<string, unknown>) => unknown)(options.body)
          : answer,
    };
  });
}

/** Draws a desk screen for a support person (an admin unless said otherwise), with the stand-in API answering. */
export async function showDesk(
  element: React.ReactElement,
  answers: () => Answers,
  staff: Staff = admin,
) {
  mockApi(answers);
  await render(<DeskProvider value={{ userId: staff.userId, staff }}>{element}</DeskProvider>);
}
