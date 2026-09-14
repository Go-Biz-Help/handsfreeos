import { rng, type Rng } from '../calendar/random';
import {
  WorkflowDefinition,
  type StepInput,
  type WorkflowCatalogs,
  type WorkflowDefinitionInput,
} from '../../src/workflows/index';

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const DALE = uid(1);
export const PRIYA = uid(2);
export const JESS = uid(4); // left the workspace

export const SALES = uid(401);
export const STAGE_NEW = uid(402);
export const STAGE_ESTIMATE = uid(403);
export const STAGE_OLD = uid(404); // archived
export const OLD_PIPELINE = uid(405); // archived

export const VIP = uid(601);
export const GONE_TAG = uid(602); // deleted

export const SERVICE_CAL = uid(701);
export const OLD_CAL = uid(702); // archived

export const catalogs: WorkflowCatalogs = {
  timeZone: 'America/Chicago',
  team: [
    { userId: DALE, name: 'Dale', active: true },
    { userId: PRIYA, name: 'Priya', active: true },
    { userId: JESS, name: 'Jess', active: false },
  ],
  pipelines: [
    {
      id: SALES,
      name: 'Sales',
      archived: false,
      stages: [
        { id: STAGE_NEW, name: 'New', archived: false },
        { id: STAGE_ESTIMATE, name: 'Estimate sent', archived: false },
        { id: STAGE_OLD, name: 'Old', archived: true },
      ],
    },
    { id: OLD_PIPELINE, name: 'Old pipeline', archived: true, stages: [] },
  ],
  tags: [{ id: VIP, name: 'VIP' }],
  calendars: [
    { id: SERVICE_CAL, name: 'Service calls', archived: false },
    { id: OLD_CAL, name: 'Old calendar', archived: true },
  ],
  textingReady: true,
};

/** A readable step id: sid('text1') is 's_text1000'. */
export const sid = (name: string) => `s_${name.padEnd(8, '0').slice(0, 8)}`;
export const bid = (name: string) => `b_${name.padEnd(8, '0').slice(0, 8)}`;

export function def(input: Partial<WorkflowDefinitionInput> = {}): WorkflowDefinition {
  return WorkflowDefinition.parse({ version: 1, trigger: { kind: 'manual' }, ...input });
}

export const text = (
  id: string,
  body = 'Hi {{person.first_name | default:"there"}}',
): StepInput => ({
  id,
  type: 'action',
  action: 'send_text',
  config: { body },
});

export const waitDays = (id: string, amount = 1): StepInput => ({
  id,
  type: 'wait',
  until: { kind: 'duration', duration: { amount, unit: 'days' } },
});

export const end = (id: string): StepInput => ({ id, type: 'end' });

export const goto = (id: string, target: string, maxVisits = 3): StepInput => ({
  id,
  type: 'goto',
  target,
  maxVisits,
});

export const won = {
  match: 'all' as const,
  conditions: [{ field: 'lead.status', op: 'eq' as const, value: 'won' }],
};

export function ifElse(
  id: string,
  yes: StepInput[],
  no: StepInput[],
  names = ['yes', 'no'],
): StepInput {
  return {
    id,
    type: 'branch',
    mode: 'if_else',
    branches: [
      { id: bid(`${id.slice(2, 6)}${names[0]}`), name: 'Yes', condition: won, steps: yes },
      { id: bid(`${id.slice(2, 6)}${names[1]}`), name: 'No', condition: null, steps: no },
    ],
  };
}

/** Runs `body` once per seed; a failure names the seed (replay one with WORKFLOW_SEED=<n>). */
export function forWorkflowSeeds(runs: number, body: (r: Rng) => void): void {
  const replay = process.env.WORKFLOW_SEED;
  const base = Number(replay ?? 20260916);
  for (let i = 0; i < (replay ? 1 : runs); i++) {
    const seed = base + i;
    try {
      body(rng(seed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed with seed ${seed} (replay: WORKFLOW_SEED=${seed}).\n${message}`, {
        cause: error,
      });
    }
  }
}
