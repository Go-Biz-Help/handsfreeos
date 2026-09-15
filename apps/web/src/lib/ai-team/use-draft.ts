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
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api/client';

/**
 * The AI teammate's settings as the builder edits them: one local TeammateConfig, checked with core's
 * validateTeammate and labelled with inferTeammateLabels on every change (the rules the server saves with),
 * with Undo, Fix and Save. Save sends the whole document against the revision it started from; when someone
 * saved in between, the server refuses it and "Load their version" takes theirs. Nothing is saved before
 * Save, because saved settings reach customers: half-typed text never goes live.
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
  readonly readOnly: boolean;
  readonly canUndo: boolean;
  readonly undoLabel: string | null;
  /** The Fix just applied, until the next edit. */
  readonly lastFix: string | null;
  readonly patch: PatchFn;
  applyFix(fix: TeammatePatchFix): void;
  undo(): void;
  /** Resolves true once saved. */
  save(): Promise<boolean>;
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
  const [now] = useState(() => Date.now());

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

  async function save(): Promise<boolean> {
    if (saving || !dirty || readOnly) return false;
    setSaving(true);
    const sent = draft;
    try {
      const out = await adapter.save(current.rev, sent);
      // Edits made while it saved stay as unsaved changes on top.
      setEdit((e) => ({ ...e, rev: out.revision, base: sent, fixed: null, refused: false }));
      toast.success(
        out.changes.length
          ? `Saved as revision ${out.revision}.`
          : 'Nothing changed, so nothing new was saved.',
      );
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'revision_conflict')
        setEdit((x) => ({ ...x, refused: true }));
      else toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

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
    stale: (newer && dirty) || current.refused,
    saving,
    readOnly,
    canUndo: !readOnly && !!top,
    undoLabel: top?.label ?? null,
    lastFix: current.fixed,
    patch,
    applyFix: (fix) => void commit(fix.patch, fix.label, {}, fix.label),
    undo,
    save,
    loadTheirs,
    discard,
  };
}
