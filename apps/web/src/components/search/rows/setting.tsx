'use client';
import type { SearchHit } from '@hfos/core';
import { plainRow, type RowContext, type RowView } from './parts';

/** A setting, found on the device: "Quiet hours" and "Settings › Texting & calls · 9:00 PM to 8:00 AM". */
export function settingRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx);
}
