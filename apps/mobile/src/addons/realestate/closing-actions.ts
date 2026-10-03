import type { FinancingStep, FindingSeverity } from '@hfos/core/addons/realestate/closing';
import type { ClientTaskKind, ClientTaskPreset } from '@hfos/core/addons/realestate/client-words';

import { change, newId } from '@/changes';

/**
 * The closing side's changes from the phone (boards 85 and 86), each a command through the queue: a loan's step
 * ticked when the lender calls, a finding added at the inspection, a task for the clients, and the walkthrough. Each
 * writes what the person should see at once into the phone's copy of Real Estate's rows (`addon_phone_rows`, whose
 * id is `<source>:<the row's id>`), in the same transaction; those rows leave at the next checkpoint once the change
 * is handled. Things made here take the phone's id, so a later change can point at them.
 */

const nowIso = () => new Date().toISOString();

/** A new row of Real Estate's in the phone's copy, as the server will send it. */
export const INSERT_ROW_SQL = `
  INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data, updated_at)
  VALUES (?, ?, 'realestate', ?, ?, ?, ?)`;

const rowArgs = (
  workspaceId: string,
  source: string,
  id: string,
  dealId: string,
  data: Record<string, unknown>,
) => [`${source}:${id}`, workspaceId, source, dealId, JSON.stringify(data), nowIso()];

// ---------- financing ----------

export const STEP_DONE_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data, '$.status', 'done', '$.done_on', ?, '$.proof_kind', ?, '$.proof_id', ?, '$.done_by', ?)
  WHERE source = 'financing_steps' AND record_id = ? AND json_extract(data, '$.step') = ?`;

export const STEP_NEW_SQL = `
  INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data, updated_at)
  SELECT ?, ?, 'realestate', 'financing_steps', ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM addon_phone_rows r
    WHERE r.source = 'financing_steps' AND r.record_id = ? AND json_extract(r.data, '$.step') = ?
  )`;

/** A loan's step ticked done with its proof: a document on the deal, or a photo of the lender's letter. */
export async function markStepDone(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly userId: string;
  readonly step: FinancingStep;
  readonly doneOn: string;
  readonly proof: { readonly kind: 'document' | 'file'; readonly id: string };
  /** The photo's upload, when the proof is one taken just now. */
  readonly dependsOn?: readonly string[];
}): Promise<void> {
  const { workspaceId, dealId, step, doneOn, proof } = input;
  await change(
    'realestate.financing.mark_done',
    { workspaceId, dealId, step, doneOn, proof },
    {
      dependsOn: input.dependsOn,
      optimistic: async (tx) => {
        await tx.execute(STEP_DONE_SQL, [doneOn, proof.kind, proof.id, input.userId, dealId, step]);
        const id = newId();
        await tx.execute(STEP_NEW_SQL, [
          `financing_steps:${id}`,
          workspaceId,
          dealId,
          JSON.stringify({
            step,
            status: 'done',
            done_on: doneOn,
            proof_kind: proof.kind,
            proof_id: proof.id,
            done_by: input.userId,
          }),
          nowIso(),
          dealId,
          step,
        ]);
      },
    },
  );
}

// ---------- inspections ----------

/** A finding added at the inspection, often in a basement with no signal, with the photos taken of it. */
export async function addFinding(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly inspectionId: string;
  readonly title: string;
  readonly location: string | null;
  readonly severity: FindingSeverity;
  /** After the findings already there. */
  readonly position: number;
  /** Photos already on the deal's files (taken just now: their uploads are `dependsOn`). */
  readonly photoFileIds?: readonly string[];
  readonly dependsOn?: readonly string[];
}): Promise<string> {
  const id = newId();
  const { workspaceId, dealId, inspectionId, title, location, severity } = input;
  const photos = [...(input.photoFileIds ?? [])];
  await change(
    'realestate.finding.add',
    {
      workspaceId,
      id,
      inspectionId,
      title,
      severity,
      ...(location ? { location } : {}),
      ...(photos.length ? { photoFileIds: photos } : {}),
    },
    {
      dependsOn: input.dependsOn,
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'inspection_findings', id, dealId, {
            inspection_id: inspectionId,
            title,
            location,
            severity,
            ask: 'not_asked',
            position: input.position,
            photo_file_ids: photos,
          }),
        ),
    },
  );
  return id;
}

/** The repair request, drafted from the findings and edited. */
export async function sendRepairRequest(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly words: string;
}): Promise<void> {
  await change('realestate.repair.send', input);
}

// ---------- the client's to-do ----------

/** A task for the clients, in their portal. */
export async function addClientTask(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly preset: ClientTaskPreset | null;
  readonly kind: ClientTaskKind;
  readonly title: string;
  readonly detail: string | null;
  readonly forPersonId: string | null;
  readonly dueOn: string | null;
}): Promise<string> {
  const id = newId();
  const { workspaceId, dealId } = input;
  await change(
    'realestate.client_task.add',
    {
      workspaceId,
      dealId,
      id,
      ...(input.preset
        ? { preset: input.preset }
        : { kind: input.kind as 'upload' | 'sign_off' | 'do', title: input.title }),
      ...(input.forPersonId ? { forPersonId: input.forPersonId } : {}),
      ...(input.dueOn ? { dueOn: input.dueOn } : {}),
    },
    {
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'client_tasks', id, dealId, {
            kind: input.kind,
            title: input.title,
            detail: input.detail,
            for_person_id: input.forPersonId,
            due_on: input.dueOn,
            status: 'open',
            created_at: nowIso(),
          }),
        ),
    },
  );
  return id;
}

export const TASK_DONE_SQL = `
  UPDATE addon_phone_rows SET data = json_set(data, '$.status', 'done', '$.done_at', ?) WHERE id = ?`;

/** A task the client did another way, marked done for them with how. */
export async function markClientTaskDone(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly userId: string;
  readonly taskId: string;
  readonly personId: string;
  readonly note: string;
}): Promise<void> {
  const { workspaceId, dealId, taskId, personId, note } = input;
  const at = nowIso();
  await change(
    'realestate.client_task.mark_done',
    { workspaceId, taskId, personId, note },
    {
      optimistic: async (tx) => {
        await tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'client_task_completions', newId(), dealId, {
            task_id: taskId,
            person_id: personId,
            at,
            note,
            recorded_by: input.userId,
          }),
        );
        await tx.execute(TASK_DONE_SQL, [at, `client_tasks:${taskId}`]);
      },
    },
  );
}

/** Lets a client into their portal, or sends them the link again (with signal: it emails them). */
export async function invitePortal(input: {
  readonly workspaceId: string;
  readonly personId: string;
}): Promise<void> {
  await change('portal_access.give', input);
}

// ---------- the walkthrough ----------

/** Builds the walkthrough's list from the deal as HandsFreeOS has it (with signal). */
export async function planWalkthrough(input: {
  readonly workspaceId: string;
  readonly dealId: string;
}): Promise<void> {
  await change('realestate.walkthrough.plan', { ...input, id: newId() });
}

export const WALKTHROUGH_START_SQL = `
  UPDATE addon_phone_rows SET data = json_set(data, '$.state', 'started', '$.started_at', ?)
  WHERE id = ? AND json_extract(data, '$.state') = 'planned'`;

export async function startWalkthrough(input: {
  readonly workspaceId: string;
  readonly walkthroughId: string;
}): Promise<void> {
  await change('realestate.walkthrough.start', input, {
    optimistic: (tx) =>
      tx.execute(WALKTHROUGH_START_SQL, [nowIso(), `walkthroughs:${input.walkthroughId}`]),
  });
}

export const ITEM_CHECK_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data, '$.state', ?, '$.note', ?, '$.photo_file_ids', json(?), '$.checked_by', ?, '$.checked_at', ?)
  WHERE id = ?`;

/** One thing on the walkthrough checked: OK, not right or not sure, with a note and photos. */
export async function checkWalkthroughItem(input: {
  readonly workspaceId: string;
  readonly walkthroughId: string;
  readonly userId: string;
  readonly itemId: string;
  readonly state: 'ok' | 'not_ok' | 'unsure' | 'unchecked';
  readonly note: string;
  readonly photoFileIds: readonly string[];
  /** The photos' uploads. */
  readonly dependsOn?: readonly string[];
}): Promise<void> {
  const { workspaceId, itemId, state, note } = input;
  const checked = state !== 'unchecked';
  const at = nowIso();
  await change(
    'realestate.walkthrough.check_item',
    { workspaceId, itemId, state, note, photoFileIds: [...input.photoFileIds] },
    {
      dependsOn: input.dependsOn,
      optimistic: async (tx) => {
        await tx.execute(ITEM_CHECK_SQL, [
          state,
          note || null,
          JSON.stringify(input.photoFileIds),
          checked ? input.userId : null,
          checked ? at : null,
          `walkthrough_items:${itemId}`,
        ]);
        // Checking starts it, when nobody pressed Start.
        await tx.execute(WALKTHROUGH_START_SQL, [at, `walkthroughs:${input.walkthroughId}`]);
      },
    },
  );
}

/** Something to check that the list doesn't have. */
export async function addWalkthroughItem(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly walkthroughId: string;
  readonly title: string;
  readonly detail: string | null;
  /** After the things already on it. */
  readonly position: number;
}): Promise<string> {
  const id = newId();
  const { workspaceId, dealId, walkthroughId, title, detail } = input;
  await change(
    'realestate.walkthrough.add_item',
    { workspaceId, id, walkthroughId, title, ...(detail ? { detail } : {}) },
    {
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'walkthrough_items', id, dealId, {
            walkthrough_id: walkthroughId,
            source: 'added',
            title,
            detail,
            state: 'unchecked',
            photo_file_ids: [],
            position: input.position,
          }),
        ),
    },
  );
  return id;
}

export const WALKTHROUGH_FINISH_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data, '$.state', 'done', '$.finished_at', ?, '$.clients_agreed_at', ?,
    '$.started_at', coalesce(json_extract(data, '$.started_at'), ?))
  WHERE id = ?`;

/** The walkthrough finished: each thing not right becomes a duty before closing, when it reaches HandsFreeOS. */
export async function finishWalkthrough(input: {
  readonly workspaceId: string;
  readonly walkthroughId: string;
  readonly clientsAgreed: boolean;
}): Promise<void> {
  const at = nowIso();
  await change('realestate.walkthrough.finish', input, {
    optimistic: (tx) =>
      tx.execute(WALKTHROUGH_FINISH_SQL, [
        at,
        input.clientsAgreed ? at : null,
        at,
        `walkthroughs:${input.walkthroughId}`,
      ]),
  });
}
