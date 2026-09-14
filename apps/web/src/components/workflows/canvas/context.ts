'use client';
import type { InsertionPoint, WorkflowDefinition } from '@hfos/core';
import { createContext, useContext } from 'react';
import type { NewStepKind } from '@/lib/workflows/steps';

/** What the canvas's nodes and edges share: the draft, and the edits they can start. */
export interface CanvasContextValue {
  readonly def: WorkflowDefinition;
  /** Owners and admins on a computer. False on a phone and for anyone who only reads the workflow. */
  readonly editable: boolean;
  /** A "+" on an edge: adds a new step of this kind there. */
  readonly insert: (at: InsertionPoint, kind: NewStepKind, label: string) => void;
  /** Opens "Move to…" for a step. */
  readonly moveTo: (stepId: string) => void;
  /** Removes a step, asking first when it has steps inside it. */
  readonly remove: (stepId: string) => void;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);
export const CanvasProvider = CanvasContext.Provider;

export function useCanvas(): CanvasContextValue {
  const value = useContext(CanvasContext);
  if (!value) throw new Error('useCanvas needs a CanvasProvider.');
  return value;
}
