import type { NetFigures } from '@hfos/core/addons/realestate/net';

import { change, newId } from '@/changes';

import { INSERT_ROW_SQL } from './closing-actions';

/**
 * The listing's changes from the phone (boards 87–89): photos taken on the spot and their order, a new price asked of
 * the seller, the seller's estimate, showings added and answered, a duty's vendor, and what needs signal (the MLS
 * asked again, a description or posts written, marking it live). As on the closing side, each writes what the person
 * should see at once into the phone's copy of Real Estate's rows, in the same transaction.
 */

const nowIso = () => new Date().toISOString();
const rowArgs = (
  workspaceId: string,
  source: string,
  id: string,
  dealId: string,
  data: Record<string, unknown>,
) => [`${source}:${id}`, workspaceId, source, dealId, JSON.stringify(data), nowIso()];

// ---------- photos ----------

/** A photo taken for the listing, once it has uploaded: it goes at the end, on the listing's page. */
export async function addListingPhoto(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly fileId: string;
  /** Its upload's change. */
  readonly upload: string;
  readonly position: number;
}): Promise<string> {
  const id = newId();
  const { workspaceId, dealId, fileId } = input;
  await change(
    'realestate.listing.photo_add',
    { workspaceId, dealId, id, fileId, public: true },
    {
      dependsOn: [input.upload],
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'listing_photos', id, dealId, {
            file_id: fileId,
            position: input.position,
            caption: null,
            public: true,
            created_at: nowIso(),
          }),
        ),
    },
  );
  return id;
}

export const PHOTO_POSITION_SQL = `
  UPDATE addon_phone_rows SET data = json_set(data, '$.position', ?) WHERE id = ?`;

/** Every photo, in the order shown (the first is the cover), with its caption and whether the page shows it. */
export async function arrangeListingPhotos(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly photos: readonly {
    readonly id: string;
    readonly caption: string | null;
    readonly public: boolean;
  }[];
}): Promise<void> {
  const { workspaceId, dealId, photos } = input;
  await change(
    'realestate.listing.photos_arrange',
    { workspaceId, dealId, photos: photos.map((p) => ({ ...p })) },
    {
      optimistic: async (tx) => {
        for (const [position, p] of photos.entries())
          await tx.execute(PHOTO_POSITION_SQL, [position, `listing_photos:${p.id}`]);
      },
    },
  );
}

// ---------- the facts and the MLS ----------

/** The facts confirmed again with one changed: typed by the agent. */
export async function confirmFacts(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly facts: Record<string, unknown>;
  readonly sources: Record<string, string>;
}): Promise<void> {
  await change('realestate.listing.confirm_facts', input as never);
}

/** The listing looked up on the MLS again (with signal); what it says arrives from the worker. */
export async function lookUpListing(input: {
  readonly workspaceId: string;
  readonly dealId: string;
}): Promise<void> {
  await change('realestate.listing.lookup', input);
}

/** A new version of the description, drafted by the AI and checked for fair housing (with signal). */
export async function requestDescription(input: {
  readonly workspaceId: string;
  readonly dealId: string;
}): Promise<void> {
  await change('realestate.listing.description.request', input);
}

// ---------- price ----------

/** A new list price, asked of the seller in their portal: it's used once they sign. */
export async function proposePrice(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly userId: string;
  readonly fromCents: number;
  readonly priceCents: number;
  readonly note: string | null;
}): Promise<void> {
  const { workspaceId, dealId, priceCents, note } = input;
  await change(
    'realestate.listing.price.propose',
    { workspaceId, dealId, priceCents, ...(note ? { note } : {}) },
    {
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'listing_prices', newId(), dealId, {
            from_cents: input.fromCents,
            to_cents: priceCents,
            words: '',
            note,
            state: 'waiting',
            proposed_at: nowIso(),
            proposed_by: input.userId,
          }),
        ),
    },
  );
}

// ---------- marketing and open houses ----------

/** Marks the listing live on the MLS: from then on, what's public can go out. */
export async function markLive(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly mlsNumber: string;
  readonly liveOn: string;
}): Promise<void> {
  await change('realestate.listing.mark_live', input);
}

/** The social posts, written by the AI and checked for fair housing (with signal). */
export async function requestPosts(input: {
  readonly workspaceId: string;
  readonly dealId: string;
}): Promise<void> {
  await change('realestate.listing.posts_request', input);
}

/** An open house planned: it goes on the calendar. */
export async function planOpenHouse(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
}): Promise<void> {
  await change('realestate.open_house.plan', input);
}

/** A visitor signed in at the open house on the agent's phone: it waits on the phone with no signal. */
export async function signInVisitor(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly openHouseId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly withAgent: boolean;
  readonly agentName: string | null;
  readonly smsConsent: boolean;
}): Promise<string> {
  const id = newId();
  const { workspaceId, dealId, openHouseId, firstName, lastName, withAgent, smsConsent } = input;
  await change(
    'realestate.open_house.sign_in',
    {
      workspaceId,
      openHouseId,
      id,
      firstName,
      lastName,
      ...(input.email ? { email: input.email } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      withAgent,
      ...(withAgent && input.agentName ? { agentName: input.agentName } : {}),
      smsConsent,
    },
    {
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'open_house_visitors', id, dealId, {
            open_house_id: openHouseId,
            first_name: firstName,
            last_name: lastName || null,
            email: input.email,
            phone: input.phone,
            with_agent: withAgent,
            agent_name: withAgent ? input.agentName : null,
            sms_consent: smsConsent,
            signed_in_at: nowIso(),
          }),
        ),
    },
  );
  return id;
}

// ---------- the seller's net ----------

/** New figures for the seller's estimate, kept beside the estimates they made. */
export async function saveNetSheet(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly userId: string;
  /** The version this one follows. */
  readonly version: number;
  readonly figures: NetFigures;
}): Promise<void> {
  const id = newId();
  const { workspaceId, dealId, figures: f } = input;
  await change(
    'realestate.net_sheet.save',
    {
      workspaceId,
      dealId,
      id,
      payoffCents: f.payoffCents,
      listingFeeBp: f.listingFeeBp,
      listingFeeCents: f.listingFeeCents,
      titleEscrowCents: f.titleEscrowCents,
      transferTaxBp: f.transferTaxBp,
      otherCents: f.otherCents,
      otherNote: f.otherNote ?? null,
    },
    {
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'net_sheets', id, dealId, {
            version: input.version + 1,
            payoff_cents: f.payoffCents,
            listing_fee_bp: f.listingFeeBp,
            listing_fee_cents: f.listingFeeCents,
            title_escrow_cents: f.titleEscrowCents,
            transfer_tax_bp: f.transferTaxBp,
            other_cents: f.otherCents,
            other_note: f.otherNote ?? null,
            note: null,
            saved_at: nowIso(),
            saved_by: input.userId,
          }),
        ),
    },
  );
}

// ---------- showings ----------

/** A showing added by hand (one asked for by phone). */
export async function addShowing(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly startsAt: string;
  readonly minutes: number;
  readonly agentName: string;
  readonly brokerage: string | null;
  readonly agentPhone: string | null;
}): Promise<string> {
  const id = newId();
  const { workspaceId, dealId, startsAt, minutes, agentName } = input;
  const endsAt = new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();
  await change(
    'realestate.showing.add',
    {
      workspaceId,
      dealId,
      id,
      startsAt,
      minutes,
      agentName,
      ...(input.brokerage ? { brokerage: input.brokerage } : {}),
      ...(input.agentPhone ? { agentPhone: input.agentPhone } : {}),
    },
    {
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'showings', id, dealId, {
            source: 'agent',
            state: 'requested',
            starts_at: startsAt,
            ends_at: endsAt,
            agent_name: agentName,
            brokerage: input.brokerage,
            agent_phone: input.agentPhone,
            requested_at: nowIso(),
            checked: true,
          }),
        ),
    },
  );
  return id;
}

export const SHOWING_DECIDE_SQL = `
  UPDATE addon_phone_rows
  SET data = json_set(data, '$.state', ?, '$.decided_at', ?, '$.decision_note', ?)
  WHERE id = ?`;

/** A request answered: yes, another time (a no with what to offer), or no. The agent hears once it sends. */
export async function decideShowing(input: {
  readonly workspaceId: string;
  readonly showingId: string;
  readonly decision: 'confirm' | 'decline' | 'cancel';
  readonly note: string | null;
}): Promise<void> {
  const { workspaceId, showingId, decision, note } = input;
  const state =
    decision === 'confirm' ? 'confirmed' : decision === 'decline' ? 'declined' : 'cancelled';
  await change(
    'realestate.showing.decide',
    { workspaceId, showingId, decision, ...(note ? { note } : {}) },
    {
      optimistic: (tx) =>
        tx.execute(SHOWING_DECIDE_SQL, [state, nowIso(), note, `showings:${showingId}`]),
    },
  );
}

// ---------- a duty's vendor ----------

/** A vendor picked on a duty, with its quote when there is one. */
export async function pickDutyVendor(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly userId: string;
  readonly dutyId: string;
  readonly vendorId: string;
  readonly service: string | null;
  readonly quoteCents: number | null;
}): Promise<void> {
  const { workspaceId, dealId, dutyId, vendorId } = input;
  const picked = await change(
    'realestate.duty.pick_vendor',
    { workspaceId, dutyId, vendorId },
    {
      optimistic: (tx) =>
        tx.execute(
          INSERT_ROW_SQL,
          rowArgs(workspaceId, 'duty_vendors', newId(), dealId, {
            duty_id: dutyId,
            vendor_id: vendorId,
            service: input.service,
            quote_cents: input.quoteCents,
            picked_at: nowIso(),
            picked_by: input.userId,
          }),
        ),
    },
  );
  if (input.quoteCents !== null)
    await change('realestate.duty.vendor_quote', {
      workspaceId,
      pickId: picked.output.pickId,
      cents: input.quoteCents,
    });
}
