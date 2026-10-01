import { mayViewAs, ROLE_LABELS, type WorkspaceRole } from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useWorkspaceRow } from '@/home/use-home';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { startView } from '@/view-as/actions';
import { VIEW_AS_PHONE_WORDS as WORDS } from '@/view-as/words';

interface Teammate {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly permissions: readonly string[];
}

/**
 * More → View as a teammate (20261016000200): the people below this person who can do nothing they can't, from
 * HandsFreeOS (the phone's copy doesn't hold what each person may do). Picking one opens the business as they see it,
 * read-only, until Stop viewing.
 */
export default function ViewAsTeammate() {
  const { me, business, userId, viewing } = useBusiness();
  const grants = useGrants();
  const { online } = useNetwork();
  // Whether the business shows each person only their own threads, as the copy has it.
  const { settings } = useWorkspaceRow();
  const inboxPerPerson = React.useMemo(() => {
    try {
      const parsed = settings
        ? (JSON.parse(settings) as { inbox?: { perPerson?: unknown } })
        : null;
      return parsed?.inbox?.perPerson === true;
    } catch {
      return false;
    }
  }, [settings]);
  const [team, setTeam] = React.useState<readonly Teammate[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!online || viewing) return;
    let cancelled = false;
    setError(null);
    api
      .POST('/v1/queries/workspace.members', { body: { workspaceId: business.id } })
      .then((r) => {
        if (!cancelled) setTeam(unwrap(r).members);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [online, viewing, business.id]);

  const below = (team ?? []).filter(
    (m) => m.userId !== me.user.id && mayViewAs(grants, m, { inboxPerPerson }),
  );

  const open = async (m: Teammate) => {
    setOpening(m.userId);
    try {
      await startView(userId, business.id, m.userId);
      router.replace(businessHref(business.id));
    } catch (e) {
      toast.error(errorMessage(e));
      setOpening(null);
    }
  };

  const back = businessHref(business.id, 'more');
  return (
    <Screen title={WORDS.pickTitle} leading="back" back={back} testID="view-as-teammate">
      <Text className="px-1 text-[13.5px] text-text-2">{WORDS.pickDetail}</Text>
      {viewing ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px]">
            {WORDS.stopFirst(viewing.person.fullName || viewing.person.email)}
          </Text>
        </Card>
      ) : !online && !team ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px]">{WORDS.pickNeedsSignal}</Text>
        </Card>
      ) : error ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px] text-danger-text">{error}</Text>
        </Card>
      ) : !team ? (
        <Text className="px-1 text-[13.5px] text-text-3">{WORDS.loading}</Text>
      ) : below.length === 0 ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px]" testID="view-as-nobody">
            {WORDS.pickNobody}
          </Text>
        </Card>
      ) : (
        <List>
          {below.map((m) => (
            <View
              key={m.userId}
              className="flex-row items-center gap-3 px-3.5 py-2.5"
              testID={`view-as-row-${m.email}`}
            >
              <Avatar name={m.fullName || m.email} seed={m.userId} />
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-medium" numberOfLines={1}>
                  {m.fullName || m.email}
                </Text>
                <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
                  {ROLE_LABELS[m.role]}
                </Text>
              </View>
              <Button
                variant="secondary"
                size="sm"
                disabled={opening !== null || !online}
                onPress={() => void open(m)}
                testID={`view-as-${m.email}`}
              >
                {opening === m.userId ? WORDS.starting : WORDS.startShort}
              </Button>
            </View>
          ))}
        </List>
      )}
    </Screen>
  );
}
