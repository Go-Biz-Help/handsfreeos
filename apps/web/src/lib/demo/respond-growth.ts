import {
  fold,
  kindRank,
  messageTitle,
  noteLines,
  probesOut,
  searchHref,
  searchProbes,
  snippetOf,
  type SearchGroup,
  type SearchHit,
} from '@hfos/core';
import type { Ok } from '../api/types';
import {
  businessOf,
  demoId,
  fullName,
  phoneDisplay,
  type DemoImport,
  type DemoLeadRecord,
  type DemoOffer,
  type DemoPerson,
  type DemoReview,
  type DemoWorld,
} from './world';

/**
 * The made-up answers for growing the business: Google reviews and their answers, this month's offers, the leads on
 * the Pipeline board, the people a spreadsheet brought in, and what Search finds in the scene's notes and texts.
 * Each merges the scene's rows into the real answer. respond.ts dispatches to these.
 */

type Reviews = Ok<'/v1/queries/review.list'>;
type Offers = Ok<'/v1/queries/offer.list'>;
type Board = Ok<'/v1/queries/lead.board'>;
type BoardCard = Board['stages'][number]['leads'][number];
type People = Ok<'/v1/queries/person.list'>;
type PersonRow = People['items'][number];
type ImportGet = Ok<'/v1/queries/import.get'>;
type Search = Ok<'/v1/queries/search.everything'>;

const iso = (ms: number) => new Date(ms).toISOString();
const GOOGLE_PLACE = demoId(0xa025);
const TAG_COLORS = ['#2563eb', '#0d9488', '#d97706', '#7c3aed', '#db2777'];

// -------------------------------------------------------------------------------------------------------- reviews

function reviewRow(r: DemoReview): Reviews['reviews'][number] {
  return {
    id: r.id,
    provider: 'google',
    authorName: r.author,
    authorPhotoUrl: null,
    rating: r.stars,
    sentiment: null,
    body: r.body,
    postedAt: iso(r.postedAt),
    url: null,
    personId: null,
    replyBody: r.reply?.body ?? null,
    replyPostedAt: r.reply ? iso(r.reply.at) : null,
    canReply: true,
  };
}

/** The real reviews with the scene's on top, newest first, and Google connected if the scene says so. */
export function reviewsWith(w: DemoWorld, got: Reviews): Reviews {
  const mine = [...w.reviews].sort((a, b) => b.postedAt - a.postedAt).map(reviewRow);
  const google = got.connections.some((c) => c.provider === 'google');
  const stars = w.reviews.reduce((n, r) => n + r.stars, 0);
  const s = got.summary;
  const rated = s.averageRating === null ? 0 : s.total;
  return {
    reviews: [...mine, ...got.reviews],
    connections:
      w.reviewsConnected && !google
        ? [
            {
              id: GOOGLE_PLACE,
              provider: 'google',
              status: 'connected',
              displayName: businessOf(w),
              publicUrl: null,
              lastSyncedAt: iso(Date.now() - 4 * 60_000),
              lastError: null,
            },
            ...got.connections,
          ]
        : got.connections,
    summary: {
      ...s,
      total: s.total + mine.length,
      averageRating: mine.length
        ? Math.round((((s.averageRating ?? 0) * rated + stars) / (rated + mine.length)) * 100) / 100
        : s.averageRating,
      unanswered: s.unanswered + w.reviews.filter((r) => !r.reply).length,
    },
  };
}

// --------------------------------------------------------------------------------------------------------- offers

/** Live today, still to come, or over, by the business's own date. */
function offerState(o: DemoOffer, w: DemoWorld): Offers['offers'][number]['state'] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: w.state.timeZone }).format(new Date());
  if (o.startsOn > today) return 'upcoming';
  if (o.endsOn < today) return 'ended';
  return 'live';
}

export const offersWith = (w: DemoWorld, got: Offers): Offers => ({
  offers: [
    ...w.offers.map((o) => ({
      id: o.id,
      name: o.name,
      details: o.details,
      startsOn: o.startsOn,
      endsOn: o.endsOn,
      state: offerState(o, w),
      updatedAt: iso(o.at),
    })),
    ...got.offers,
  ],
});

// ----------------------------------------------------------------------------------------------------- the board

/** The scene's leads on the Pipeline board, each in the real stage of its name (or the first open one), on top. */
export function boardWith(w: DemoWorld, got: Board): Board {
  const mine = w.leads.filter((l) => l.onBoard);
  const firstOpen = got.stages.find((s) => s.kind === 'open');
  return {
    ...got,
    stages: got.stages.map((stage) => {
      const here = mine.filter(
        (l) => (got.stages.find((s) => s.name === l.stage) ?? firstOpen)?.id === stage.id,
      );
      if (!here.length) return stage;
      return {
        ...stage,
        count: stage.count + here.length,
        valueCents: stage.valueCents + here.reduce((n, l) => n + l.valueCents, 0),
        leads: [...here.map((l) => boardCard(w, got, stage, l)), ...stage.leads],
      };
    }),
  };
}

function boardCard(
  w: DemoWorld,
  got: Board,
  stage: Board['stages'][number],
  l: DemoLeadRecord,
): BoardCard {
  return {
    id: l.id,
    title: l.title,
    pipelineId: got.pipeline.id,
    stageId: stage.id,
    stageName: stage.name,
    stageKind: stage.kind,
    status: 'open',
    person: { id: l.person.id, fullName: fullName(l.person), archived: false },
    company: null,
    valueCents: l.valueCents,
    source: l.source,
    assignee: { id: w.state.me.id, fullName: w.state.me.name },
    expectedCloseOn: null,
    nextAction: null,
    nextActionAt: null,
    needsNextAction: false,
    nextActionOverdue: false,
    lastContactAt: iso(l.at),
    wonAt: null,
    lostAt: null,
    lostReason: null,
    position: 0,
    tags: [],
    stageEnteredAt: iso(l.at),
    archivedAt: null,
    createdAt: iso(l.at),
    updatedAt: iso(l.at),
  };
}

// ------------------------------------------------------------------------------------------- people, and imports

/** A tag by its name, with a made-up id and color that stay the same for that name. */
function tagRef(name: string) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) % 0xfff;
  return { id: demoId(0xc0000 + n), name, color: TAG_COLORS[n % TAG_COLORS.length]! };
}

function personRow(p: DemoPerson, at: number, w: DemoWorld): PersonRow {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    fullName: fullName(p),
    email: p.email ?? null,
    phone: phoneDisplay(p.phone),
    phoneE164: p.phone,
    phoneAlt: null,
    address: {
      line1: null,
      line2: null,
      city: p.city,
      state: 'TX',
      postalCode: null,
      country: 'US',
    },
    otherEmails: [],
    otherPhones: [],
    otherAddresses: [],
    source: 'Import',
    company: null,
    owner: { id: w.state.me.id, fullName: w.state.me.name },
    team: [],
    tags: p.tags.map(tagRef),
    openLeads: 0,
    lastActivityAt: iso(at),
    archivedAt: null,
    createdAt: iso(at),
    updatedAt: iso(at),
    client: p.customerSince !== null,
  };
}

/** The contacts list with everyone the scene's import brought in, on top: only the plain list, unfiltered. */
export function peopleWith(w: DemoWorld, got: People): People {
  const mine = w.imports.flatMap((i) => i.people.map((p) => personRow(p, i.at, w)));
  return { ...got, items: [...mine, ...got.items] };
}

/** The scene's import, done: every row came in. */
export function importOf(w: DemoWorld, i: DemoImport): ImportGet {
  const n = i.people.length;
  return {
    import: {
      id: i.id,
      kind: 'people',
      fileName: i.fileName,
      status: 'done',
      mapping: {},
      options: { onMatch: 'skip' },
      totalRows: n,
      processedRows: n,
      createdCount: n,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      lastError: null,
      startedAt: iso(i.at),
      finishedAt: iso(i.at + 4_000),
      createdBy: { id: w.state.me.id, fullName: w.state.me.name },
      createdAt: iso(i.at),
    },
    errors: [],
  };
}

// --------------------------------------------------------------------------------------------------------- search

/** Whether every word typed is in the text, accents folded, as the server's searchers match. */
const holdsAll = (text: string, words: readonly string[]) => {
  const all = fold(text);
  return words.length > 0 && words.every((word) => all.includes(word));
};

/** The scene's notes and texts that hold every word typed, as Search's Notes and Messages rows. */
function sceneHits(w: DemoWorld, q: string): Map<string, SearchHit[]> {
  const p = searchProbes(q);
  const found = new Map<string, SearchHit[]>();
  const add = (kind: string, hit: SearchHit) => found.set(kind, [...(found.get(kind) ?? []), hit]);
  for (const n of w.notes) {
    if (!holdsAll(n.body, p.folded)) continue;
    add('notes', {
      kind: 'notes',
      id: n.id,
      title: noteLines(n.body).title,
      subtitle: null,
      badges: [],
      why: { field: 'note', label: null, snippet: snippetOf(n.body, p), page: null },
      tier: 4,
      exact: false,
      at: iso(n.at),
      href: searchHref(w.workspaceId, {
        type: 'activity',
        id: n.id,
        on: { type: 'person', id: n.person.id },
      }),
      contact: null,
      amount: null,
      facts: { on: fullName(n.person) },
      duplicateOf: null,
    });
  }
  for (const c of w.conversations) {
    const matched = c.messages.filter((m) => holdsAll(m.body, p.folded));
    const best = matched[matched.length - 1];
    if (!best) continue;
    const who = fullName(c.person);
    const channel = c.channel ?? 'sms';
    add('messages', {
      kind: 'messages',
      id: c.id,
      title: messageTitle(channel, best.direction, who),
      subtitle: null,
      badges: [],
      why: { field: 'message', label: null, snippet: snippetOf(best.body, p), page: null },
      tier: 4,
      exact: false,
      at: iso(best.at),
      href: searchHref(w.workspaceId, {
        type: 'conversation',
        id: c.id,
        messageId: best.id,
        at: iso(best.at),
      }),
      contact: { personId: c.person.id, phoneE164: c.person.phone, email: c.person.email ?? null },
      amount: null,
      facts: { channel, direction: best.direction, who, matches: matched.length },
      duplicateOf: null,
    });
  }
  return found;
}

/**
 * Search everything, with the scene's notes and texts in their groups: null when none of them hold what's typed,
 * so the real answer goes through as it is. Close matches give way to the scene's, which hold every word.
 */
export async function searchWith(
  w: DemoWorld,
  body: Record<string, unknown>,
  real: () => Promise<Response>,
): Promise<Search | Response | null> {
  const q = typeof body['q'] === 'string' ? body['q'].trim() : '';
  if (q.length < 3 || (!w.notes.length && !w.conversations.length)) return null;
  const kinds = Array.isArray(body['kinds']) ? (body['kinds'] as string[]) : null;
  const found = sceneHits(w, q);
  for (const kind of found.keys()) if (kinds && !kinds.includes(kind)) found.delete(kind);
  if (!found.size) return null;
  const res = await real();
  if (!res.ok) return res;
  const got = (await res.json()) as Search;
  const groups: SearchGroup[] = got.close ? [] : [...got.groups];
  let added = 0;
  for (const [kind, hits] of found) {
    added += hits.length;
    const at = groups.findIndex((g) => g.kind === kind);
    const had = at >= 0 ? groups[at]! : null;
    const group: SearchGroup = {
      kind,
      label: null,
      icon: null,
      total: (had?.total ?? 0) + hits.length,
      capped: had?.capped ?? false,
      complete: had?.complete ?? true,
      searchedBack: had?.searchedBack ?? null,
      unavailable: null,
      items: [...hits, ...(had?.items ?? [])],
    };
    if (had) groups[at] = group;
    else groups.push(group);
  }
  groups.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  return {
    ...got,
    q,
    probes: probesOut(searchProbes(q)),
    total: (got.close ? 0 : got.total) + added,
    groups,
    close: false,
    noneActive: false,
  };
}
