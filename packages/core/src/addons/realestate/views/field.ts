/**
 * In the field, from a phone's copy (Real Estate round six): a deal's field notes and its final walkthrough, as
 * `realestate.field_notes` and `realestate.walkthrough` answer them (ops/field.ts), worked out from the rows the phone
 * keeps. Both are made and checked on the phone with no signal; these read back what it holds, the phone's own changes
 * among them once they're written to its copy. `packages/core/test/addons/realestate-phone-closing.test.ts` holds each
 * to the server's answer.
 *
 * A deal kept as its summary (someone who sees every deal, not on this one) has neither: `full` is false, with no
 * notes and no walkthrough until signal.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { FieldNotesOutput, WalkthroughGetOutput } from '../schemas';
import { walkthroughSummary } from '../walkthrough';
import { byTimeDesc, num, str } from './columns';
import { holdsWhole, isoOr } from './deal-facts';
import { byText, iso, text, type RealestateCopy } from './synced';

export type FieldNote = z.infer<typeof FieldNotesOutput>['notes'][number];
export type FieldNotesView = z.infer<typeof FieldNotesOutput> & { readonly full: boolean };
export type WalkthroughView = z.infer<typeof WalkthroughGetOutput> & { readonly full: boolean };
type Walkthrough = NonNullable<WalkthroughView['walkthrough']>;
type WalkthroughItem = Walkthrough['items'][number];

/** As many as the server sends at once. */
const NOTES_AT_ONCE = 200;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const newestFirst =
  (key: string) => (a: { id: string; data: Readonly<Record<string, unknown>> }, b: typeof a) =>
    byTimeDesc(a.data[key], b.data[key]) || byText(b.id, a.id);

/** The deal's field notes, newest first; or null when the phone doesn't hold the deal. */
export function fieldNotesOfCopy(
  copy: RealestateCopy,
  dealId: string,
  filter: { readonly aboutKind?: FieldNote['aboutKind']; readonly aboutId?: string },
  ctx: { readonly userId: string | null },
): FieldNotesView | null {
  if (!copy.deals.has(dealId)) return null;
  const full = holdsWhole(copy, dealId, ctx.userId);
  const notes = full ? [...copy.rows('field_notes', dealId)] : [];
  return {
    full,
    notes: notes
      .filter(
        ({ data: n }) =>
          (!filter.aboutKind || text(n.about_kind) === filter.aboutKind) &&
          (!filter.aboutId || text(n.about_id) === filter.aboutId),
      )
      .sort(newestFirst('noted_at'))
      .slice(0, NOTES_AT_ONCE)
      .map(({ id, data: n }) => ({
        id,
        aboutKind: (text(n.about_kind) ?? 'deal') as FieldNote['aboutKind'],
        aboutId: text(n.about_id),
        body: str(n.body),
        audioFileId: text(n.audio_file_id),
        transcript: str(n.transcript),
        transcriptState: (text(n.transcript_state) ?? 'none') as FieldNote['transcriptState'],
        photoFileIds: strings(n.photo_file_ids),
        createdBy: text(n.created_by),
        notedAt: isoOr(n.noted_at) ?? iso(0),
      })),
  };
}

/**
 * The deal's walkthrough: the one not finished, else the last one finished, with each thing to check in the order
 * it's walked. Null when the phone doesn't hold the deal.
 */
export function walkthroughOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): WalkthroughView | null {
  if (!copy.deals.has(dealId)) return null;
  const full = holdsWhole(copy, dealId, ctx.userId);
  const [w] = (full ? [...copy.rows('walkthroughs', dealId)] : []).sort(
    (a, b) =>
      Number(text(b.data.state) !== 'done') - Number(text(a.data.state) !== 'done') ||
      newestFirst('created_at')(a, b),
  );
  if (!w) return { full, walkthrough: null };
  const items = copy
    .rows('walkthrough_items', dealId)
    .filter((i) => text(i.data.walkthrough_id) === w.id)
    .sort((a, b) => (num(a.data.position) ?? 0) - (num(b.data.position) ?? 0) || byText(a.id, b.id))
    .map(({ id, data: i }): WalkthroughItem => ({
      id,
      source: (text(i.source) ?? 'added') as WalkthroughItem['source'],
      sourceRef: text(i.source_ref),
      title: str(i.title) ?? '',
      detail: str(i.detail),
      state: (text(i.state) ?? 'unchecked') as WalkthroughItem['state'],
      note: str(i.note),
      photoFileIds: strings(i.photo_file_ids),
      checkedBy: text(i.checked_by),
      checkedAt: isoOr(i.checked_at),
      dutyId: text(i.duty_id),
    }));
  const d = w.data;
  return {
    full,
    walkthrough: {
      id: w.id,
      state: (text(d.state) ?? 'planned') as Walkthrough['state'],
      appointmentId: text(d.appointment_id),
      scheduledAt: isoOr(d.scheduled_at),
      startedAt: isoOr(d.started_at),
      finishedAt: isoOr(d.finished_at),
      clientsAgreedAt: isoOr(d.clients_agreed_at),
      summary: walkthroughSummary(items.map((i) => i.state)),
      items,
    },
  };
}
