import {
  deskCountHeading,
  FOUNDING_ANOTHER,
  FOUNDING_WORDS,
  foundingApplicationLine,
  foundingOfferIsPaid,
  foundingBusinessLabel,
  foundingClaimPath,
  foundingFirstChoice,
  foundingFirstOffer,
  foundingGivableOffers,
  foundingGivenBackLine,
  foundingOfferCard,
  foundingOfferPriceLine,
  foundingQueueParts,
  foundingSeatLine,
  foundingSeatProblem,
  foundingTheirBusinesses,
  type FoundingPickable,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, Share, TextInput, View } from 'react-native';

import { desk, useLive, type Ok } from '@/admin/live';
import { MONEY_DESK_WORDS } from '@/admin/money-desk-words';
import { DESK_PHONE_WORDS } from '@/admin/words';
import { DeskWaiting, SearchBox, Section, useSettled } from '@/components/admin/bits';
import { OnlyAdmins, Row } from '@/components/admin/money-desk-bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Check } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { config } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type Queue = Ok<'/v1/queries/platform.founding'>;
type Offer = Queue['offers'][number];
type Application = Queue['applications'][number];
type Grant = Queue['grants'][number];

/**
 * Founding (the web's /admin/founding, 0091): the offers and their caps, the applications waiting on a decision, and
 * who holds a seat, from one query so the numbers on the offer cards and the rows beneath them are from the same
 * instant. For support admins (`platform.founding.manage`).
 *
 * **The cap is enforced by the database, not here.** "Seats left" is shown, never used to disable anything: an
 * approval is offered, pressed, and a refusal comes back as a sentence. Revoking asks for a reason and won't go
 * without one, because it's kept forever.
 *
 * A free seat is on the moment it's approved or given (to any business, applied or not) and stays on until it's
 * revoked. Only a paid seat is held behind a claim link, shown once in the same sheet since only its hash is kept. A
 * seat still held from before, or one that lapsed, is turned on from its row.
 */
export default function Founding() {
  const can = useDeskCan('platform.founding.manage');
  return can ? <FoundingDesk /> : <OnlyAdmins section="founding" />;
}

function FoundingDesk() {
  const colors = useColors();
  const live = useLive(() => desk('/v1/queries/platform.founding', { limit: 100 }), 'founding');
  const [busy, setBusy] = React.useState<string | null>(null);
  // The application being approved and the seat being taken back; each kept while its sheet slides away.
  const [approving, setApproving] = React.useState<Application | null>(null);
  const [approveOpen, setApproveOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<Grant | null>(null);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [giveOpen, setGiveOpen] = React.useState(false);
  // Each opening starts afresh: a claim link already shown is never shown again, even for the same application.
  const [opening, setOpening] = React.useState(0);

  /** One change, then the queue asked for again; the database's own sentence when it refuses. */
  const run = async (what: string, fn: () => Promise<unknown>, said: string) => {
    setBusy(what);
    try {
      await fn();
      toast.show(said);
      live.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const queue = live.data;
  if (!queue)
    return (
      <Screen
        title={FOUNDING_WORDS.title}
        leading="back"
        back={deskHref()}
        scroll={false}
        testID="desk-founding"
      >
        <DeskWaiting live={live} testID="founding" />
      </Screen>
    );

  const { pending, held, gone } = foundingQueueParts(queue);

  /** A seat held but not on, or one that lapsed: on their only workspace now, for good. */
  const turnOn = (g: Grant) =>
    void run(
      `on:${g.grantId}`,
      () =>
        desk('/v1/commands/founding.give', {
          offerId: g.offerId,
          organizationId: g.organizationId,
        }),
      MONEY_DESK_WORDS.turnedOn(g.organizationName),
    );

  return (
    <Screen
      title={FOUNDING_WORDS.title}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-founding"
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={live.refreshing}
            onRefresh={live.reload}
            tintColor={colors.accent}
          />
        }
      >
        {queue.offers.map((offer) => (
          <OfferCard
            key={offer.offerId}
            offer={offer}
            offers={queue.offers}
            busy={busy}
            onCap={(seatCap) =>
              void run(
                `cap:${offer.offerId}`,
                () => desk('/v1/commands/founding.set_cap', { offerId: offer.offerId, seatCap }),
                MONEY_DESK_WORDS.capSaved(offer.name, seatCap),
              )
            }
            onStatus={(status) =>
              void run(
                `status:${offer.offerId}`,
                () => desk('/v1/commands/founding.set_status', { offerId: offer.offerId, status }),
                status === 'open'
                  ? MONEY_DESK_WORDS.opened(offer.name)
                  : MONEY_DESK_WORDS.closed(offer.name),
              )
            }
          />
        ))}

        <Section
          title={deskCountHeading(FOUNDING_WORDS.waiting, pending.length)}
          testID="founding-waiting"
        >
          {pending.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{FOUNDING_WORDS.noneWaiting}</Text>
          ) : (
            pending.map((a, i) => (
              <Row
                key={a.applicationId}
                first={i === 0}
                className="gap-2"
                testID={`founding-application-${a.applicationId}`}
              >
                <View className="gap-0.5">
                  <Text className="text-[14.5px] font-semibold">
                    {a.businessName}
                    {a.status === 'waitlisted' ? (
                      <Text className="text-[14.5px] font-normal text-text-3">
                        {FOUNDING_WORDS.waitlistedTag}
                      </Text>
                    ) : null}
                  </Text>
                  <Text className="text-[13px] text-text-3">{foundingApplicationLine(a)}</Text>
                </View>
                {/* Their own words, in full. This is what Phase 1 is for; cutting it short defeats the point. */}
                {a.note ? (
                  <Text
                    selectable
                    className="rounded-[10px] bg-card-2 px-3 py-2 text-[13.5px] leading-[19px] text-text-2"
                  >
                    {a.note}
                  </Text>
                ) : null}
                <View className="flex-row gap-2">
                  <Button
                    size="md"
                    className="flex-1"
                    onPress={() => {
                      setApproving(a);
                      setOpening((n) => n + 1);
                      setApproveOpen(true);
                    }}
                    testID={`founding-approve-${a.applicationId}`}
                  >
                    {FOUNDING_WORDS.approve}
                  </Button>
                  <Button
                    size="md"
                    variant="secondary"
                    className="flex-1"
                    loading={busy === `decline:${a.applicationId}`}
                    onPress={() =>
                      void run(
                        `decline:${a.applicationId}`,
                        () =>
                          desk('/v1/commands/founding.decline', { applicationId: a.applicationId }),
                        MONEY_DESK_WORDS.declined(a.businessName),
                      )
                    }
                    testID={`founding-decline-${a.applicationId}`}
                  >
                    {FOUNDING_WORDS.decline}
                  </Button>
                </View>
              </Row>
            ))
          )}
        </Section>

        <Section
          title={deskCountHeading(FOUNDING_WORDS.seatsOut, held.length)}
          end={
            <Button
              size="sm"
              onPress={() => {
                setOpening((n) => n + 1);
                setGiveOpen(true);
              }}
              testID="founding-give"
            >
              {FOUNDING_WORDS.give}
            </Button>
          }
          testID="founding-seats"
        >
          {held.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{FOUNDING_WORDS.noSeatsOut}</Text>
          ) : (
            held.map((g, i) => (
              <Row key={g.grantId} first={i === 0} testID={`founding-seat-${g.grantId}`}>
                <SeatFacts grant={g} line={foundingSeatLine(g)} />
                <View className="mt-1 flex-row gap-2">
                  {g.status === 'reserved' && !foundingOfferIsPaid(g.offerId, queue.offers) ? (
                    <Button
                      size="md"
                      className="flex-1"
                      loading={busy === `on:${g.grantId}`}
                      onPress={() => turnOn(g)}
                      testID={`founding-on-${g.grantId}`}
                    >
                      {FOUNDING_WORDS.turnOn}
                    </Button>
                  ) : null}
                  <Button
                    size="md"
                    variant="secondary"
                    className="flex-1"
                    onPress={() => {
                      setRevoking(g);
                      setOpening((n) => n + 1);
                      setRevokeOpen(true);
                    }}
                    testID={`founding-revoke-${g.grantId}`}
                  >
                    {FOUNDING_WORDS.revoke}
                  </Button>
                </View>
              </Row>
            ))
          )}
        </Section>

        {gone.length > 0 ? (
          <Section title={FOUNDING_WORDS.givenBack} testID="founding-given-back">
            {gone.map((g, i) => (
              <Row key={g.grantId} first={i === 0} testID={`founding-gone-${g.grantId}`}>
                <SeatFacts grant={g} line={foundingGivenBackLine(g)} />
                {g.status === 'revoked' ? (
                  <Button
                    size="md"
                    variant="secondary"
                    className="mt-1"
                    loading={busy === `restore:${g.grantId}`}
                    onPress={() =>
                      void run(
                        `restore:${g.grantId}`,
                        () => desk('/v1/commands/founding.restore', { grantId: g.grantId }),
                        MONEY_DESK_WORDS.restored(g.organizationName),
                      )
                    }
                    testID={`founding-undo-${g.grantId}`}
                  >
                    {FOUNDING_WORDS.undo}
                  </Button>
                ) : !foundingOfferIsPaid(g.offerId, queue.offers) ? (
                  <Button
                    size="md"
                    variant="secondary"
                    className="mt-1"
                    loading={busy === `on:${g.grantId}`}
                    onPress={() => turnOn(g)}
                    testID={`founding-on-${g.grantId}`}
                  >
                    {FOUNDING_WORDS.turnOn}
                  </Button>
                ) : null}
              </Row>
            ))}
          </Section>
        ) : null}
      </ScrollView>

      <ApproveSheet
        application={approving}
        paid={approving ? foundingOfferIsPaid(approving.offerId, queue.offers) : false}
        opening={opening}
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        onApproved={live.reload}
        onTurnedOn={() => {
          setApproveOpen(false);
          toast.show(MONEY_DESK_WORDS.turnedOn(approving?.businessName ?? null));
          live.reload();
        }}
      />
      <GiveSheet
        offers={foundingGivableOffers(queue.offers)}
        opening={opening}
        open={giveOpen}
        onClose={() => setGiveOpen(false)}
        onGiven={(business) => {
          setGiveOpen(false);
          toast.show(MONEY_DESK_WORDS.turnedOn(business));
          live.reload();
        }}
      />
      <RevokeSheet
        grant={revoking}
        opening={opening}
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onRevoked={() => {
          setRevokeOpen(false);
          toast.show(MONEY_DESK_WORDS.revoked(revoking?.organizationName ?? null));
          live.reload();
        }}
      />
    </Screen>
  );
}

/** Whose seat it is and where it stands, and, in red, a payment that needs a person. */
function SeatFacts({ grant: g, line }: { grant: Grant; line: string }) {
  const problem = foundingSeatProblem(g);
  return (
    <>
      <Text className="text-[14.5px] font-semibold" numberOfLines={1}>
        {g.organizationName ?? g.organizationId}
      </Text>
      <Text className="text-[13px] text-text-3">{line}</Text>
      {/* Money in, no seat on: somebody has to refund it at Stripe or find them a seat. */}
      {problem ? <Text className="text-[13px] text-danger-text">{problem}</Text> : null}
    </>
  );
}

function OfferCard({
  offer,
  offers,
  busy,
  onCap,
  onStatus,
}: {
  offer: Offer;
  offers: readonly Offer[];
  busy: string | null;
  onCap: (seatCap: number) => void;
  onStatus: (status: 'open' | 'closed') => void;
}) {
  const [cap, setCap] = React.useState(String(offer.seatCap));
  const [problem, setProblem] = React.useState<string | null>(null);
  const { monthly, pct, opens, opened, replaced, paid, yearly, action } = foundingOfferCard(
    offer,
    offers,
  );

  const save = () => {
    const n = Number(cap.trim());
    if (cap.trim() === '' || !Number.isInteger(n) || n < 0) {
      setProblem(MONEY_DESK_WORDS.capNotNumber);
      return;
    }
    setProblem(null);
    onCap(n);
  };

  return (
    <Card className="gap-2 px-4 py-3.5" testID={`founding-offer-${offer.offerId}`}>
      <View className="flex-row items-baseline justify-between gap-2">
        <Text className="min-w-0 flex-shrink text-[15px] font-semibold">{offer.name}</Text>
        <Text className="text-[13px] text-text-3">{foundingOfferPriceLine(offer)}</Text>
      </View>

      {monthly ? (
        // No seats and no cap: this card is the switch for whether the website sells the plan.
        <Text className="text-[13.5px] text-text-2">{FOUNDING_WORDS.monthlyNote}</Text>
      ) : (
        <>
          <Text className="text-2xl font-semibold tabular-nums">
            {offer.remaining}
            <Text className="text-base font-normal text-text-3">
              {FOUNDING_WORDS.ofLeft(offer.seatCap)}
            </Text>
          </Text>
          <View className="h-2 w-full overflow-hidden rounded-full bg-card-2">
            <View className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </View>
        </>
      )}

      {opens ? (
        <Text className="text-[13.5px] leading-[19px] text-text-2">{opens}</Text>
      ) : opened ? (
        <Text className="text-[13.5px] text-text-3">{opened}</Text>
      ) : null}
      {replaced ? (
        <Text className="text-[13.5px] leading-[19px] text-text-3">{replaced}</Text>
      ) : null}
      {paid ? (
        <Text className="text-[13.5px] leading-[19px] text-text-3">{FOUNDING_WORDS.paidNote}</Text>
      ) : null}
      {yearly ? (
        <Text className="text-[13.5px] leading-[19px] text-text-3">
          {FOUNDING_WORDS.yearlyNote}
        </Text>
      ) : null}

      <View className="flex-row flex-wrap items-end gap-2 pt-1">
        {monthly ? null : (
          <>
            <View className="w-24 gap-1.5">
              <Label>{FOUNDING_WORDS.seats}</Label>
              <Input
                value={cap}
                onChangeText={(text) => {
                  setCap(text);
                  setProblem(null);
                }}
                keyboardType="number-pad"
                inputMode="numeric"
                invalid={problem !== null}
                accessibilityLabel={FOUNDING_WORDS.seats}
                className="h-11"
                testID={`founding-cap-${offer.offerId}`}
              />
            </View>
            <Button
              size="md"
              variant="secondary"
              loading={busy === `cap:${offer.offerId}`}
              disabled={cap === String(offer.seatCap)}
              onPress={save}
              testID={`founding-cap-save-${offer.offerId}`}
            >
              {FOUNDING_WORDS.save}
            </Button>
          </>
        )}
        <Button
          size="md"
          variant="secondary"
          loading={busy === `status:${offer.offerId}`}
          onPress={() => onStatus(action.status)}
          testID={`founding-status-${offer.offerId}`}
        >
          {action.label}
        </Button>
      </View>
      {problem ? <FieldError>{problem}</FieldError> : null}
      {monthly ? null : (
        <Text className="text-[12.5px] leading-[17px] text-text-3">
          {FOUNDING_WORDS.capHint(offer.claimed)}
        </Text>
      )}
    </Card>
  );
}

/** One choice of a few, as a row with a tick: where the web has a dropdown, a sheet can't open another sheet. */
function Choice({
  label,
  on,
  first,
  onPress,
  testID,
}: {
  label: string;
  on: boolean;
  first: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      testID={testID}
      className={cn(
        'min-h-12 flex-row items-center gap-3 px-3.5 active:bg-card-2',
        !first && 'border-t border-border',
      )}
    >
      <Text className="min-w-0 flex-1 py-2 text-[15px]">{label}</Text>
      {on ? <Icon as={Check} className="size-5 text-accent" /> : null}
    </Pressable>
  );
}

/** The claim link an approval made, with the opening of the sheet it was made in. */
interface Issued {
  readonly opening: number;
  readonly link: string;
  readonly until: string;
}

/**
 * Approving: which business the seat goes to (theirs, matched on the email they applied with, or found by name), and
 * why them. Once it's approved the same sheet shows the claim link, the only time it is ever shown. The sheet stays
 * put between openings, so it slides as every sheet does; the form inside starts afresh each time.
 */
function ApproveSheet({
  application,
  paid,
  opening,
  open,
  onClose,
  onApproved,
  onTurnedOn,
}: {
  application: Application | null;
  /** A paid seat is held behind a link; a free one is on at once. */
  paid: boolean;
  opening: number;
  open: boolean;
  onClose: () => void;
  onApproved: () => void;
  onTurnedOn: () => void;
}) {
  const [issued, setIssued] = React.useState<Issued | null>(null);
  // Only the opening that made it shows the link: opening the sheet again never shows it twice.
  const shown = issued?.opening === opening ? issued : null;
  const business = application?.businessName ?? '';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={shown ? FOUNDING_WORDS.issuedTitle(business) : FOUNDING_WORDS.approveTitle(business)}
      description={
        shown
          ? FOUNDING_WORDS.issuedDescription
          : paid
            ? FOUNDING_WORDS.approveDescription
            : FOUNDING_WORDS.approveFreeDescription
      }
      scroll
      testID={shown ? 'founding-issued' : 'founding-approve-sheet'}
    >
      {shown ? (
        <ClaimLink link={shown.link} until={shown.until} onDone={onClose} />
      ) : application ? (
        <ApproveForm
          key={opening}
          application={application}
          paid={paid}
          onClose={onClose}
          onIssued={(link, until) => {
            setIssued({ opening, link, until });
            onApproved();
          }}
          onTurnedOn={onTurnedOn}
        />
      ) : null}
    </Sheet>
  );
}

function ApproveForm({
  application,
  paid,
  onClose,
  onIssued,
  onTurnedOn,
}: {
  application: Application;
  paid: boolean;
  onClose: () => void;
  onIssued: (link: string, until: string) => void;
  onTurnedOn: () => void;
}) {
  const colors = useColors();
  const keyboard = useKeyboardHeight();
  const theirs = React.useMemo(() => foundingTheirBusinesses(application), [application]);
  // A founder with one business is the usual case, so that one is picked for you.
  const [choice, setChoice] = React.useState(() => foundingFirstChoice(theirs));
  const [term, setTerm] = React.useState('');
  const search = useSettled(term, 250);
  const searching = choice === FOUNDING_ANOTHER && search.length >= 2;
  const found = useBusinessSearch(search, searching);
  const [foundChoice, setFoundChoice] = React.useState('');
  React.useEffect(() => setFoundChoice(''), [search]);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  const picked =
    choice === FOUNDING_ANOTHER
      ? found.data?.find((b) => b.workspaceId === foundChoice)
      : theirs.find((b) => b.workspaceId === choice);

  const approve = async () => {
    if (!picked) return;
    setBusy(true);
    setProblem(null);
    try {
      const made = await desk('/v1/commands/founding.approve', {
        applicationId: application.applicationId,
        organizationId: picked.organizationId,
        workspaceId: picked.workspaceId,
        note,
      });
      // A free seat is simply on. Only a paid one comes back with a link to send.
      if (made.claimToken && made.expiresAt)
        onIssued(`${config.webUrl}${foundingClaimPath(made.claimToken)}`, made.expiresAt);
      else onTurnedOn();
    } catch (e) {
      // The database's refusals arrive as sentences: "Every seat in this offer is taken", and so on.
      setProblem(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <View className="mt-4 gap-3" style={keyboard ? { paddingBottom: keyboard } : undefined}>
      <View className="gap-1.5">
        <Label>{FOUNDING_WORDS.theirBusiness}</Label>
        <View className="overflow-hidden rounded-card border border-border bg-card">
          {theirs.map((b, i) => (
            <Choice
              key={b.workspaceId}
              label={b.label}
              on={choice === b.workspaceId}
              first={i === 0}
              onPress={() => setChoice(b.workspaceId)}
              testID={`founding-business-${b.workspaceId}`}
            />
          ))}
          <Choice
            label={FOUNDING_WORDS.another}
            on={choice === FOUNDING_ANOTHER}
            first={theirs.length === 0}
            onPress={() => setChoice(FOUNDING_ANOTHER)}
            testID="founding-business-another"
          />
        </View>
        <Text className="text-[13px] leading-[18px] text-text-3">
          {theirs.length
            ? FOUNDING_WORDS.theirsHint(application.email)
            : FOUNDING_WORDS.noneTheirsHint(application.email)}
        </Text>
      </View>

      {choice === FOUNDING_ANOTHER ? (
        <>
          <View className="gap-1.5">
            <Label>{FOUNDING_WORDS.searchBusinesses}</Label>
            <SearchBox
              value={term}
              onChange={setTerm}
              placeholder={FOUNDING_WORDS.searchPlaceholder}
              testID="founding-search"
            />
          </View>
          {found.data === null ? (
            searching && found.error ? (
              <Text className="text-[13px] text-text-3">{found.error}</Text>
            ) : null
          ) : found.data.length === 0 ? (
            <Text className="text-[13px] text-text-3" testID="founding-no-business">
              {FOUNDING_WORDS.noBusiness}
            </Text>
          ) : (
            <View className="gap-1.5">
              <Label>{FOUNDING_WORDS.business}</Label>
              <View className="overflow-hidden rounded-card border border-border bg-card">
                {found.data.map((b, i) => (
                  <Choice
                    key={b.workspaceId}
                    label={b.label}
                    on={foundChoice === b.workspaceId}
                    first={i === 0}
                    onPress={() => setFoundChoice(b.workspaceId)}
                    testID={`founding-found-${b.workspaceId}`}
                  />
                ))}
              </View>
              {theirs.some((b) => b.workspaceId === foundChoice) ? null : (
                <Text className="text-[13px] leading-[18px] text-text-3">
                  {FOUNDING_WORDS.notTheirsHint(application.email)}
                </Text>
              )}
            </View>
          )}
        </>
      ) : null}

      <View className="gap-1.5">
        <Label>{FOUNDING_WORDS.whyThem}</Label>
        <TextInput
          value={note}
          onChangeText={setNote}
          multiline
          textAlignVertical="top"
          accessibilityLabel={FOUNDING_WORDS.whyThem}
          placeholderTextColor={colors.text3}
          maxLength={2000}
          className="h-24 rounded-control border border-border-strong bg-card px-3 py-3 font-sans text-[15px] text-text"
          testID="founding-note"
        />
        <Text className="text-[13px] text-text-3">{FOUNDING_WORDS.whyThemHint}</Text>
      </View>

      {problem ? <FieldError testID="founding-approve-problem">{problem}</FieldError> : null}
      <Button
        onPress={() => void approve()}
        loading={busy}
        disabled={!picked}
        testID="founding-approve-go"
      >
        {busy
          ? paid
            ? FOUNDING_WORDS.approving
            : FOUNDING_WORDS.giving
          : paid
            ? FOUNDING_WORDS.approveAndHold
            : FOUNDING_WORDS.approveAndTurnOn}
      </Button>
      <Button variant="secondary" onPress={onClose}>
        {DESK_PHONE_WORDS.cancel}
      </Button>
    </View>
  );
}

/** Businesses whose name has `search` in it. Null until there's something to look for. */
function useBusinessSearch(search: string, searching: boolean) {
  return useLive<FoundingPickable[] | null>(
    () =>
      searching
        ? desk('/v1/queries/platform.business.list', { search, sort: 'name', limit: 20 }).then(
            (out) =>
              out.businesses.map((b) => ({
                workspaceId: b.workspaceId,
                organizationId: b.organizationId,
                label: foundingBusinessLabel(b.name, b.organizationName),
              })),
          )
        : Promise.resolve(null),
    searching ? `search:${search}` : 'none',
  );
}

/** A seat for any business, applied or not: found by name, on its workspace at once, kept until revoked. */
function GiveSheet({
  offers,
  opening,
  open,
  onClose,
  onGiven,
}: {
  offers: readonly Offer[];
  opening: number;
  open: boolean;
  onClose: () => void;
  onGiven: (business: string) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={FOUNDING_WORDS.giveTitle}
      description={FOUNDING_WORDS.giveDescription}
      scroll
      testID="founding-give-sheet"
    >
      <GiveForm key={opening} offers={offers} onClose={onClose} onGiven={onGiven} />
    </Sheet>
  );
}

function GiveForm({
  offers,
  onClose,
  onGiven,
}: {
  offers: readonly Offer[];
  onClose: () => void;
  onGiven: (business: string) => void;
}) {
  const colors = useColors();
  const keyboard = useKeyboardHeight();
  const [term, setTerm] = React.useState('');
  const search = useSettled(term, 250);
  const found = useBusinessSearch(search, search.length >= 2);
  const [foundChoice, setFoundChoice] = React.useState('');
  React.useEffect(() => setFoundChoice(''), [search]);
  const [offerId, setOfferId] = React.useState(() => foundingFirstOffer(offers));
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const picked = found.data?.find((b) => b.workspaceId === foundChoice);

  const give = async () => {
    if (!picked || !offerId) return;
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/founding.give', {
        offerId,
        organizationId: picked.organizationId,
        workspaceId: picked.workspaceId,
        note,
      });
      onGiven(picked.label);
    } catch (e) {
      // The database's refusals arrive as sentences: "Every seat in this offer is taken", and so on.
      setProblem(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <View className="mt-4 gap-3" style={keyboard ? { paddingBottom: keyboard } : undefined}>
      <View className="gap-1.5">
        <Label>{FOUNDING_WORDS.searchBusinesses}</Label>
        <SearchBox
          value={term}
          onChange={setTerm}
          placeholder={FOUNDING_WORDS.searchPlaceholder}
          testID="founding-give-search"
        />
      </View>
      {found.data === null ? (
        search.length >= 2 && found.error ? (
          <Text className="text-[13px] text-text-3">{found.error}</Text>
        ) : null
      ) : found.data.length === 0 ? (
        <Text className="text-[13px] text-text-3" testID="founding-give-none">
          {FOUNDING_WORDS.noBusiness}
        </Text>
      ) : (
        <View className="gap-1.5">
          <Label>{FOUNDING_WORDS.business}</Label>
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {found.data.map((b, i) => (
              <Choice
                key={b.workspaceId}
                label={b.label}
                on={foundChoice === b.workspaceId}
                first={i === 0}
                onPress={() => setFoundChoice(b.workspaceId)}
                testID={`founding-give-found-${b.workspaceId}`}
              />
            ))}
          </View>
        </View>
      )}

      {offers.length === 0 ? (
        <Text className="text-[13px] text-text-3">{FOUNDING_WORDS.noOfferOpen}</Text>
      ) : offers.length > 1 ? (
        <View className="gap-1.5">
          <Label>{FOUNDING_WORDS.offer}</Label>
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {offers.map((o, i) => (
              <Choice
                key={o.offerId}
                label={`${o.name} · ${foundingOfferPriceLine(o)}`}
                on={offerId === o.offerId}
                first={i === 0}
                onPress={() => setOfferId(o.offerId)}
                testID={`founding-give-offer-${o.offerId}`}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View className="gap-1.5">
        <Label>{FOUNDING_WORDS.whyThem}</Label>
        <TextInput
          value={note}
          onChangeText={setNote}
          multiline
          textAlignVertical="top"
          accessibilityLabel={FOUNDING_WORDS.whyThem}
          placeholderTextColor={colors.text3}
          maxLength={2000}
          className="h-24 rounded-control border border-border-strong bg-card px-3 py-3 font-sans text-[15px] text-text"
          testID="founding-give-note"
        />
        <Text className="text-[13px] text-text-3">{FOUNDING_WORDS.whyThemHint}</Text>
      </View>

      {problem ? <FieldError testID="founding-give-problem">{problem}</FieldError> : null}
      <Button
        onPress={() => void give()}
        loading={busy}
        disabled={!picked || !offerId}
        testID="founding-give-go"
      >
        {busy ? FOUNDING_WORDS.giving : FOUNDING_WORDS.giveSeat}
      </Button>
      <Button variant="secondary" onPress={onClose}>
        {DESK_PHONE_WORDS.cancel}
      </Button>
    </View>
  );
}

/** The claim link, once. There's no clipboard here: it's selectable, and the share sheet sends it by email or text. */
function ClaimLink({ link, until, onDone }: { link: string; until: string; onDone: () => void }) {
  return (
    <View className="mt-4 gap-3">
      <Text
        selectable
        className="rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] text-text-2"
        testID="founding-link"
      >
        {link}
      </Text>
      <Text className="text-[13px] leading-[18px] text-text-3">
        {MONEY_DESK_WORDS.holdToCopy} {FOUNDING_WORDS.linkWorks(until)}
      </Text>
      <Button
        onPress={() => void Share.share({ message: link, url: link })}
        testID="founding-link-share"
      >
        {MONEY_DESK_WORDS.shareLink}
      </Button>
      <Button variant="secondary" onPress={onDone} testID="founding-link-done">
        {FOUNDING_WORDS.sentIt}
      </Button>
    </View>
  );
}

/** Taking a seat back. It won't go without a reason: the reason is kept forever. */
function RevokeSheet({
  grant,
  opening,
  open,
  onClose,
  onRevoked,
}: {
  grant: Grant | null;
  opening: number;
  open: boolean;
  onClose: () => void;
  onRevoked: () => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={FOUNDING_WORDS.revokeTitle(grant?.organizationName ?? null)}
      description={FOUNDING_WORDS.revokeDescription}
      testID="founding-revoke-sheet"
    >
      {grant ? (
        <RevokeForm key={opening} grant={grant} onClose={onClose} onRevoked={onRevoked} />
      ) : null}
    </Sheet>
  );
}

function RevokeForm({
  grant,
  onClose,
  onRevoked,
}: {
  grant: Grant;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const colors = useColors();
  const keyboard = useKeyboardHeight();
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  const revoke = async () => {
    const why = reason.trim();
    if (!why) return;
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/founding.revoke', { grantId: grant.grantId, reason: why });
      onRevoked();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="mt-4 gap-3" style={keyboard ? { paddingBottom: keyboard } : undefined}>
      <View className="gap-1.5">
        <Label>{FOUNDING_WORDS.why}</Label>
        <TextInput
          value={reason}
          onChangeText={setReason}
          multiline
          textAlignVertical="top"
          accessibilityLabel={FOUNDING_WORDS.why}
          placeholderTextColor={colors.text3}
          maxLength={1000}
          className="h-24 rounded-control border border-border-strong bg-card px-3 py-3 font-sans text-[15px] text-text"
          testID="founding-revoke-reason"
        />
        <Text className="text-[13px] text-text-3">{FOUNDING_WORDS.whyHint}</Text>
      </View>
      {problem ? <FieldError testID="founding-revoke-problem">{problem}</FieldError> : null}
      <Button
        variant="danger"
        onPress={() => void revoke()}
        loading={busy}
        disabled={reason.trim() === ''}
        testID="founding-revoke-go"
      >
        {busy ? FOUNDING_WORDS.revoking : FOUNDING_WORDS.revokeSeat}
      </Button>
      <Button variant="secondary" onPress={onClose}>
        {DESK_PHONE_WORDS.cancel}
      </Button>
    </View>
  );
}
