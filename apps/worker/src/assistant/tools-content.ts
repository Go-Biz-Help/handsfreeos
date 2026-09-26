/**
 * The Assistant's content tools (packages/core/src/assistant/tools-content.ts): what each does when it runs on its own
 * ("auto"), and the card it shows and the command it runs once the person presses Confirm ("confirm").
 */
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import type { SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;

export const contentAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {};

export const contentConfirmTools: Record<string, SettingsConfirmTool> = {};

/** What the panel says while each one runs. */
export const contentStepLabels: Record<string, string> = {};
