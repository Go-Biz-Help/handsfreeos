'use client';
import type { SearchHit } from '@hfos/core';
import { plainRow, type RowContext, type RowView } from './parts';

/** A visit or a meeting: its title, and "Thu, Oct 23 · 8:00–10:00 AM · Jo Smithers". */
export function calendarRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx);
}
