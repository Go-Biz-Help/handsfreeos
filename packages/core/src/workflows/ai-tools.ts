/**
 * The AI builder's tools: flat, strict tool definitions (recursive schemas aren't supported). Every
 * parameter is required; the optional ones are nullable. Step and action configs travel as JSON strings,
 * and `aiToolCallsToOps` turns the calls into patch ops, checking each with zod and applying it to a working
 * copy, so a bad call goes back to the model as a tool error it can repair.
 */
import { z } from 'zod';
import { ACTION_CONFIGS, ACTION_KEYS, ACTION_LABELS } from './actions';
import { FIELD_CATALOG } from './conditions';
import {
  Branch,
  STEP_TYPES,
  Step,
  Trigger,
  TRIGGER_EVENT_KEYS,
  WorkflowSettings,
  type WorkflowDefinition,
} from './definition';
import { BRANCH_ID_RE, newBranchId, newStepId, STEP_ID_RE } from './ids';
import { cloneJson, isPlainObject } from './json';
import { applyWorkflowOps, WorkflowOpError, type WorkflowOp } from './ops';
import { TEMPLATE_VARIABLES } from './templates';
import { laneSteps, REJECTED_LANE } from './walk';

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface BuilderToolDef {
  readonly name: BuilderToolName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly strict: true;
}

const str = (description: string): JsonSchema => ({ type: 'string', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const nullable = (schema: JsonSchema): JsonSchema => {
  const { description, ...rest } = schema;
  return { description, anyOf: [rest, { type: 'null' }] };
};
const oneOf = (values: readonly string[], description: string): JsonSchema => ({
  type: 'string',
  enum: [...values],
  description,
});
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const stepRef = str('A step id (s_…) or a ref you gave a step added earlier in this reply.');
const lane = {
  parentId: nullable(
    str(
      'null for the main path; else the id or ref of the branch or approval step that holds the list.',
    ),
  ),
  branchId: nullable(
    str(
      'The path’s id or ref on that branch step, or "rejected" for an approval’s rejected path; null for the main path.',
    ),
  ),
};

export const BUILDER_TOOL_NAMES = [
  'add_step',
  'update_step',
  'move_step',
  'delete_step',
  'add_branch',
  'delete_branch',
  'set_goto',
  'set_trigger',
  'set_settings',
  'finish',
] as const;
export type BuilderToolName = (typeof BUILDER_TOOL_NAMES)[number];

export const WORKFLOW_BUILDER_TOOLS: readonly BuilderToolDef[] = [
  {
    name: 'add_step',
    description:
      'Add one step. For a branch or approval, add its inner steps with further add_step calls that name it as parentId. A go-to can only be the last step of a path.',
    inputSchema: obj({
      ref: nullable(
        str('A short name for the new step (e.g. "text1") so later calls can point at it.'),
      ),
      ...lane,
      index: nullable(int('Position in that list, 0 first; null adds it at the end.')),
      type: oneOf(STEP_TYPES, 'The kind of step.'),
      action: nullable(oneOf(ACTION_KEYS, 'For type "action": which action.')),
      onError: nullable(
        oneOf(['stop', 'continue'], 'For actions: stop the run (default) or carry on if it fails.'),
      ),
      json: str(
        'The step’s fields as a JSON object (no id or type). For an action, its config. See the reference for each shape.',
      ),
    }),
    strict: true,
  },
  {
    name: 'update_step',
    description:
      'Change fields of an existing step with a JSON merge patch: objects merge, lists and null replace. For an action, config fields go under "config"; a new "action" replaces the config. Branch paths are renamed or re-conditioned under "branches": [{"id", "name", "condition", "description"}].',
    inputSchema: obj({ stepId: stepRef, json: str('The merge patch as a JSON object.') }),
    strict: true,
  },
  {
    name: 'move_step',
    description: 'Move a step (with everything inside it) to another place.',
    inputSchema: obj({
      stepId: stepRef,
      ...lane,
      index: nullable(
        int('Position in the target list once the step is taken out; null moves it to the end.'),
      ),
    }),
    strict: true,
  },
  {
    name: 'delete_step',
    description: 'Remove a step and everything inside it.',
    inputSchema: obj({ stepId: stepRef }),
    strict: true,
  },
  {
    name: 'add_branch',
    description: 'Add a path to a branch step (multi-path or AI-sorted; if/else always has two).',
    inputSchema: obj({
      stepId: stepRef,
      ref: nullable(str('A short name for the new path so later calls can use it as branchId.')),
      name: str('The path’s name, e.g. "Replied".'),
      condition: nullable(
        str(
          'For if/else and multi-path: a JSON condition group; null means "otherwise" (last path only).',
        ),
      ),
      description: nullable(str('For AI-sorted branches: when the AI should pick this path.')),
      index: nullable(int('Position among the paths; null adds it at the end.')),
    }),
    strict: true,
  },
  {
    name: 'delete_branch',
    description: 'Remove a path and its steps from a branch step.',
    inputSchema: obj({ stepId: stepRef, branchId: str('The path’s id or ref.') }),
    strict: true,
  },
  {
    name: 'set_goto',
    description: 'Point an existing go-to step at another step.',
    inputSchema: obj({
      stepId: stepRef,
      target: str('The step to go back to (id or ref).'),
      maxVisits: nullable(int('How many times it may jump (1–10); null keeps the current cap.')),
    }),
    strict: true,
  },
  {
    name: 'set_trigger',
    description: 'Replace what starts the workflow.',
    inputSchema: obj({ json: str('The trigger as a JSON object. See the reference.') }),
    strict: true,
  },
  {
    name: 'set_settings',
    description:
      'Change workflow settings: re-entry, stop-on, quiet hours, no consent, max run days.',
    inputSchema: obj({ json: str('A JSON object with only the settings to change.') }),
    strict: true,
  },
  {
    name: 'finish',
    description:
      'Call last, once: summarize the change in one or two plain sentences and list anything asked for that the workflow can’t do.',
    inputSchema: obj({
      summary: str('What changed, in plain words.'),
      unsupported: {
        type: 'array',
        items: { type: 'string' },
        description: 'Requests that couldn’t be done.',
      },
    }),
    strict: true,
  },
];

// ---- Converting calls to ops ----

export interface AiToolCall {
  readonly name: string;
  readonly input: unknown;
}

export interface AiToolResult {
  readonly callIndex: number;
  readonly ok: boolean;
  /** Sent back as the tool result (with is_error when not ok). */
  readonly message: string;
}

export interface AiToolConversion {
  /** The ops of every call that worked, in order; they apply cleanly to the definition passed in. */
  readonly ops: WorkflowOp[];
  readonly results: AiToolResult[];
  /** The definition after those ops. */
  readonly definition: WorkflowDefinition;
  readonly finish: { readonly summary: string; readonly unsupported: string[] } | null;
  /** The refs the model gave, with the ids made for them. */
  readonly refs: Readonly<Record<string, string>>;
}

class CallError extends Error {}

const nstr = z.string().nullable();
const nint = z.int().min(0).nullable();
const INPUTS = {
  add_step: z.object({
    ref: nstr,
    parentId: nstr,
    branchId: nstr,
    index: nint,
    type: z.enum(STEP_TYPES),
    action: z.enum(ACTION_KEYS).nullable(),
    onError: z.enum(['stop', 'continue']).nullable(),
    json: z.string(),
  }),
  update_step: z.object({ stepId: z.string(), json: z.string() }),
  move_step: z.object({ stepId: z.string(), parentId: nstr, branchId: nstr, index: nint }),
  delete_step: z.object({ stepId: z.string() }),
  add_branch: z.object({
    stepId: z.string(),
    ref: nstr,
    name: z.string(),
    condition: nstr,
    description: nstr,
    index: nint,
  }),
  delete_branch: z.object({ stepId: z.string(), branchId: z.string() }),
  set_goto: z.object({ stepId: z.string(), target: z.string(), maxVisits: z.int().nullable() }),
  set_trigger: z.object({ json: z.string() }),
  set_settings: z.object({ json: z.string() }),
  finish: z.object({ summary: z.string(), unsupported: z.array(z.string()) }),
} satisfies Record<BuilderToolName, z.ZodType>;

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
    .join('; ');
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CallError(`${what} isn’t valid JSON.`);
  }
  if (!isPlainObject(value)) throw new CallError(`${what} must be a JSON object.`);
  return value;
}

/**
 * Turns the model's tool calls into validated ops. Each call is checked and applied to a working copy in
 * turn; a failing call is left out and reported, and later calls see the tree as the good calls left it.
 */
export function aiToolCallsToOps(
  calls: readonly AiToolCall[],
  def: WorkflowDefinition,
  random?: () => number,
): AiToolConversion {
  let work = def;
  const ops: WorkflowOp[] = [];
  const results: AiToolResult[] = [];
  const stepRefs: Record<string, string> = {};
  const branchRefs: Record<string, string> = {};
  let finish: AiToolConversion['finish'] = null;

  const stepId = (value: string): string => {
    if (STEP_ID_RE.test(value)) return value;
    const id = stepRefs[value];
    if (!id) throw new CallError(`There’s no step “${value}”.`);
    return id;
  };
  const branchId = (value: string | null): string | null => {
    if (value === null || value === REJECTED_LANE || BRANCH_ID_RE.test(value)) return value;
    const id = branchRefs[value];
    if (!id) throw new CallError(`There’s no path “${value}”.`);
    return id;
  };
  const claimRef = (ref: string | null, id: string, into: Record<string, string>) => {
    if (ref === null) return;
    if (into[ref] || STEP_ID_RE.test(ref) || BRANCH_ID_RE.test(ref))
      throw new CallError(`The ref “${ref}” is already used; pick another.`);
    into[ref] = id;
  };
  const checked = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CallError(`${what}: ${zodMessage(parsed.error)}`);
    return parsed.data;
  };

  const toOps = (
    name: BuilderToolName,
    raw: unknown,
    pending: Record<string, string>,
  ): WorkflowOp[] => {
    switch (name) {
      case 'add_step': {
        const input = checked(INPUTS.add_step, raw, 'The call');
        const json = parseJsonObject(input.json, 'json');
        const id = newStepId(random);
        let step: Record<string, unknown>;
        if (input.type === 'action') {
          if (!input.action) throw new CallError('An action step needs "action".');
          step = {
            id,
            type: 'action',
            action: input.action,
            config: json,
            onError: input.onError ?? 'stop',
          };
        } else {
          delete json.id;
          delete json.type;
          step = { ...json, id, type: input.type };
        }
        if (input.type === 'branch') {
          if (!Array.isArray(json.branches)) throw new CallError('A branch step needs "branches".');
          step.branches = json.branches.map((b: unknown) => {
            if (!isPlainObject(b)) throw new CallError('Each path must be an object.');
            if (Array.isArray(b.steps) && b.steps.length)
              throw new CallError('Add a path’s steps with separate add_step calls.');
            const bid = newBranchId(random);
            if (typeof b.ref === 'string') claimRef(b.ref, bid, pending);
            const { ref: _ref, steps: _steps, ...rest } = b;
            return { ...rest, id: bid, steps: [] };
          });
        }
        if (input.type === 'approval') {
          if (isPlainObject(json.rejected))
            throw new CallError('Add rejected steps with add_step and branchId "rejected".');
          if (typeof json.previewStepId === 'string')
            step.previewStepId = stepId(json.previewStepId);
        }
        if (input.type === 'goto' && typeof json.target === 'string')
          step.target = stepId(json.target);
        if (
          input.type === 'action' &&
          input.action === 'complete_task' &&
          typeof json.taskStepId === 'string'
        )
          step.config = { ...json, taskStepId: stepId(json.taskStepId) };
        const parsed = checked(Step, step, 'The step');
        claimRef(input.ref, id, stepRefs);
        return [
          {
            op: 'add_step',
            parentId: input.parentId === null ? null : stepId(input.parentId),
            branchId: branchId(input.branchId),
            index: input.index,
            step: parsed,
          },
        ];
      }
      case 'update_step': {
        const input = checked(INPUTS.update_step, raw, 'The call');
        const patch = parseJsonObject(input.json, 'json');
        if (Array.isArray(patch.branches))
          patch.branches = patch.branches.map((b: unknown) =>
            isPlainObject(b) && typeof b.id === 'string' ? { ...b, id: branchId(b.id) } : b,
          );
        if (typeof patch.target === 'string') patch.target = stepId(patch.target);
        if (typeof patch.previewStepId === 'string')
          patch.previewStepId = stepId(patch.previewStepId);
        return [{ op: 'update_step', stepId: stepId(input.stepId), patch }];
      }
      case 'move_step': {
        const input = checked(INPUTS.move_step, raw, 'The call');
        const id = stepId(input.stepId);
        const to = {
          parentId: input.parentId === null ? null : stepId(input.parentId),
          branchId: branchId(input.branchId),
        };
        const target = laneSteps(work, to);
        if (!target) throw new CallError('That place in the workflow doesn’t exist.');
        const index = input.index ?? target.filter((s) => s.id !== id).length;
        return [{ op: 'move_step', stepId: id, ...to, index }];
      }
      case 'delete_step':
        return [
          {
            op: 'delete_step',
            stepId: stepId(checked(INPUTS.delete_step, raw, 'The call').stepId),
          },
        ];
      case 'add_branch': {
        const input = checked(INPUTS.add_branch, raw, 'The call');
        const id = newBranchId(random);
        const branch = checked(
          Branch,
          {
            id,
            name: input.name,
            condition:
              input.condition === null ? null : parseJsonObject(input.condition, 'condition'),
            description: input.description,
            steps: [],
          },
          'The path',
        );
        claimRef(input.ref, id, pending);
        return [{ op: 'add_branch', stepId: stepId(input.stepId), index: input.index, branch }];
      }
      case 'delete_branch': {
        const input = checked(INPUTS.delete_branch, raw, 'The call');
        return [
          {
            op: 'delete_branch',
            stepId: stepId(input.stepId),
            branchId: branchId(input.branchId)!,
          },
        ];
      }
      case 'set_goto': {
        const input = checked(INPUTS.set_goto, raw, 'The call');
        return [
          {
            op: 'set_goto',
            stepId: stepId(input.stepId),
            target: stepId(input.target),
            maxVisits: input.maxVisits,
          },
        ];
      }
      case 'set_trigger': {
        const trigger = checked(
          Trigger,
          parseJsonObject(checked(INPUTS.set_trigger, raw, 'The call').json, 'json'),
          'The trigger',
        );
        return [{ op: 'set_trigger', trigger }];
      }
      case 'set_settings': {
        const patch = parseJsonObject(checked(INPUTS.set_settings, raw, 'The call').json, 'json');
        checked(WorkflowSettings.partial().strict(), patch, 'The settings');
        return [{ op: 'set_settings', patch }];
      }
      case 'finish': {
        const input = checked(INPUTS.finish, raw, 'The call');
        finish = {
          summary: input.summary.trim(),
          unsupported: input.unsupported.map((u) => u.trim()).filter(Boolean),
        };
        return [];
      }
    }
  };

  calls.forEach((call, callIndex) => {
    try {
      if (!(BUILDER_TOOL_NAMES as readonly string[]).includes(call.name))
        throw new CallError(`There’s no tool ${call.name}.`);
      const pending: Record<string, string> = {};
      const callOps = toOps(call.name as BuilderToolName, call.input, pending);
      const applied = callOps.length ? applyWorkflowOps(work, callOps).definition : work;
      work = applied;
      ops.push(...callOps);
      Object.assign(branchRefs, pending);
      const added = callOps.find((o) => o.op === 'add_step');
      const message =
        added && added.op === 'add_step' ? `Done. The new step’s id is ${added.step.id}.` : 'Done.';
      results.push({ callIndex, ok: true, message });
    } catch (error) {
      if (error instanceof CallError || error instanceof WorkflowOpError) {
        const detail =
          error instanceof WorkflowOpError && error.issues.length
            ? ` (${error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')})`
            : '';
        results.push({ callIndex, ok: false, message: `${error.message}${detail}` });
        return;
      }
      throw error;
    }
  });

  return { ops, results, definition: work, finish, refs: { ...stepRefs, ...branchRefs } };
}

// ---- The reference the builder's prompt carries ----

const compact = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return JSON.stringify(json);
};

/** The shapes behind the JSON strings, the fields conditions can check, and the template variables. */
export function aiBuilderReference(): string {
  const lines = [
    'Step json by type:',
    '- action: the action’s config (below).',
    '- wait: {"until": {"kind":"duration","duration":{"amount":1,"unit":"days"}} | {"kind":"time_of_day","at":"09:00","days":[1,2,3,4,5]} | {"kind":"date_field","anchor":"appointment.starts_at","offset":{"amount":1,"unit":"days","direction":"before"},"at":"09:00"} | {"kind":"event","events":["message.received"],"filter":{"match":"all","conditions":[]},"timeout":{"amount":30,"unit":"minutes"}}}',
    '- branch: {"mode":"if_else"|"multi"|"ai","branches":[{"ref":"yes","name":"Replied","condition":{…}|null,"description":null}]} (if/else: exactly 2; the last may have condition null = otherwise; ai: every path needs a description).',
    '- ai: {"task":"write"|"classify"|"summarize","prompt":"…","categories":[],"outputKey":null,"channel":"sms","fallback":null,"useKnowledge":true}; results are {{ai.message}}, {{ai.category}} or {{ai.summary}}.',
    '- approval: {"approvers":{"kind":"admins"},"message":"…","previewStepId":null,"expiresAfter":{"amount":2,"unit":"days"},"onExpire":"reject"}',
    '- goto: {"target":"<step id or ref>","maxVisits":3}; end: {}',
    'Condition group: {"match":"all"|"any","conditions":[{"field":"lead.status","op":"eq","value":"won"}, …]} (groups nest 3 deep).',
    `Trigger json: {"kind":"event","event":one of ${TRIGGER_EVENT_KEYS.join(', ')},"filters":{…}} | {"kind":"schedule","cadence":{"every":"weekly","days":[1],"at":"09:00"}|{"every":"monthly","day":1|"last","at":"09:00"},"audience":{…}} | {"kind":"date","anchor":…,"offset":{…},"at":null} | {"kind":"webhook","personBy":"phone_or_email","createPerson":true} | {"kind":"manual"}`,
    'Action configs:',
    ...Object.entries(ACTION_CONFIGS).map(
      ([k, schema]) =>
        `- ${k} (${ACTION_LABELS[k as keyof typeof ACTION_LABELS]}): ${compact(schema)}`,
    ),
    `Condition fields: ${FIELD_CATALOG.map((f) => `${f.key} (${f.type}${f.options ? `: ${f.options.map((o) => o.value).join('|')}` : ''})`).join(', ')}`,
    `Template variables: ${TEMPLATE_VARIABLES.map((v) => `{{${v.path}}}`).join(', ')}; filters: default:"x", time, date, first, upper, lower.`,
  ];
  return lines.join('\n');
}

/** Copies of the tool definitions (callers may mutate what they send). */
export function builderToolDefs(): BuilderToolDef[] {
  return cloneJson(WORKFLOW_BUILDER_TOOLS as BuilderToolDef[]);
}
