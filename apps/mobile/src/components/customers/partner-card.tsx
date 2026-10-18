import { formatDate, money, PARTNERS_WORDS as W } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { businessHref } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import {
  partnerCalls,
  usePartnersHere,
  type PartnerOfPersonOut,
  type PartnerRow,
} from '@/partners/calls';

/**
 * The Partner card on a customer's page (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d), the web's card in
 * core's words: whether they're one of the business's partners (Make them a partner when they aren't), and which
 * partner sent them, changed from a sheet of the partners. Only for whoever holds Manage partners while partners are
 * on; none of it is in the phone's copy, so it's asked for while there's signal and stays out of the way without.
 */
export function PartnerCard({
  workspaceId,
  personId,
  name,
  archived,
}: {
  workspaceId: string;
  personId: string;
  name: string;
  archived: boolean;
}) {
  const here = usePartnersHere();
  const { online } = useNetwork();
  const [got, setGot] = React.useState<PartnerOfPersonOut | null>(null);
  const [round, setRound] = React.useState(0);
  const [picking, setPicking] = React.useState(false);
  const [partners, setPartners] = React.useState<readonly PartnerRow[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const calls = React.useMemo(() => partnerCalls(workspaceId), [workspaceId]);

  React.useEffect(() => {
    if (!here || !online) return;
    let cancelled = false;
    calls
      .ofPerson(personId)
      .then((r) => {
        if (!cancelled) setGot(r);
      })
      .catch(() => {
        // A side card: what can't load stays out of the way.
      });
    return () => {
      cancelled = true;
    };
  }, [here, online, calls, personId, round]);

  React.useEffect(() => {
    if (!picking || partners) return;
    let cancelled = false;
    calls
      .list()
      .then((list) => {
        if (!cancelled) setPartners(list);
      })
      .catch((e) => {
        if (!cancelled) toast.error(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [picking, partners, calls]);

  if (!here || !got?.inUse) return null;

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await run();
      toast.show(done);
      setPicking(false);
      setRound((r) => r + 1);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const sentBy = got.referredBy;
  // Anyone but them, and nobody whose partnership has ended, unless they're the one who sent them.
  const choices = (partners ?? []).filter(
    (p) => p.personId !== personId && (p.status !== 'ended' || p.partnerId === sentBy?.partnerId),
  );
  const pick = (partnerId: string | null) =>
    void act(() => calls.referralSet(personId, partnerId), W.card.saved);
  return (
    <Card className="gap-2 p-4" testID="partner-card">
      <Text className="text-[15px] font-semibold">{W.card.title}</Text>
      {got.partner ? (
        <View className="gap-1" testID="partner-card-is">
          <Text className="text-[13px] text-text-2">{W.card.isPartner(got.partner.status)}</Text>
          <Pressable
            role="link"
            onPress={() =>
              router.push(
                businessHref(workspaceId, `settings/partners/${got.partner!.partnerId}`) as Href,
              )
            }
            testID="partner-card-open"
          >
            <Text className="text-[13px] font-medium text-accent-text">{W.card.open}</Text>
          </Pressable>
        </View>
      ) : (
        <View className="gap-2">
          <Text className="text-[13px] leading-[18px] text-text-2">{W.card.makeHint}</Text>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={archived}
            loading={busy && !picking}
            onPress={() => void act(() => calls.add(personId), W.card.made(name))}
            testID="partner-card-make"
          >
            {W.card.make}
          </Button>
        </View>
      )}
      <View className="gap-0.5 border-t border-border pt-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-[13px] text-text-3">{W.card.sentBy}</Text>
          {archived ? null : (
            <Pressable onPress={() => setPicking(true)} testID="partner-card-change">
              <Text className="text-[13px] text-accent-text">{W.card.change}</Text>
            </Pressable>
          )}
        </View>
        {sentBy ? (
          <View testID="partner-card-sent-by">
            <Text className="text-[14px] font-medium">{sentBy.name}</Text>
            <Text className="text-[12.5px] text-text-2">
              {`${W.card.how[sentBy.how]} · ${formatDate(sentBy.referredAt)}`}
            </Text>
            {sentBy.earnedCents ? (
              <Text className="text-[12.5px] text-text-2">
                {W.card.earnedThem(money(sentBy.earnedCents))}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text className="text-[14px] text-text-2" testID="partner-card-sent-by">
            {W.card.nobody}
          </Text>
        )}
      </View>

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title={W.card.pick}
        scroll
        testID="partner-card-pick"
      >
        <View className="gap-2 pt-2">
          <List>
            <ListRow
              label={W.card.nobody}
              end={sentBy ? undefined : '✓'}
              chevron={false}
              disabled={busy}
              onPress={() => pick(null)}
              testID="partner-card-pick-nobody"
            />
            {choices.map((p) => (
              <ListRow
                key={p.partnerId}
                label={p.name}
                end={sentBy?.partnerId === p.partnerId ? '✓' : undefined}
                chevron={false}
                disabled={busy}
                onPress={() => pick(p.partnerId)}
                testID={`partner-card-pick-${p.partnerId}`}
              />
            ))}
          </List>
          {partners && !choices.length ? (
            <Text className="px-1 text-[12.5px] text-text-3">{W.card.noPartners}</Text>
          ) : null}
        </View>
      </Sheet>
    </Card>
  );
}
