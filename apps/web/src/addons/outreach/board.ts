/**
 * The People tab's board (docs/outreach.md, decision 59): a column for each stage the person acts on, each its first
 * few people, which come in the page's one answer (`columns` of `outreach.stages`). A plain module, so the page asks
 * for the columns on the server and ./pipeline-view.tsx draws them.
 */
import type { Pipeline, PipelinePerson } from './types';

/** The board's columns, in order. */
export const BOARD_STAGES = ['friends', 'talking', 'ready', 'pitched', 'booked'] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];
/** Each column's first people: the rest are behind its See all. */
export type Board = Readonly<Record<BoardStage, readonly PipelinePerson[]>>;

/** The board from the answer's columns: a stage the answer left out has nobody. */
export function boardOf(columns: NonNullable<Pipeline['columns']>): Board {
  const at = (stage: BoardStage) => columns.find((column) => column.stage === stage)?.people ?? [];
  return {
    friends: at('friends'),
    talking: at('talking'),
    ready: at('ready'),
    pitched: at('pitched'),
    booked: at('booked'),
  };
}
