'use client';
import type {
  TemplateValues,
  WorkflowCatalogs,
  WorkflowDefinition,
  WorkflowNames,
} from '@hfos/core';
import { createContext, useContext } from 'react';
import type { WorkflowDraft } from '@/lib/workflows/use-draft';
import type { SampleContact } from '@/lib/workflows/sample';

/** The rail's selection: a step id, the trigger, or the workflow's settings. */
export type Selection = string;
export const TRIGGER_ID = 'trigger';
export const SETTINGS_ID = 'settings';

export interface QuietHours {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
}

/** What the step panels share: the draft, what it can name, the sample customer and the workspace's rules. */
export interface EditorContextValue {
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly businessName: string;
  readonly def: WorkflowDefinition;
  readonly catalogs: WorkflowCatalogs;
  readonly names: WorkflowNames;
  readonly apply: WorkflowDraft['apply'];
  readonly readOnly: boolean;
  /** The customer previews are filled in for. */
  readonly sample: SampleContact | null;
  readonly setSample: (person: SampleContact | null) => void;
  readonly values: TemplateValues;
  readonly quietHours: QuietHours | null;
  readonly timeZone: string;
  readonly select: (id: Selection | null) => void;
  readonly openMove: (stepId: string) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);
export const EditorProvider = EditorContext.Provider;

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor needs an EditorProvider.');
  return value;
}
