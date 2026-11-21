/** Threads' and X's specs, by network (./types.ts, decision 163): for the jobs, which open their pages. */
import { THREADS_SPEC } from '../threads/spec';
import { X_SPEC } from '../x/spec';
import type { FollowPlatform, FollowSpec } from './types';

export const FOLLOW_SPECS: Readonly<Record<FollowPlatform, FollowSpec>> = {
  threads: THREADS_SPEC,
  x: X_SPEC,
};

export const FOLLOW_PLATFORM_KEYS: readonly FollowPlatform[] = ['threads', 'x'];

export const isFollowPlatform = (platform: string): platform is FollowPlatform =>
  platform === 'threads' || platform === 'x';
