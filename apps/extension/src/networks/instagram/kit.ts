/**
 * Instagram's kit (../kit.ts): still looked at (decision 78), so built from its site (./site.ts) as every such network's
 * is (../looking/kit.ts). Its site is asked for only when the person turns Instagram on.
 */
import { lookingKit } from '../looking/kit';
import { INSTAGRAM } from './site';

export const instagram = lookingKit(INSTAGRAM);
