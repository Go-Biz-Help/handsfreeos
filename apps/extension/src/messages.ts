/**
 * What the side panel asks a Facebook tab, and what the tab answers. Both ends are the extension's own: Facebook's
 * scripts never see these messages.
 */
import type { ReadResult } from './facebook/types';

export type Ask = { readonly type: 'hfos-read' } | { readonly type: 'hfos-outline' };

export type Answer =
  | { readonly ok: true; readonly result: ReadResult; readonly outline?: string }
  | { readonly ok: false; readonly error: string };
