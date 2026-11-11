import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { ClipboardList } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';

import { openCo } from './kit';

/**
 * Contractor Operations' row on a visit's page in Calendar: a visit on a job opens its work order, where the
 * checklist, the materials and the notes are. Nothing for a visit that isn't on a job, or whose work order this
 * phone doesn't hold.
 */

/** The job a visit's work order is on (the work order's row in the phone's copy is named for the visit). */
export const CO_VISIT_PANEL_SQL = `
  SELECT w.record_id AS job_id, r.name AS job_name
  FROM addon_phone_rows w JOIN custom_records r ON r.id = w.record_id
  WHERE w.id = ? AND w.workspace_id = ? AND r.archived_at IS NULL`;

export function ContractorVisitPanel({
  workspaceId,
  appointmentId,
}: {
  workspaceId: string;
  appointmentId: string;
}) {
  const job = useQuery<{ job_id: string; job_name: string }>(CO_VISIT_PANEL_SQL, [
    `work_orders:${appointmentId}`,
    workspaceId,
  ]).data[0];
  if (!job) return null;
  return (
    <ContractorVisitPanelRow
      jobName={job.job_name}
      onOpen={() => openCo(workspaceId, `visits/${appointmentId}`)}
    />
  );
}

export function ContractorVisitPanelRow({
  jobName,
  onOpen,
}: {
  jobName: string;
  onOpen: () => void;
}) {
  return (
    <List testID="co-visit-panel">
      <ListRow
        icon={ClipboardList}
        label={P.visit.panel}
        detail={P.visit.panelDetail(jobName)}
        onPress={onOpen}
        testID="co-visit-panel-open"
      />
    </List>
  );
}
