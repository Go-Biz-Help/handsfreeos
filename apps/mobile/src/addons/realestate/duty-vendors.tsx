import { fmtMonthDay, fmtAt, localDayOf, parseMoney } from '@hfos/core';
import { RE_DUTY_VENDOR_WORDS as W } from '@hfos/core/addons/realestate/phone-words-listing';
import {
  dutyVendorsOfCopy,
  type DutyVendorsView,
} from '@hfos/core/addons/realestate/views/vendors';
import * as React from 'react';
import { View } from 'react-native';

import { List, ListLabel } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { pickDutyVendor } from './listing-actions';
import {
  ChangeButton,
  CheckRow,
  FieldError,
  FieldLabel,
  SignalNote,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * Picking a vendor on a duty (board 89, last panel), opened from a duty's sheet: every approved vendor that does what
 * the duty needs (those working where the home is first), each with any disclosure; the quote; and the appointment,
 * which is booked on the calendar. The client is given every vendor that fits, not only one. Drawn from the phone's
 * copy (`dutyVendorsOfCopy`); a deal kept as its summary asks HandsFreeOS with signal.
 *
 *   <DutyVendorPicker open={picking} onClose={() => setPicking(false)} dealId={deal.id} dutyId={duty.id} />
 */
export function DutyVendorPicker({
  open,
  onClose,
  dealId,
  dutyId,
  onPicked,
}: {
  open: boolean;
  onClose: () => void;
  /** The duty's deal: its copy is read for the vendors that fit and the home's address. */
  dealId: string;
  dutyId: string;
  /** Once a vendor is picked (the sheet closes itself). */
  onPicked?: (vendorId: string) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={W.title} testID="duty-vendor-picker">
      {/* The deal's copy is read only while the sheet is up. */}
      {open ? (
        <PickerContent dealId={dealId} dutyId={dutyId} onPicked={onPicked} onClose={onClose} />
      ) : null}
    </Sheet>
  );
}

function PickerContent({
  dealId,
  dutyId,
  onPicked,
  onClose,
}: {
  dealId: string;
  dutyId: string;
  onPicked?: (vendorId: string) => void;
  onClose: () => void;
}) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const view = React.useMemo(
    () => dutyVendorsOfCopy(copy, dutyId, { userId: ctx.userId }),
    [copy, dutyId, ctx.userId],
  );
  const duty = (copy.duties.get(dealId) ?? []).find((d) => d.id === dutyId) ?? null;
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.duty.vendors', {
          body: { workspaceId: ctx.workspaceId, dutyId },
        }),
      ),
    `duty-vendors:${dutyId}`,
    'vendors',
  );
  const pick = async (vendorId: string, quoteCents: number | null) => {
    const data = view ?? server.data;
    await pickDutyVendor({
      workspaceId: ctx.workspaceId,
      dealId,
      userId: ctx.userId,
      dutyId,
      vendorId,
      service: data?.service ?? null,
      quoteCents,
    });
    const name = data?.fits.find((f) => f.id === vendorId)?.name ?? '';
    toast.show(W.picked(name));
    onPicked?.(vendorId);
    onClose();
  };
  return (
    <View className="gap-3">
      {duty && deal ? (
        <Text className="text-[14.5px] text-text-2" testID="duty-vendor-on">
          {W.on(duty.title, deal.name)}
        </Text>
      ) : null}
      {!deal || (whole && !view) ? (
        <Text className="text-[14px] text-text-2">{W.notOnPhone}</Text>
      ) : whole && view ? (
        <DutyVendorsBody view={view} timeZone={ctx.timeZone} onPick={pick} />
      ) : (
        <SummaryAnswer answer={server} what="vendors">
          {(data) => <DutyVendorsBody view={data} timeZone={ctx.timeZone} onPick={pick} />}
        </SummaryAnswer>
      )}
    </View>
  );
}

type Fit = DutyVendorsView['fits'][number];

/** "Approved · last used Sep 12", with where it works and any disclosure. */
export function fitLine(f: Fit, timeZone: string): string {
  return [
    W.approved,
    f.lastUsedAt ? W.lastUsed(fmtMonthDay(localDayOf(f.lastUsedAt, timeZone))) : null,
    f.inArea === false ? W.notHere : null,
    f.disclosure ? f.disclosureWords : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function DutyVendorsBody({
  view,
  timeZone,
  onPick,
}: {
  view: DutyVendorsView;
  timeZone: string;
  onPick?: (vendorId: string, quoteCents: number | null) => Promise<void>;
}) {
  const picks = view.picks.filter((p) => !p.removedAt);
  const pickedIds = new Set(picks.map((p) => p.vendor.id));
  const fits = view.fits.filter((f) => !pickedIds.has(f.id));
  const [chosen, setChosen] = React.useState<string | null>(fits[0]?.id ?? null);
  const [quote, setQuote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const vendor = fits.find((f) => f.id === chosen) ?? null;
  const use = async () => {
    if (!vendor || !onPick) return;
    const cents = quote.trim() ? parseMoney(quote) : null;
    if (quote.trim() && cents === null) {
      setError(W.badQuote);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onPick(vendor.id, cents);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!view.service && !picks.length)
    return <Text className="text-[14px] text-text-2">{W.noService}</Text>;
  return (
    <View className="gap-3" testID="duty-vendors-body">
      {picks.length ? (
        <List testID="duty-vendor-picks">
          {picks.map((p) => (
            <CheckRow
              key={p.pickId}
              label={p.vendor.name}
              line={[
                p.quoteWords,
                p.appointment ? fmtAt(p.appointment.startsAt, timeZone) : W.notBooked,
                p.vendor.disclosure ? p.vendor.disclosureWords : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              end={<Badge variant="ok">{W.pickedBadge}</Badge>}
            />
          ))}
        </List>
      ) : null}
      {view.service ? (
        fits.length ? (
          <>
            <List testID="duty-vendor-fits">
              {fits.map((f) => (
                <CheckRow
                  key={f.id}
                  checked={onPick ? chosen === f.id : undefined}
                  label={f.name}
                  line={fitLine(f, timeZone)}
                  onPress={onPick ? () => setChosen(f.id) : undefined}
                  testID={`duty-vendor-fit-${f.id}`}
                />
              ))}
            </List>
            {onPick ? (
              <>
                <FieldLabel>{W.quote}</FieldLabel>
                <Input
                  value={quote}
                  onChangeText={setQuote}
                  keyboardType="decimal-pad"
                  placeholder={W.quoteHint}
                  invalid={!!error}
                  testID="duty-vendor-quote"
                />
                <ListLabel>{W.appointment}</ListLabel>
                <Text className="px-1 text-[13.5px] text-text-2">{W.notBooked}</Text>
                <FieldError testID="duty-vendor-error">{error}</FieldError>
                <ChangeButton
                  command="realestate.duty.pick_vendor"
                  label={vendor ? W.use(vendor.name) : W.title}
                  why={W.pickWhy}
                  loading={busy}
                  disabled={!vendor}
                  onPress={() => void use()}
                  testID="duty-vendor-use"
                />
              </>
            ) : null}
          </>
        ) : (
          <Text className="text-[14px] text-text-2">{W.none(view.serviceLabel)}</Text>
        )
      ) : null}
      <SignalNote>{W.everyOne}</SignalNote>
    </View>
  );
}
