'use client';
import {
  applyWorkflowOps,
  parseDefinition,
  WorkflowOpError,
  type WorkflowDefinition,
  type WorkflowOp,
} from '@hfos/core';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowSaveDraftBody } from '@/lib/api/types';
import { appendOps, sameJson } from './patches';

/**
 * The one workflow draft that Steps, Canvas and Describe all edit. Every change is a batch of patch ops
 * applied in the browser with core's `applyWorkflowOps` (all or nothing), recorded for Undo and Redo, and
 * autosaved: one save at a time, in order, each carrying the ops made since the last confirmed save and the
 * revision they were made against. A draft never runs, so saving as you go is safe; Publish is the one
 * deliberate act. Opening and closing a workflow without changing anything never saves.
 */

/** `saved`: nothing waiting. `saving`: ops queued or on their way. `retrying`: the last try failed and
 * another is scheduled. `failed`: the server refused the ops (they're kept). `conflict`: someone else saved. */
export type SaveState = 'saved' | 'saving' | 'retrying' | 'failed' | 'conflict';

export interface ApplyOptions {
  /** Edits with the same key a moment apart are one Undo step, so typing in a field isn't 40 undos. */
  readonly group?: string;
  /** Don't toast a refusal: the caller shows it beside the field. */
  readonly quiet?: boolean;
}

export type ApplyOutcome =
  | { readonly ok: true; readonly definition: WorkflowDefinition }
  | { readonly ok: false; readonly message: string; readonly error: unknown };

export interface WorkflowDraft {
  /** The draft as it is in this tab, unsaved changes included. */
  readonly definition: WorkflowDefinition;
  /** The last revision the server confirmed. */
  readonly revision: number;
  readonly saveState: SaveState;
  /** Changes not yet confirmed by the server. */
  readonly unsaved: boolean;
  /** Why the last save failed, while `saveState` is `failed`. */
  readonly error: string | null;
  /** `save`: our save was refused as stale. `theirs`: a newer revision arrived while we had changes. */
  readonly conflict: 'save' | 'theirs' | null;
  readonly readOnly: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  /** Applies ops as one edit (one Undo step, or part of the last one when `group` matches). */
  apply(ops: readonly WorkflowOp[], label: string, options?: ApplyOptions): ApplyOutcome;
  undo(): void;
  redo(): void;
  /** Drops this tab's unsaved changes and loads the newest saved draft. */
  loadTheirs(): Promise<void>;
  /** Saves now and resolves once everything is saved (false when a conflict or a refusal stops it). */
  flush(): Promise<boolean>;
  /** Tries a failed or waiting save again now. */
  retryNow(): void;
  /** Takes a draft the server saved (after a restore), clearing Undo and Redo. */
  reset(definition: WorkflowDefinition, revision: number): void;
}

interface Entry {
  readonly label: string;
  /** Applying these redoes the edit. */
  readonly ops: readonly WorkflowOp[];
  /** Applying these undoes it. */
  readonly inverse: readonly WorkflowOp[];
  readonly group: string | null;
  readonly at: number;
}

interface Snapshot {
  readonly definition: WorkflowDefinition;
  readonly revision: number;
  readonly saveState: SaveState;
  readonly unsaved: boolean;
  readonly error: string | null;
  readonly conflict: 'save' | 'theirs' | null;
  readonly readOnly: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

export const SAVE_DEBOUNCE_MS = 600;
const GROUP_MS = 1200;
const MAX_HISTORY = 100;
/** The API takes at most 500 ops per save. */
const MAX_OPS_PER_SAVE = 500;
const MAX_BACKOFF_MS = 30_000;

/** Network trouble and server hiccups are worth retrying; a refusal (4xx) isn't. */
function isTransient(e: unknown): boolean {
  if (e instanceof ApiError) return e.status >= 500 || e.status === 408 || e.status === 429;
  return true;
}

function refusal(e: unknown): string {
  if (e instanceof WorkflowOpError) return e.issues[0]?.message ?? e.message;
  return errorMessage(e, 'That change isn’t allowed.');
}

interface StoreOptions {
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly definition: WorkflowDefinition;
  readonly readOnly: boolean;
}

class DraftStore {
  private definition: WorkflowDefinition;
  /** The draft at `revision`, as the server has it. */
  private confirmed: WorkflowDefinition;
  private revision: number;
  private pending: WorkflowOp[] = [];
  private inflight: WorkflowOp[] | null = null;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private state: SaveState = 'saved';
  private error: string | null = null;
  private conflict: 'save' | 'theirs' | null = null;
  private readOnly: boolean;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The newest revision the page has seen from the server, judged once no save is on its way. */
  private server: { revision: number; raw: unknown } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot;

  constructor(private readonly opts: StoreOptions) {
    this.definition = opts.definition;
    this.confirmed = opts.definition;
    this.revision = opts.revision;
    this.readOnly = opts.readOnly;
    this.snapshot = this.snap();
  }

  // ---- The external-store plumbing ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private snap(): Snapshot {
    const top = this.undoStack.at(-1);
    const next = this.redoStack.at(-1);
    return {
      definition: this.definition,
      revision: this.revision,
      saveState: this.state,
      unsaved: this.pending.length > 0 || this.inflight !== null,
      error: this.error,
      conflict: this.conflict,
      readOnly: this.readOnly,
      canUndo: !this.readOnly && !!top,
      canRedo: !this.readOnly && !!next,
      undoLabel: top?.label ?? null,
      redoLabel: next?.label ?? null,
    };
  }

  private emit(): void {
    this.snapshot = this.snap();
    for (const l of this.listeners) l();
  }

  get hasUnsaved(): boolean {
    return this.pending.length > 0 || this.inflight !== null;
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    this.emit();
  }

  // ---- Editing ----

  apply = (ops: readonly WorkflowOp[], label: string, options: ApplyOptions = {}): ApplyOutcome => {
    if (this.readOnly) {
      const message = 'Only owners and admins can change workflows.';
      if (!options.quiet) toast.error(message);
      return { ok: false, message, error: null };
    }
    let result: ReturnType<typeof applyWorkflowOps>;
    try {
      result = applyWorkflowOps(this.definition, ops);
    } catch (e) {
      const message = refusal(e);
      if (!options.quiet) toast.error(message);
      return { ok: false, message, error: e };
    }
    // A change to the same value (picking what's already picked) isn't an edit.
    if (sameJson(result.definition, this.definition))
      return { ok: true, definition: this.definition };
    const now = Date.now();
    const top = this.undoStack.at(-1);
    const group = options.group ?? null;
    if (group && top && top.group === group && now - top.at < GROUP_MS) {
      this.undoStack[this.undoStack.length - 1] = {
        label: top.label,
        ops: appendOps(top.ops, ops),
        inverse: [...result.inverse, ...top.inverse],
        group,
        at: now,
      };
    } else {
      this.undoStack.push({ label, ops: [...ops], inverse: result.inverse, group, at: now });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.redoStack = [];
    this.commit(result.definition, ops);
    return { ok: true, definition: result.definition };
  };

  undo = (): void => {
    const entry = this.undoStack.at(-1);
    if (!entry || this.readOnly) return;
    try {
      const result = applyWorkflowOps(this.definition, entry.inverse);
      this.undoStack.pop();
      this.redoStack.push({ ...entry, ops: result.inverse, group: null, at: Date.now() });
      this.commit(result.definition, entry.inverse);
    } catch (e) {
      this.undoStack = [];
      toast.error(`Couldn’t undo: ${refusal(e)}`);
      this.emit();
    }
  };

  redo = (): void => {
    const entry = this.redoStack.at(-1);
    if (!entry || this.readOnly) return;
    try {
      const result = applyWorkflowOps(this.definition, entry.ops);
      this.redoStack.pop();
      this.undoStack.push({
        label: entry.label,
        ops: entry.ops,
        inverse: result.inverse,
        group: null,
        at: Date.now(),
      });
      this.commit(result.definition, entry.ops);
    } catch (e) {
      this.redoStack = [];
      toast.error(`Couldn’t redo: ${refusal(e)}`);
      this.emit();
    }
  };

  private commit(definition: WorkflowDefinition, ops: readonly WorkflowOp[]): void {
    this.definition = definition;
    this.pending = appendOps(this.pending, ops);
    if (this.state === 'saved') this.state = 'saving';
    this.schedule(SAVE_DEBOUNCE_MS);
    this.emit();
  }

  // ---- Saving ----

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inflight || this.conflict || this.state === 'failed') return;
    if (this.state === 'retrying' && delay === SAVE_DEBOUNCE_MS) return; // the retry timer owns the next try
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    if (this.inflight || this.conflict || !this.pending.length) return;
    const batch = this.pending.slice(0, MAX_OPS_PER_SAVE);
    this.pending = this.pending.slice(batch.length);
    this.inflight = batch;
    if (this.state !== 'retrying') this.state = 'saving';
    this.emit();
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow.save_draft', {
          body: {
            workspaceId: this.opts.workspaceId,
            workflowId: this.opts.workflowId,
            baseRevision: this.revision,
            ops: batch as unknown as WorkflowSaveDraftBody['ops'],
          },
        }),
      );
      try {
        this.confirmed = applyWorkflowOps(this.confirmed, batch).definition;
      } catch {
        // The server took them, so they apply; if this copy disagrees, the next reload sets it straight.
      }
      this.revision = out.revision;
      this.inflight = null;
      this.attempts = 0;
      this.error = null;
      this.state = this.pending.length ? 'saving' : 'saved';
      this.emit();
      if (this.pending.length) this.schedule(0);
      else this.judgeServer();
    } catch (e) {
      this.inflight = null;
      // Nothing is dropped: the batch goes back in front of anything made meanwhile.
      this.pending = appendOps(batch, this.pending);
      if (e instanceof ApiError && e.rule === 'revision_conflict') {
        this.conflict = 'save';
        this.state = 'conflict';
      } else if (isTransient(e)) {
        this.attempts += 1;
        this.state = 'retrying';
        const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempts - 1));
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.run();
        }, delay);
      } else {
        this.state = 'failed';
        this.error = errorMessage(e, 'The server refused this change.');
      }
      this.emit();
    }
  }

  retryNow = (): void => {
    if (this.conflict || !this.pending.length || this.inflight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = 'saving';
    this.error = null;
    this.attempts = 0;
    void this.run();
  };

  flush = (): Promise<boolean> => {
    const settled = () =>
      !this.pending.length &&
      !this.inflight &&
      this.state !== 'conflict' &&
      this.state !== 'failed';
    if (settled()) return Promise.resolve(true);
    if (this.conflict || this.state === 'failed') return Promise.resolve(false);
    if (this.timer && this.state !== 'retrying') {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.inflight && this.state !== 'retrying') void this.run();
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (this.conflict || this.state === 'failed') {
          unsubscribe();
          resolve(false);
        } else if (settled()) {
          unsubscribe();
          resolve(true);
        }
      });
    });
  };

  /** Leaving the page: send what's queued now rather than after the pause. */
  flushSoon(): void {
    if (this.pending.length && !this.inflight && !this.conflict && this.state === 'saving') {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      void this.run();
    }
  }

  // ---- Other people's saves ----

  /** The page's server data changed (a live refresh). A newer revision replaces a clean draft quietly. */
  receive(revision: number, raw: unknown): void {
    if (!this.server || revision > this.server.revision) this.server = { revision, raw };
    this.judgeServer();
  }

  private judgeServer(): void {
    const server = this.server;
    if (!server || server.revision <= this.revision || this.inflight) return;
    let definition: WorkflowDefinition;
    try {
      definition = parseDefinition(server.raw);
    } catch {
      return;
    }
    if (this.pending.length) {
      if (!this.conflict) {
        this.conflict = 'theirs';
        this.state = 'conflict';
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.emit();
      }
      return;
    }
    this.adopt(definition, server.revision);
  }

  private adopt(definition: WorkflowDefinition, revision: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.definition = definition;
    this.confirmed = definition;
    this.revision = revision;
    this.pending = [];
    this.undoStack = [];
    this.redoStack = [];
    this.conflict = null;
    this.error = null;
    this.attempts = 0;
    this.state = 'saved';
    this.emit();
  }

  loadTheirs = async (): Promise<void> => {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/workflow.get', {
          body: { workspaceId: this.opts.workspaceId, workflowId: this.opts.workflowId },
        }),
      );
      if (this.inflight) return;
      this.server = { revision: out.workflow.revision, raw: out.workflow.definition };
      this.adopt(parseDefinition(out.workflow.definition), out.workflow.revision);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  reset = (definition: WorkflowDefinition, revision: number): void => {
    if (!this.server || revision >= this.server.revision)
      this.server = { revision, raw: definition };
    this.adopt(definition, revision);
  };
}

/**
 * The shared draft for one workflow. Pass what the page loaded; later server data (a live refresh after
 * someone else's save) is handed over the same way and replaces the draft when this tab has no changes, or
 * raises the conflict banner when it has.
 */
export function useWorkflowDraft(opts: {
  workspaceId: string;
  workflowId: string;
  /** The draft's revision as loaded. */
  revision: number;
  /** The draft as loaded (the API's JSON; parsed here). */
  definition: unknown;
  /** Members read workflows; only owners and admins change them. */
  readOnly?: boolean;
}): WorkflowDraft {
  const { workspaceId, workflowId, revision, definition, readOnly = false } = opts;
  const [store] = useState(
    () =>
      new DraftStore({
        workspaceId,
        workflowId,
        revision,
        definition: parseDefinition(definition),
        readOnly,
      }),
  );
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => store.receive(revision, definition), [store, revision, definition]);
  useEffect(() => store.setReadOnly(readOnly), [store, readOnly]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!store.hasUnsaved) return;
      e.preventDefault();
      // Older browsers need a return value to show the "leave site?" prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      store.flushSoon();
    };
  }, [store]);

  return useMemo(
    () => ({
      ...snap,
      apply: store.apply,
      undo: store.undo,
      redo: store.redo,
      loadTheirs: store.loadTheirs,
      flush: store.flush,
      retryNow: store.retryNow,
      reset: store.reset,
    }),
    [snap, store],
  );
}
