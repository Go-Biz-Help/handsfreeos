/**
 * Alignable's kit (../kit.ts): still looked at (decision 78), so built from its site (./site.ts) as every such network's
 * is (../looking/kit.ts). Its site is asked for only when the person turns Alignable on.
 */
import { lookingKit } from '../looking/kit';
import { ALIGNABLE } from './site';

export const alignable = lookingKit(ALIGNABLE);
