'use client';
import {
  applyTeammatePatch,
  diffTeammateConfigs,
  hasBlockingTeammateIssues,
  inferTeammateLabels,
  parseTeammateConfig,
  validateTeammate,
  type TeammateCatalogs,
  type TeammateConfig,
  type TeammateIssue,
  type TeammateLabels,
  type TeammatePatch,
  type TeammatePatchFix,
} from '@hfos/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api/client';

/**
 * The AI teammate's settings as the builder edits them: one local TeammateConfig, checked with core's
 * validateTeammate and labelled with inferTeammateLabels on every change (the rules the server saves with),
 * with Undo and Fix. Changes save on their own a moment after the last edit, so typing in a field is one
 * save, not one per letter. Each save sends the whole document against the revision it started from; when
 * someone saved in between, the server refuses it and "Load their version" takes theirs.
 */

export interface TeammateDraftAdapter {
  /** Saves `config` over `baseRevision`; a stale base rejects with the API's `revision_conflict`. */
  save(
    baseRevision: number,
    config: TeammateConfig,
  ): Promise<{ revision: number; changes: readonly string[] }>;
  /** The newest saved settings, for "Load their version". */
  load(): Promise<{ revision: number; config: unknown }>;
}

/** What the auto-save indicator says: Saved, Saving…, Couldn't save, or Not saved (someone saved first). */
export type SaveState = 'saved' | 'saving' | 'failed' | 'conflict';

/** Where the draft stood once its saves settled. */
export interface Settled {
  /** Nothing is waiting to be saved. */
  readonly clean: boolean;
  /** The revision the settings are now. */
  readonly revision: number;
}

export interface PatchOptions {
  /** Edits with the same key a moment apart are one Undo step, so typing in a field isn't 40 undos. */
  readonly group?: string;
  /** Don't toast a refusal: the caller shows it beside the field. */
  readonly quiet?: boolean;
}

/** Applies a settings patch as one edit. Returns why it was refused, or null. */
export type PatchFn = (
  patch: TeammatePatch,
  label: string,
  options?: PatchOptions,
) => string | null;

export interface TeammateDraft {
  /** The settings as they are in this tab, unsaved changes included. */
  readonly config: TeammateConfig;
  /** As last saved. */
  readonly base: TeammateConfig;
  /** The revision `base` is. */
  readonly revision: number;
  readonly dirty: boolean;
  readonly issues: readonly TeammateIssue[];
  readonly labels: TeammateLabels;
  /** Errors: they block turning the teammate on, never saving. */
  readonly blocking: boolean;
  /** What saving would change, one line each. */
  readonly changes: readonly string[];
  /** Someone saved a newer revision while this tab has changes, or our save was refused for it. */
  readonly stale: boolean;
  readonly saving: boolean;
  /** For the auto-save indicator. */
  readonly saveState: SaveState;
  readonly readOnly: boolean;
  readonly canUndo: boolean;
  readonly undoLabel: string | null;
  /** The Fix just applied, until the next edit. */
  readonly lastFix: string | null;
  readonly patch: PatchFn;
  applyFix(fix: TeammatePatchFix): void;
  undo(): void;
  /** Saves now instead of waiting (Try again after a failed save). Resolves true once saved. */
  save(): Promise<boolean>;
  /** Saves anything waiting and resolves once it's done, before leaving the page or changing the status. */
  flush(): Promise<Settled>;
  /** Drops this tab's changes and takes the newest saved settings. */
  loadTheirs(): Promise<void>;
  /** Drops this tab's changes (before a restore). */
  discard(): void;
}

interface UndoEntry {
  readonly label: string;
  readonly before: TeammateConfig;
  readonly group: string | null;
  readonly at: number;
}

interface Edit {
  readonly rev: number;
  readonly base: TeammateConfig;
  readonly draft: TeammateConfig;
  readonly undo: readonly UndoEntry[];
  readonly fixed: string | null;
  /** Our save was refused because someone saved first. */
  readonly refused: boolean;
}

const GROUP_MS = 1200;
const MAX_UNDO = 100;
/** How long after the last edit it saves. */
const AUTOSAVE_MS = 800;

/** JSON with object keys sorted, so equal settings compare equal whatever order they were built in. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

const refusalOf = (e: unknown): string =>
  (e as { issues?: { message?: string }[] }).issues?.[0]?.message ?? 'That value isn’t allowed.';

const dirtyOf = (e: Edit) => stableJson(e.draft) !== stableJson(e.base);

export function useTeammateDraft(opts: {
  /** The revision as loaded. */
  revision: number;
  /** The settings as loaded (the API's JSON; parsed here). */
  config: unknown;
  catalogs: TeammateCatalogs;
  /** Members read the teammate; owners and admins (ai_team.manage) change it. */
  readOnly: boolean;
  adapter: TeammateDraftAdapter;
  /** After each save (to fetch the new revision and history). */
  onSaved?: () => void;
}): TeammateDraft {
  const { revision, catalogs, readOnly, adapter } = opts;
  const saved = useMemo(() => parseTeammateConfig(opts.config), [opts.config]);
  const fresh: Edit = {
    rev: revision,
    base: saved,
    draft: saved,
    undo: [],
    fixed: null,
    refused: false,
  };
  const [edit, setEdit] = useState<Edit>(fresh);
  const [saving, setSaving] = useState(false);
  // The settings a save failed on: not retried until they change again, or Try again.
  const [failed, setFailed] = useState<TeammateConfig | null>(null);
  const [nudge, setNudge] = useState(0);
  const [now] = useState(() => Date.now());
  const inflight = useRef(false);
  const waiters = useRef<((settled: Settled) => void)[]>([]);
  const onSaved = useRef(opts.onSaved);

  // A newer revision (someone's save, or our own coming back) replaces a clean draft; with edits it raises
  // the "Load their version" banner instead.
  const newer = revision > edit.rev;
  const current = newer && !dirtyOf(edit) ? fresh : edit;
  const dirty = dirtyOf(current);
  const draft = current.draft;
  const base = current.base;

  const issues = useMemo(() => validateTeammate(draft, catalogs, now), [draft, catalogs, now]);
  const labels = useMemo(() => inferTeammateLabels(draft), [draft]);
  const changes = useMemo(
    () => (dirty ? diffTeammateConfigs(base, draft, catalogs) : []),
    [dirty, base, draft, catalogs],
  );

  function commit(
    p: TeammatePatch,
    label: string,
    options: PatchOptions,
    fixed: string | null,
  ): string | null {
    if (readOnly) {
      const message = 'Only owners and admins can change the AI teammate.';
      if (!options.quiet) toast.error(message);
      return message;
    }
    let next: TeammateConfig;
    try {
      next = applyTeammatePatch(draft, p);
    } catch (e) {
      const message = refusalOf(e);
      if (!options.quiet) toast.error(message);
      return message;
    }
    // Picking what's already picked isn't an edit.
    if (stableJson(next) === stableJson(draft)) return null;
    const at = Date.now();
    const top = current.undo.at(-1);
    const group = options.group ?? null;
    const undo =
      group && top && top.group === group && at - top.at < GROUP_MS
        ? [...current.undo.slice(0, -1), { ...top, at }]
        : [...current.undo, { label, before: draft, group, at }].slice(-MAX_UNDO);
    setEdit({ ...current, draft: next, undo, fixed });
    return null;
  }

  const patch: PatchFn = (p, label, options = {}) => commit(p, label, options, null);

  function undo() {
    const top = current.undo.at(-1);
    if (!top || readOnly) return;
    setEdit({ ...current, draft: top.before, undo: current.undo.slice(0, -1), fixed: null });
  }

  const stale = (newer && dirty) || current.refused;

  async function save(): Promise<boolean> {
    if (inflight.current || saving || !dirty || readOnly || stale) return false;
    inflight.current = true;
    setSaving(true);
    setFailed(null);
    const sent = draft;
    try {
      const out = await adapter.save(current.rev, sent);
      // Edits made while it saved stay as unsaved changes on top, and save next.
      setEdit((e) => ({ ...e, rev: out.revision, base: sent, refused: false }));
      onSaved.current?.();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'revision_conflict')
        setEdit((x) => ({ ...x, refused: true }));
      else {
        setFailed(sent);
        toast.error(errorMessage(e));
      }
      return false;
    } finally {
      inflight.current = false;
      setSaving(false);
    }
  }

  // Saves a moment after the last edit; right away when something is waiting on it (flush).
  const saveNow = useRef(save);
  useEffect(() => {
    saveNow.current = save;
    onSaved.current = opts.onSaved;
  });
  const failedHere = failed !== null && stableJson(failed) === stableJson(draft);
  useEffect(() => {
    if (readOnly || !dirty || saving || stale || failedHere) return;
    const t = setTimeout(() => void saveNow.current(), waiters.current.length ? 0 : AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [draft, dirty, saving, stale, failedHere, readOnly, nudge]);

  // Anyone waiting on flush hears once there's nothing left it can save.
  useEffect(() => {
    if (!waiters.current.length || saving) return;
    if (dirty && !readOnly && !stale && !failedHere) return;
    const settled: Settled = { clean: !dirty, revision: current.rev };
    for (const done of waiters.current.splice(0)) done(settled);
  });

  function flush(): Promise<Settled> {
    return new Promise((done) => {
      waiters.current.push(done);
      setNudge((n) => n + 1);
    });
  }

  // Leaving the page with an edit still waiting saves it on the way out.
  useEffect(
    () => () => {
      void saveNow.current();
    },
    [],
  );

  async function loadTheirs() {
    try {
      const out = await adapter.load();
      const config = parseTeammateConfig(out.config);
      setEdit({
        rev: out.revision,
        base: config,
        draft: config,
        undo: [],
        fixed: null,
        refused: false,
      });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  function discard() {
    setEdit({ ...current, draft: current.base, undo: [], fixed: null });
  }

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need a return value to show the "leave site?" prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const top = current.undo.at(-1);
  return {
    config: draft,
    base,
    revision: current.rev,
    dirty,
    issues,
    labels,
    blocking: hasBlockingTeammateIssues(issues),
    changes,
    stale,
    saving,
    saveState: stale
      ? 'conflict'
      : saving || (dirty && !failedHere)
        ? 'saving'
        : dirty
          ? 'failed'
          : 'saved',
    readOnly,
    canUndo: !readOnly && !!top,
    undoLabel: top?.label ?? null,
    lastFix: current.fixed,
    patch,
    applyFix: (fix) => void commit(fix.patch, fix.label, {}, fix.label),
    undo,
    save,
    flush,
    loadTheirs,
    discard,
  };
}
