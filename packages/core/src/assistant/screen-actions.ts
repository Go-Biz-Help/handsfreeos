/**
 * The screens' commands as the Assistant's own tools (coverage.ts lists them): each made from the command itself —
 * its description, its input without the business's ids, its permission and its risk — and run as the person,
 * through the kernel, on a card that waits for their OK. Server-side: it reads the registry.
 */
import { z } from 'zod';
import { scopedInput, type ScopeKey } from '../addons/ai';
import type { Registry } from '../kernel/registry';
import type { CommandDef } from '../kernel/types';
import { isOrgPermission, isStaffPermission, type Permission } from '../permissions';
import { uuid } from '../schemas/common';
import { SCREEN_ACTIONS } from './coverage';
import { withAgencyDoor } from './screen-reads';
import type { AssistantTool } from './tool-kit';

/** One of the screens' commands, offered to the Assistant as a tool. */
export interface ScreenActionTool extends AssistantTool<z.ZodObject> {
  readonly command: CommandDef;
  /** The business ids its input takes, which the executor puts on after the model's arguments. */
  readonly scope: readonly ScopeKey[];
  readonly warning: string | null;
  /** HandsFreeOS's own staff only: offered to nobody else, so it's never mentioned to anyone else either. */
  readonly staff: boolean;
  /** Either door: it may be asked of the whole agency (`wholeAgency`). */
  readonly agencyDoor: boolean;
  /** It names one of the agency's client businesses (`businessId`), checked by the executor before it's put on. */
  readonly forBusiness: boolean;
  /**
   * The agency's own (an `org.*` permission): only its owners and admins may. The executor checks that first, so
   * anyone else is told who can, not that the agency isn't there.
   */
  readonly agencyOnly: boolean;
  /** Choices it is never offered (coverage.ts), which the executor refuses by name if asked anyway. */
  readonly notOffered: {
    readonly field: string;
    readonly values: readonly string[];
    readonly why: string;
  } | null;
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

/** The input with the choices it's never offered left out of one part's list (a `to` that removes for good). */
function narrowed(input: z.ZodObject, never: ScreenActionTool['notOffered']): z.ZodObject {
  if (!never) return input;
  const part = (input.shape as Record<string, z.ZodType>)[never.field];
  if (!(part instanceof z.ZodEnum)) return input;
  return input.extend({ [never.field]: part.exclude(never.values as never) });
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
    const staff = isStaffPermission(permission);
    const view = staff ? { input: command.input, scope: [] } : scopedInput(command.input);
    // What the worker fills is never the model's to give, so it isn't in what the model sees.
    const notOffered = action.notOffered ?? null;
    const shown = narrowed(without(view.input, action.filled ?? []), notOffered);
    const agencyDoor = !!action.agencyDoor && view.scope.includes('workspaceId');
    // The client business it names, which the executor checks is the agency's before it puts it on as workspaceId.
    const forBusiness = !!action.forBusiness && view.scope.includes('workspaceId');
    const input = forBusiness
      ? shown.extend({ businessId: uuid.optional().describe(action.forBusiness!) })
      : withAgencyDoor(shown, agencyDoor);
    return [
      {
        name: screenActionName(name),
        description: action.about ? `${command.description} ${action.about}` : command.description,
        input,
        autonomy: command.risk === 0 ? ('auto' as const) : ('confirm' as const),
        permission: permission as Permission,
        command,
        scope: view.scope,
        warning: action.warning ?? null,
        staff,
        agencyDoor,
        forBusiness,
        agencyOnly: !!command.permission && isOrgPermission(command.permission),
        notOffered,
      },
    ];
  });
}
