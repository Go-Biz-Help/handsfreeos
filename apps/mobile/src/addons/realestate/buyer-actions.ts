import type { HomeStatus } from '@hfos/core/addons/realestate/homes';
import type { MemoryKind } from '@hfos/core/addons/realestate/memory';
import type { TourInterest } from '@hfos/core/addons/realestate/tours';

import { change, newId, type InputOf } from '@/changes';
import { changes } from '@/changes';

/**
 * The buyer's pages' changes (boards 82–84), each a command through the phone's queue. What can wait with no signal
 * writes what the person should see into the phone's copy of the add-on's rows in the same transaction (the row's id
 * is `<source>:<its key>`); the server's rows take its place once it's handled. What needs signal goes straight to
 * HandsFreeOS, and `change` refuses it with none.
 */

const nowIso = () => new Date().toISOString();
const rowId = (source: string, key: string) => `${source}:${key}`;

const INSERT_ROW = `INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data, updated_at)
  VALUES (?, ?, 'realestate', ?, ?, ?, ?)`;

export type ProfileInput = InputOf<'realestate.buyer_profile.save'>['profile'];

/** What the buyer wants, saved: it waits on the phone, and the search runs again when it sends (board 82). */
export function saveProfile(
  workspaceId: string,
  dealId: string,
  profile: Required<ProfileInput>,
  userId: string,
) {
  const at = nowIso();
  const id = rowId('buyer_profiles', dealId);
  const data = {
    budget_min_cents: profile.budgetMinCents,
    budget_max_cents: profile.budgetMaxCents,
    areas: profile.areas,
    home_types: profile.homeTypes,
    beds_min: profile.bedsMin,
    baths_min: profile.bathsMin,
    sqft_min: profile.sqftMin,
    move_by: profile.moveBy,
    must_haves: profile.mustHaves,
    deal_breakers: profile.dealBreakers,
    updated_at: at,
    updated_by: userId,
  };
  return change(
    'realestate.buyer_profile.save',
    { workspaceId, dealId, profile },
    {
      optimistic: async (tx) => {
        await tx.execute(
          `UPDATE addon_phone_rows SET data = json_patch(data, ?), updated_at = ? WHERE id = ?`,
          [JSON.stringify(data), at, id],
        );
        await tx.execute(
          `INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data, updated_at)
           SELECT ?, ?, 'realestate', 'buyer_profiles', ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM addon_phone_rows WHERE id = ?)`,
          [
            id,
            workspaceId,
            dealId,
            JSON.stringify({ ...data, version: 1, search_on: false }),
            at,
            id,
          ],
        );
      },
    },
  );
}

/** Something to remember about the buyer, kept as the agent said it. */
export function remember(
  workspaceId: string,
  dealId: string,
  kind: MemoryKind,
  words: string,
  userId: string,
) {
  const id = newId();
  const at = nowIso();
  return change(
    'realestate.memory.add',
    { workspaceId, dealId, id, kind, words: words.trim() },
    {
      optimistic: (tx) =>
        tx.execute(INSERT_ROW, [
          rowId('memory_items', id),
          workspaceId,
          'memory_items',
          dealId,
          JSON.stringify({
            kind,
            words: words.trim(),
            quote: null,
            source_kind: 'typed',
            source_id: null,
            status: 'confirmed',
            suggested_by: 'person',
            created_by: userId,
            created_at: at,
          }),
          at,
        ]),
    },
  );
}

/** A home added on the phone, with the phone's id: it's looked up on the MLS when it arrives. */
export async function addHome(
  workspaceId: string,
  dealId: string,
  home: { readonly address: string; readonly mlsNumber?: string; readonly note?: string },
  userId: string,
): Promise<string> {
  const id = newId();
  const at = nowIso();
  const address = home.address.trim();
  await change(
    'realestate.home.add',
    {
      workspaceId,
      dealId,
      id,
      address,
      ...(home.mlsNumber?.trim() ? { mlsNumber: home.mlsNumber.trim() } : {}),
      ...(home.note?.trim() ? { note: home.note.trim() } : {}),
    },
    {
      optimistic: (tx) =>
        tx.execute(INSERT_ROW, [
          rowId('homes', id),
          workspaceId,
          'homes',
          dealId,
          JSON.stringify({
            address,
            source: 'agent',
            link: null,
            facts: {},
            fact_sources: {},
            facts_state: 'none',
            status: 'saved',
            status_note: null,
            added_by: userId,
            added_by_person_id: null,
            mls: null,
            mls_state: 'none',
            created_at: at,
            has_pasted_text: false,
          }),
          at,
        ]),
    },
  );
  return id;
}

/** Where a home stands for the buyer, with no signal. */
export function setHomeStatus(workspaceId: string, homeId: string, status: HomeStatus) {
  return change(
    'realestate.home.set_status',
    { workspaceId, homeId, status },
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE addon_phone_rows SET data = json_set(data, '$.status', ?), updated_at = ? WHERE id = ?`,
          [status, nowIso(), rowId('homes', homeId)],
        ),
    },
  );
}

/** Asks the MLS about a home: needs signal. */
export function lookUpHome(workspaceId: string, homeId: string) {
  return change('realestate.home.lookup', { workspaceId, homeId });
}

/** A match sent to the client's portal: it goes while fresh, and asks again after 30 minutes. */
export function sendMatch(workspaceId: string, matchId: string, userId: string) {
  return decideMatch('realestate.match.send', workspaceId, matchId, 'sent', userId);
}

/** A match the client never sees. */
export function dismissMatch(workspaceId: string, matchId: string, userId: string) {
  return decideMatch('realestate.match.dismiss', workspaceId, matchId, 'dismissed', userId);
}

function decideMatch(
  name: 'realestate.match.send' | 'realestate.match.dismiss',
  workspaceId: string,
  matchId: string,
  state: 'sent' | 'dismissed',
  userId: string,
) {
  const at = nowIso();
  return change(
    name,
    { workspaceId, matchId },
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE addon_phone_rows SET data = json_set(data, '$.state', ?, '$.decided_at', ?, '$.decided_by', ?),
             updated_at = ? WHERE id = ?`,
          [state, at, userId, at, rowId('feed_matches', matchId)],
        ),
    },
  );
}

/** One of our listings added to the buyer's homes: needs signal. */
export function addSuggestion(workspaceId: string, suggestionId: string) {
  return change('realestate.suggestion.add', { workspaceId, suggestionId });
}

/** One of our listings set aside for this buyer: needs signal. */
export function notAFit(workspaceId: string, suggestionId: string) {
  return change('realestate.suggestion.not_a_fit', { workspaceId, suggestionId });
}

/** A home on the tour seen or skipped, at the stop with no signal. */
export function recordVisit(
  workspaceId: string,
  stopId: string,
  status: 'visited' | 'skipped',
  note?: string,
) {
  const at = nowIso();
  return change(
    'realestate.tour.record_visit',
    { workspaceId, stopId, status, ...(note?.trim() ? { note: note.trim() } : {}) },
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE addon_phone_rows SET data = json_set(data, '$.status', ?, '$.visited_at', ?,
             '$.note', coalesce(?, json_extract(data, '$.note'))), updated_at = ? WHERE id = ?`,
          [
            status,
            status === 'visited' ? at : null,
            note?.trim() || null,
            at,
            rowId('tour_stops', stopId),
          ],
        ),
    },
  );
}

/**
 * What a client thought of a home at a stop, as the agent heard it. The stop is marked seen first when it isn't, since
 * HandsFreeOS takes feedback only on a home seen; the feedback waits for that.
 */
export async function giveFeedback(
  workspaceId: string,
  stop: {
    readonly id: string;
    readonly tourId: string;
    readonly homeId: string;
    readonly status: string;
  },
  dealId: string,
  personId: string,
  interest: TourInterest,
  userId: string,
  words?: string,
) {
  const seen =
    stop.status === 'visited' ? null : await recordVisit(workspaceId, stop.id, 'visited');
  const at = nowIso();
  const id = rowId('tour_feedback', `${stop.id}:${personId}`);
  const data = {
    tour_id: stop.tourId,
    stop_id: stop.id,
    home_id: stop.homeId,
    person_id: personId,
    interest,
    rating: null,
    words: words?.trim() || null,
    recorded_by: userId,
    updated_at: at,
  };
  return change(
    'realestate.tour.feedback',
    {
      workspaceId,
      stopId: stop.id,
      personId,
      interest,
      ...(words?.trim() ? { words: words.trim() } : {}),
    },
    {
      dependsOn: seen ? [seen.id] : [],
      optimistic: async (tx) => {
        // The server keeps one per stop and client; the phone's own stands in until it's handled.
        await tx.execute(
          `UPDATE addon_phone_rows SET data = json_patch(data, ?), updated_at = ?
           WHERE source = 'tour_feedback' AND record_id = ? AND json_extract(data, '$.stop_id') = ?
             AND json_extract(data, '$.person_id') = ?`,
          [JSON.stringify(data), at, dealId, stop.id, personId],
        );
        await tx.execute(
          `INSERT INTO addon_phone_rows (id, workspace_id, addon_id, source, record_id, data, updated_at)
           SELECT ?, ?, 'realestate', 'tour_feedback', ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM addon_phone_rows WHERE source = 'tour_feedback' AND record_id = ?
             AND json_extract(data, '$.stop_id') = ? AND json_extract(data, '$.person_id') = ?)`,
          [
            id,
            workspaceId,
            dealId,
            JSON.stringify({ ...data, created_at: at }),
            at,
            dealId,
            stop.id,
            personId,
          ],
        );
      },
    },
  );
}

export type NoteAbout = NonNullable<InputOf<'realestate.field_note.add'>['aboutKind']>;

/** A note taken in the field: typed, a recording or photos, kept with what it's about. */
export function addFieldNote(
  workspaceId: string,
  dealId: string,
  note: {
    readonly aboutKind: NoteAbout;
    readonly aboutId?: string;
    readonly body?: string;
    readonly audioFileId?: string;
    readonly photoFileIds?: readonly string[];
  },
  userId: string,
  dependsOn: readonly string[] = [],
) {
  const id = newId();
  const at = nowIso();
  const body = note.body?.trim() || undefined;
  return change(
    'realestate.field_note.add',
    {
      workspaceId,
      dealId,
      id,
      aboutKind: note.aboutKind,
      ...(note.aboutId ? { aboutId: note.aboutId } : {}),
      ...(body ? { body } : {}),
      ...(note.audioFileId ? { audioFileId: note.audioFileId } : {}),
      photoFileIds: [...(note.photoFileIds ?? [])],
    },
    {
      dependsOn,
      optimistic: (tx) =>
        tx.execute(INSERT_ROW, [
          rowId('field_notes', id),
          workspaceId,
          'field_notes',
          dealId,
          JSON.stringify({
            about_kind: note.aboutKind,
            about_id: note.aboutId ?? null,
            body: body ?? null,
            audio_file_id: note.audioFileId ?? null,
            transcript: null,
            transcript_state: note.audioFileId ? 'waiting' : 'none',
            photo_file_ids: note.photoFileIds ?? [],
            created_by: userId,
            noted_at: at,
          }),
          at,
        ]),
    },
  );
}

/**
 * A file kept on the phone for the deal (a photo, or a voice note's recording), on the photo track: it uploads when it
 * can, and a note that names it waits for it. Returns the upload's change id.
 */
export async function keepDealFile(
  workspaceId: string,
  dealId: string,
  file: {
    readonly fileId: string;
    readonly localName: string;
    readonly sizeBytes: number;
    readonly name?: string;
    readonly mimeType?: 'image/jpeg' | 'audio/mp4';
  },
): Promise<string> {
  const added = await changes.addPhoto(
    { workspaceId, recordType: 'custom_record', recordId: dealId },
    { localName: file.localName, sizeBytes: file.sizeBytes },
    { fileId: file.fileId, name: file.name, mimeType: file.mimeType },
  );
  return added.id;
}

/** A tour planned on the calendar: needs signal. */
export function planTour(input: InputOf<'realestate.tour.plan'>) {
  return change('realestate.tour.plan', input);
}

/** A tour's homes, in order: needs signal (the calendar's appointment changes). */
export function setTourStops(workspaceId: string, tourId: string, homeIds: readonly string[]) {
  return change('realestate.tour.set_stops', { workspaceId, tourId, homeIds: [...homeIds] });
}

/** A counter, or a better offer: needs signal; it goes to the other agent and the client's portal. */
export function addOfferVersion(input: InputOf<'realestate.offer.add_version'>) {
  return change('realestate.offer.add_version', input);
}

/** The offer's one-page summary, shared to the client's portal: needs signal. */
export function shareOfferSummary(workspaceId: string, offerId: string) {
  return change('realestate.offer.share_summary', { workspaceId, offerId });
}

/** Comps from the MLS for a CMA: needs signal. */
export function findComps(workspaceId: string, cmaId: string) {
  return change('realestate.cma.find_comps', { workspaceId, cmaId });
}

/** The AI's summary of a CMA: needs signal. */
export function requestCmaSummary(workspaceId: string, cmaId: string) {
  return change('realestate.cma.request_summary', { workspaceId, cmaId });
}
