'use client';
import type { SlotProps } from '../registry';
import { DealsPanel, personDefaults } from './deals-panel';

/** A customer's deals, on their page. */
export default function PersonPanel({ workspaceId, personId }: SlotProps<'person.panels'>) {
  return (
    <DealsPanel
      workspaceId={workspaceId}
      of={{ personId }}
      defaults={() => personDefaults(workspaceId, personId)}
    />
  );
}
