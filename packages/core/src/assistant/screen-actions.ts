/**
 * The screens' commands as the Assistant's own tools (coverage.ts lists them): each made from the command itself —
 * its description, its input without the business's ids, its permission and its risk — and run as the person,
 * through the kernel, on a card that waits for their OK. Server-side: it reads the registry.
 */
import { z } from 'zod';
import { scopedInput, type ScopeKey } from '../addons/ai';
import type { Registry } from '../kernel/registry';
import type { CommandDef } from '../kernel/types';
import { isStaffPermission, type Permission } from '../permissions';
import { SCREEN_ACTIONS } from './coverage';
import type { AssistantTool } from './tool-kit';

/** One of the screens' commands, offered to the Assistant as a tool. */
export interface ScreenActionTool extends AssistantTool<z.ZodObject> {
  readonly command: CommandDef;
  /** The business ids its input takes, which the executor puts on after the model's arguments. */
  readonly scope: readonly ScopeKey[];
  readonly warning: string | null;
  /** HandsFreeOS's own staff only: offered to nobody else, so it's never mentioned to anyone else either. */
  readonly staff: boolean;
}

/** Whether an offered tool is one of these (it runs through the one executor for them). */
export const isScreenActionTool = (tool: object): tool is ScreenActionTool =>
  'command' in tool && 'scope' in tool && !('op' in tool);

/** `funnel.add_person` → `do_funnel_add_person`. */
export const screenActionName = (command: string) => `do_${command.replace(/\./g, '_')}`;

/**
 * The tools, from the registry. A command of risk 0 (setting a note aside, marking a notification opened) runs on
 * its own; everything else waits for the person's OK. A staff command looks across businesses, so its input keeps
 * the business it acts on; anyone else's always acts in the business they asked in.
 */
export function screenActionTools(registry: Pick<Registry, 'command'>): ScreenActionTool[] {
  return Object.entries(SCREEN_ACTIONS).flatMap(([name, action]) => {
    const command = registry.command(name);
    const permission = action.offeredTo ?? command?.permission;
    if (!command || !permission || !(command.input instanceof z.ZodObject)) return [];
    const input = command.input;
    const staff = isStaffPermission(permission);
    const view = staff ? { input, scope: [] } : scopedInput(input);
    return [
      {
        name: screenActionName(name),
        description: command.description,
        input: view.input,
        autonomy: command.risk === 0 ? ('auto' as const) : ('confirm' as const),
        permission: permission as Permission,
        command,
        scope: view.scope,
        warning: action.warning ?? null,
        staff,
      },
    ];
  });
}
