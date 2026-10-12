/**
 * The People tab's board (docs/outreach.md, decision 59): a column for each stage the person acts on, each its first
 * page, asked one stage at a time. A plain module, so the page asks for the columns on the server and
 * ./pipeline-view.tsx draws them.
 */
import type { Pipeline } from './types';

/** The board's columns, in order. */
export const BOARD_STAGES = ['friends', 'talking', 'ready', 'pitched', 'booked'] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];
/** Each column's first page. */
export type Board = Readonly<Record<BoardStage, Pipeline>>;
