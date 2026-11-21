/**
 * Threads' kit (../kit.ts; decision 163): a follow network made of posts, built from its spec (./spec.ts) as X's is,
 * with the readers, presses and looks the two share (../follows/), and every network's looked-at kit around them
 * (../looking/kit.ts). Its site is asked for only when the person turns Threads on.
 */
import { followSite } from '../follows/site';
import { lookingKit } from '../looking/kit';
import { THREADS_SPEC } from './spec';

export const THREADS = followSite(THREADS_SPEC);
export const threads = lookingKit(THREADS);
