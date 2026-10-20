'use client';
import type { SearchHit } from '@hfos/core';
import { plainRow, type RowContext, type RowView } from './parts';

/** A company: its building, its name, and "12 people · 4 open leads". */
export function companyRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx);
}
