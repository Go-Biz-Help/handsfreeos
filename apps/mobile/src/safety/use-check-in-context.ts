import { contactStatus, SAFETY_CONTACT_WORDS, type SafetyContactStatus } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { toldOf, type ContactRow } from './check-in';
import { MY_SAFETY_CONTACTS_SQL } from './use-check-in';

/** Who's on the business's team here, for whether a teammate contact still counts. */
export const TEAM_SQL = 'SELECT user_id FROM workspace_memberships WHERE workspace_id = ?';

export interface MyContact {
  readonly id: string;
  readonly name: string;
  readonly teammateUserId: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: SafetyContactStatus;
  /** "Text and email · agreed", "Teammate · an alert only they see". */
  readonly line: string;
  /** Told if the person doesn't check out: a teammate still here, or someone outside who agreed. */
  readonly told: boolean;
}

interface Row extends ContactRow {
  readonly id: string;
  readonly phone_e164: string | null;
  readonly email: string | null;
}

/** The person's own safety contacts in a business, from the phone's copy, in their order. */
export function useMyContacts(workspaceId: string, userId: string): readonly MyContact[] {
  const { data: rows } = useQuery<Row>(MY_SAFETY_CONTACTS_SQL, [workspaceId, userId]);
  const { data: team } = useQuery<{ user_id: string }>(TEAM_SQL, [workspaceId]);
  return React.useMemo(() => contactsOf(rows, new Set(team.map((t) => t.user_id))), [rows, team]);
}

export function contactsOf(rows: readonly Row[], team: ReadonlySet<string>): MyContact[] {
  return rows.map((r) => {
    const status = contactStatus({
      teammate: r.contact_user_id !== null,
      agreed: r.agreed_at !== null,
      stopped: r.stopped_at !== null,
    });
    return {
      id: r.id,
      name: r.name,
      teammateUserId: r.contact_user_id,
      phone: r.phone_e164,
      email: r.email,
      status,
      line: SAFETY_CONTACT_WORDS[status],
      told: toldOf([r], team).length > 0,
    };
  });
}
