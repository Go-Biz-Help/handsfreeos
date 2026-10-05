import { SAFETY_PHONE_WORDS } from '@hfos/core';
import * as React from 'react';

import { MySafety } from '@/components/safety/my-safety';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { useMembers } from '@/customers/names';
import { useMyContacts } from '@/safety/use-check-in-context';

/** Settings → My safety (board 91): who's told if the person doesn't check out, and when. */
export default function MySafetyScreen() {
  const { business, userId } = useBusiness();
  const contacts = useMyContacts(business.id, userId);
  const members = useMembers();
  const teammates = React.useMemo(
    () =>
      members.filter((m) => m.id !== userId).map((m) => ({ id: m.id, name: m.fullName || '—' })),
    [members, userId],
  );
  return (
    <Screen
      title={SAFETY_PHONE_WORDS.mySafety}
      subtitle="Settings"
      back={businessHref(business.id, 'settings')}
      testID="my-safety"
    >
      <MySafety workspaceId={business.id} contacts={contacts} teammates={teammates} />
    </Screen>
  );
}
