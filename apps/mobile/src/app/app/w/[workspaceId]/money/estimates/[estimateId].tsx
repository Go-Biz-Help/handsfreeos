import {
  BALANCE_AFTER_ROW_LABEL,
  dayLabel,
  DEPOSIT_ROW_LABEL,
  estimateStanding,
  money,
  MONEY_LINK_WHAT_IT_DOES,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Share, View } from 'react-native';

import { Link2, Send } from '@/components/icons';
import { DocumentLines, totalsOf } from '@/components/money/document';
import { StateBadge } from '@/components/money/money-rows';
import { SendSheet } from '@/components/money/send-sheet';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { moneyLink, sendEstimate } from '@/money/actions';
import { useEstimate, useMoneyNow, useMoneyRole, useMoneyZone } from '@/money/use-money';

/**
 * **One estimate**: what was quoted, where it stands, its lines and totals, and the deposit it asks for up front —
 * read from the phone's copy.
 *
 * Quoting a new job is the web's in M10 (a document's lines and totals only make sense together, and a stale draft is
 * refused rather than merged), so this screen sends one and links out to change it.
 */
export default function Estimate() {
  const { estimateId } = useLocalSearchParams<{ estimateId: string }>();
  const { business } = useBusiness();
  // Sending it and copying its link are billing (money.bill, 0103).
  const { bill: manage } = useMoneyRole();
  const timeZone = useMoneyZone();
  const now = useMoneyNow();
  const { estimate, lines, loading } = useEstimate(estimateId);
  const { online } = useNetwork();
  const [sending, setSending] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!estimate)
    return (
      <Screen title="Estimate" leading="back" testID="estimate">
        <Card className="p-6">
          <Text className="text-center text-text-2">
            {loading ? 'Loading…' : 'This estimate isn’t on this phone.'}
          </Text>
        </Card>
      </Screen>
    );

  const totals = totalsOf(estimate);
  const deposit = estimate.deposit_cents ?? 0;

  /** The link first, then Send it — see the invoice's screen for why the share sheet doesn't open by itself. */
  const shareLink = async () => {
    setBusy(true);
    try {
      setLink(await moneyLink({ workspaceId: business.id, kind: 'estimate', id: estimateId }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
    }
    setBusy(false);
  };

  return (
    <Screen
      title={estimate.number ?? 'Estimate'}
      subtitle={estimate.person_name}
      leading="back"
      testID="estimate"
    >
      <Card className="px-3.5 py-3.5">
        <Text className="text-[12.5px] text-text-3">Quoted</Text>
        <Text className="mt-0.5 text-[28px] font-semibold leading-8" testID="estimate-amount">
          {money(estimate.total_cents ?? 0)}
        </Text>
        <View className="mt-2 flex-row flex-wrap items-center gap-2">
          <StateBadge state={estimate.state} kind="estimate" testID="estimate-state" />
          <Text className="text-[12.5px] text-text-3" testID="estimate-standing">
            {estimateStanding(
              {
                voidedAt: estimate.voided_at,
                acceptedAt: estimate.accepted_at,
                declinedAt: estimate.declined_at,
                sentAt: estimate.sent_at,
                firstViewedAt: estimate.first_viewed_at,
                createdAt: estimate.created_at,
                expiresOn: estimate.expires_on,
              },
              now,
              timeZone,
            )}
          </Text>
        </View>
      </Card>

      {manage ? (
        <View className="gap-2">
          <Button icon={Send} onPress={() => setSending(true)} testID="estimate-send-open">
            {estimate.sent_at ? 'Send it again' : 'Send'}
          </Button>
          {estimate.sent_at && !estimate.voided_at ? (
            <Button
              variant="secondary"
              icon={Link2}
              loading={busy}
              onPress={() => void shareLink()}
              testID="estimate-copy-link"
            >
              {online ? 'Send their link' : 'Send their link — needs signal'}
            </Button>
          ) : null}
        </View>
      ) : null}

      <DocumentLines lines={lines} totals={totals} taxed={(estimate.tax_rate_bp ?? 0) > 0} />

      {deposit > 0 ? (
        <Card className="px-3.5 py-3">
          <Row label={DEPOSIT_ROW_LABEL} value={money(deposit)} />
          <Row
            label={BALANCE_AFTER_ROW_LABEL}
            value={money(Math.max(0, (estimate.total_cents ?? 0) - deposit))}
          />
        </Card>
      ) : null}

      {estimate.notes ? (
        <Card className="px-3.5 py-3">
          <Text className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Notes
          </Text>
          <Text className="text-[13.5px] leading-[1.45]">{estimate.notes}</Text>
        </Card>
      ) : null}

      {estimate.created_at ? (
        <Text className="px-1 text-xs text-text-3">
          {`Written ${dayLabel(Date.parse(estimate.created_at), timeZone)}`}
        </Text>
      ) : null}

      {manage ? (
        <Button
          variant="ghost"
          onPress={() => void openWeb(`/app/w/${business.id}/money/estimates/${estimateId}`)}
          testID="estimate-open-web"
        >
          Open this estimate on the web
        </Button>
      ) : null}

      <SendSheet
        open={sending}
        onClose={() => setSending(false)}
        who={estimate.person_name}
        email={estimate.person_email}
        phone={estimate.person_phone}
        onSend={async (channels) => {
          await sendEstimate({ workspaceId: business.id, estimateId, channels });
          // Not "sent": sending reaches a customer, so it waits its turn like any change and HandsFreeOS may still
          // refuse it (a partly paid invoice can't be sent again). Changes on this phone says how it ended.
          toast.show(`Sending to ${estimate.person_name}.`);
          setSending(false);
        }}
      />

      <Sheet
        open={link !== null}
        onClose={() => setLink(null)}
        title="The customer’s link"
        description={MONEY_LINK_WHAT_IT_DOES.estimate}
        testID="estimate-link"
      >
        <Text
          className="rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] text-text-2"
          selectable
          testID="estimate-link-url"
        >
          {link ?? ''}
        </Text>
        <Button
          className="mt-3"
          onPress={() => void Share.share({ message: link ?? '', url: link ?? '' })}
          testID="estimate-link-share"
        >
          Send it
        </Button>
        <Button variant="ghost" className="mt-2" onPress={() => setLink(null)}>
          Done
        </Button>
      </Sheet>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-4 py-1.5">
      <Text className="text-[13.5px] text-text-2">{label}</Text>
      <Text className="text-[13.5px] font-medium">{value}</Text>
    </View>
  );
}
