/**
 * X's kit (../kit.ts; decision 163): a follow network made of posts, built from its spec (./spec.ts) as Threads' is,
 * with the readers, presses and looks the two share (../follows/), and every network's looked-at kit around them
 * (../looking/kit.ts). Its site is asked for only when the person turns X on.
 */
import { followSite } from '../follows/site';
import { lookingKit } from '../looking/kit';
import { X_SPEC } from './spec';

export const X = followSite(X_SPEC);
export const x = lookingKit(X);
