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
 * The input without these parts. The kernel still parses the command's own schema, refinements and all, before
 * anything runs, so the model's view can do without them (as scopedInput's does).
 */
function without(input: z.ZodObject, keys: readonly string[]): z.ZodObject {
  const shape = input.shape as Record<string, z.ZodType>;
  if (!keys.some((k) => k in shape)) return input;
  const rest = z.object(
    Object.fromEntries(Object.entries(shape).filter(([k]) => !keys.includes(k))),
  );
  const catchall = input._zod.def.catchall;
  return catchall ? rest.catchall(catchall) : rest;
}

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
    // What the worker fills is never the model's to give, so it isn't in what the model sees.
    const shown = without(view.input, action.filled ?? []);
    return [
      {
        name: screenActionName(name),
        description: action.about ? `${command.description} ${action.about}` : command.description,
        input: shown,
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
