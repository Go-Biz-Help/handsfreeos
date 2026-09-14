import { expect } from '@playwright/test';
import { PASSWORD } from './helpers';

/**
 * The API as the web app calls it, for the approval specs: a person's token, commands and queries, a
 * workflow built from steps, published after a passing Simulate test, and a customer's latest run.
 */

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

/** A bearer token from Supabase's password sign-in, with the publishable key the web app holds. */
export async function signInForApi(email: string): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error('The Supabase URL and publishable key come from .env.local (pnpm env:local).');
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Signing in for the API failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export type Api = <T = unknown>(
  path: `${'commands' | 'queries'}/${string}`,
  body: Record<string, unknown>,
) => Promise<T>;

/** Runs a command or query through the API as that person. */
export const apiAs =
  (token: string): Api =>
  async <T>(path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${API_URL}/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

export interface WorkflowGet {
  workflow: {
    revision: number;
    tested: boolean;
    definition: { steps: Record<string, unknown>[] };
  };
}

/** A manual workflow with these steps, one after another; its id and draft revision. */
export async function createWorkflow(
  api: Api,
  workspaceId: string,
  name: string,
  steps: Record<string, unknown>[],
): Promise<{ workflowId: string; revision: number }> {
  const created = await api<{ workflowId: string; revision: number }>('commands/workflow.create', {
    workspaceId,
    name,
    from: 'blank',
    trigger: { kind: 'manual' },
  });
  const saved = await api<{ revision: number }>('commands/workflow.save_draft', {
    workspaceId,
    workflowId: created.workflowId,
    baseRevision: created.revision,
    ops: steps.map((step) => ({
      op: 'add_step',
      parentId: null,
      branchId: null,
      index: null,
      step,
    })),
  });
  return { workflowId: created.workflowId, revision: saved.revision };
}

/** Runs a Simulate test of the draft, waits for it to pass, and publishes it. */
export async function testAndPublish(api: Api, workspaceId: string, workflowId: string) {
  await api('commands/workflow.test', { workspaceId, workflowId, mode: 'simulate' });
  let revision = 0;
  await expect
    .poll(
      async () => {
        const got = await api<WorkflowGet>('queries/workflow.get', { workspaceId, workflowId });
        revision = got.workflow.revision;
        return got.workflow.tested;
      },
      { timeout: 60_000, message: 'the worker passes a Simulate test of the draft' },
    )
    .toBe(true);
  await api('commands/workflow.publish', { workspaceId, workflowId, baseRevision: revision });
}

export interface RunSummary {
  id: string;
  status: string;
  endReason: string | null;
}

/** A customer's latest run of a workflow. */
export async function runFor(
  api: Api,
  workspaceId: string,
  workflowId: string,
  personId: string,
): Promise<RunSummary | undefined> {
  const out = await api<{ items: RunSummary[] }>('queries/workflow.run_list', {
    workspaceId,
    workflowId,
    personId,
  });
  return out.items[0];
}

/** "status" or "status:endReason" of a customer's latest run, for polling. */
export async function runState(
  api: Api,
  workspaceId: string,
  workflowId: string,
  personId: string,
): Promise<string | null> {
  const r = await runFor(api, workspaceId, workflowId, personId);
  if (!r) return null;
  return r.endReason ? `${r.status}:${r.endReason}` : r.status;
}
