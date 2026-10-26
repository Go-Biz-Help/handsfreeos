/**
 * The Assistant's main offer tools (packages/core/src/assistant/tools-main-offer.ts): what each card says, and what
 * runs once the person presses Confirm. The commands are Settings → Main offer's, run as the person; the score and a
 * try are the builder's own (../main-offer/routes.ts), so they read the draft as it's kept, follow the owner's
 * direction and count against the person's AI limit, as a press of Score my offer or Make a try does.
 *
 * A change saves to the draft and is scored there. It goes live only when asked, and then only once every part
 * clears the bar or the person gave their reason (Use it anyway): the same rule the screen holds to.
 */
import {
  clearsBar,
  HfosError,
  MAIN_OFFER_BAR,
  mainOfferBoxLabel,
  MainOfferParts,
  missingParts,
  missingWords,
  partSays,
  partWords,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  settingsPath,
  underBar,
  withPart,
  type MainOfferGetOutput,
  type MainOfferScore,
  type MainOfferTryOut,
  type ScoredPart,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { AI_UNAVAILABLE_MESSAGE } from '../ai/ask';
import { offerScore, offerTry, type MainOfferDeps } from '../main-offer/routes';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, query } from './tools-read';
import { settingsCard } from './tools-settings-calendar';

type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
const strings = (v: unknown) =>
  Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : undefined;

const offerOf = (db: Db, ctx: ToolContext) => query<MainOfferGetOutput>(db, ctx, 'main_offer.get');

const hrefOf = (ctx: ToolContext) => settingsPath(ctx.workspaceId, 'main_offer');

/** What a change starts from: the draft, else the live version (as the builder starts one), else nothing. */
const startingParts = (offer: MainOfferGetOutput): MainOfferParts =>
  offer.draft?.parts ?? offer.live?.parts ?? MainOfferParts.parse({});

const nextVersion = (offer: MainOfferGetOutput) => (offer.live?.version ?? 0) + 1;

/** The same refusal the commands give while no add-on that uses the offer is on, before any card is drawn. */
function inUse(offer: MainOfferGetOutput): void {
  if (!offer.inUse)
    throw HfosError.rule(
      'main_offer_not_in_use',
      409,
      `Your main offer comes with ${offer.comesWith.join(' or ') || 'an add-on'}, which isn’t on in this business. An owner or admin can turn it on in Settings → Add-ons.`,
    );
}

interface Change {
  readonly path: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

const listWords = (xs: readonly string[] | undefined) =>
  (xs ?? []).filter((x) => x.trim()).join(' · ');

/** Each box, list and result the model asked to change that says something new, in the builder's order. */
function changesOf(parts: MainOfferParts, args: Args): Change[] {
  const changes: Change[] = [];
  const boxes = Array.isArray(args['boxes'])
    ? (args['boxes'] as { path: string; words: string }[])
    : [];
  for (const b of boxes) {
    const before = partWords(parts, b.path).trim();
    const after = b.words.trim();
    if (before !== after)
      changes.push({ path: b.path, label: mainOfferBoxLabel(b.path), before, after });
  }
  const steps = strings(args['steps']);
  if (steps && listWords(steps) !== listWords(parts.method.steps))
    changes.push({
      path: 'method.steps',
      label: mainOfferBoxLabel('method.steps'),
      before: listWords(parts.method.steps),
      after: listWords(steps),
    });
  const proof = strings(args['proof']);
  if (proof && listWords(proof) !== listWords(parts.proof))
    changes.push({
      path: 'proof',
      label: mainOfferBoxLabel('proof'),
      before: listWords(parts.proof),
      after: listWords(proof),
    });
  return changes;
}

/** The offer with the model's changes in; everything it didn't name as it was. */
function withChanges(parts: MainOfferParts, args: Args): MainOfferParts {
  let next = parts;
  const boxes = Array.isArray(args['boxes'])
    ? (args['boxes'] as { path: string; words: string }[])
    : [];
  for (const b of boxes) next = withPart(next, b.path, b.words.trim());
  const steps = strings(args['steps']);
  if (steps) next = { ...next, method: { ...next.method, steps } };
  const proof = strings(args['proof']);
  if (proof) next = { ...next, proof };
  return next;
}

/** "Who 8, Outcome 7, …": every part's score in a line. */
const scoresLine = (score: MainOfferScore) =>
  SCORED_PARTS.map((p) => `${SCORED_PART_LABELS[p]} ${score.parts[p].score}`).join(', ');

/** "Guarantee (6)": the parts under the bar, lowest first. */
const underWords = (parts: readonly ScoredPart[], score: MainOfferScore) =>
  parts.map((p) => `${SCORED_PART_LABELS[p]} (${score.parts[p].score})`).join(', ');

/** What the model reads of a score: each part with why, what's holding it back and the fix, and what to change first. */
function scoreResult(score: MainOfferScore) {
  return {
    bar: MAIN_OFFER_BAR,
    clearsBar: clearsBar(score),
    parts: Object.fromEntries(
      SCORED_PARTS.map((p) => {
        const s = score.parts[p];
        return [p, { score: s.score, why: s.why, holding: s.holding ?? [], fix: s.fix ?? null }];
      }),
    ),
    weakest: score.weakest,
    fixFirst: score.fix,
  };
}

/** Scores the draft at this revision as Score my offer does; null with the words when it can't. */
async function scoreDraft(
  deps: MainOfferDeps | null,
  ctx: ToolContext,
  revision: number,
): Promise<{ score: MainOfferScore } | { cannot: string }> {
  if (!deps?.ai.provider) return { cannot: AI_UNAVAILABLE_MESSAGE };
  try {
    const { score } = await offerScore(deps, ctx.actor, {
      workspaceId: ctx.workspaceId,
      revision,
    });
    return { score };
  } catch (e) {
    if (e instanceof HfosError) return { cannot: e.message };
    throw e;
  }
}

/**
 * Puts the draft at this revision live once it's scored and clears the bar, or with the person's reason; otherwise
 * says what holds it, in words the model can pass on.
 */
async function goLive(
  db: Db,
  ctx: ToolContext,
  revision: number,
  parts: MainOfferParts,
  score: MainOfferScore,
  anyway: string | undefined,
): Promise<string> {
  const missing = missingParts(parts);
  if (missing.length) return `It isn’t live yet: it still needs ${missingWords(missing)}.`;
  const under = underBar(score);
  if (under.length && !anyway)
    return `It isn’t live yet: ${underWords(under, score)} ${under.length === 1 ? 'is' : 'are'} under the ${MAIN_OFFER_BAR} it needs. ${score.fix} Say if it should go live anyway, and why.`;
  const { version } = await command<{ version: number }>(db, ctx, 'main_offer.publish', {
    revision,
    ...(under.length ? { anyway } : {}),
  });
  return `Version ${version} is live.`;
}

export interface MainOfferConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    deps: MainOfferDeps | null,
  ): Promise<CommittedAction>;
}

const editMainOffer: MainOfferConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const offer = await offerOf(db, ctx);
    inUse(offer);
    const changes = changesOf(startingParts(offer), args);
    if (!changes.length)
      throw HfosError.rule(
        'main_offer_nothing_to_change',
        400,
        'That says just what the offer says now. Say which part to change, and what it should say.',
      );
    const live = args['goLive'] === true;
    const anyway = str(args['anyway']);
    const withWas = changes.length <= 4;
    return {
      card: settingsCard(toolCallId, 'edit_main_offer', {
        title: live
          ? `Change your main offer and put it live as version ${nextVersion(offer)}`
          : offer.draft
            ? 'Change your main offer’s draft'
            : 'Start a new draft of your main offer',
        fields: changes.flatMap((c) => [
          { label: c.label, value: c.after || 'Left empty' },
          ...(withWas && c.before ? [{ label: 'Was', value: c.before }] : []),
        ]),
        confirmLabel: live ? 'Change it and go live' : 'Save to the draft',
        warnings: [
          live
            ? {
                kind: 'note',
                text: anyway
                  ? `The AI scores it first. It goes live even with a part under ${MAIN_OFFER_BAR}, because: “${anyway}”.`
                  : `The AI scores it first. It goes live only if every part scores ${MAIN_OFFER_BAR} or more.`,
              }
            : {
                kind: 'note',
                text: offer.live
                  ? `The AI scores it. Version ${offer.live.version} keeps running until the draft goes live.`
                  : 'The AI scores it. Nothing goes live until you say so.',
              },
          ...(live && offer.live
            ? [
                {
                  kind: 'note',
                  text: 'People already reached keep hearing the version they were first pitched with.',
                },
              ]
            : []),
        ],
      }),
      result: { waiting: true, changes: changes.map((c) => c.path), goLive: live },
    };
  },

  async commit(db, ctx, args, deps) {
    const offer = await offerOf(db, ctx);
    const parts = withChanges(startingParts(offer), args);
    const { revision } = await command<{ revision: number }>(db, ctx, 'main_offer.save_draft', {
      revision: offer.revision,
      parts,
    });
    const href = hrefOf(ctx);
    const scored = await scoreDraft(deps, ctx, revision);
    if ('cannot' in scored)
      return {
        outcome: `Saved to the draft, but it couldn’t be scored: ${scored.cannot} It needs a score before it can go live.`,
        href,
        command: 'main_offer.save_draft',
      };
    const scores = `Scores: ${scoresLine(scored.score)}.`;
    if (args['goLive'] !== true)
      return { outcome: `Saved to the draft. ${scores}`, href, command: 'main_offer.save_draft' };
    const live = await goLive(db, ctx, revision, parts, scored.score, str(args['anyway']));
    return {
      outcome: `${live} ${scores}`,
      href,
      command: live.startsWith('Version') ? 'main_offer.publish' : 'main_offer.save_draft',
    };
  },
};

const mainOfferGoLive: MainOfferConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const offer = await offerOf(db, ctx);
    inUse(offer);
    const draft = offer.draft;
    if (!draft)
      throw HfosError.rule(
        'main_offer_no_draft',
        409,
        offer.live
          ? `There’s nothing new to put live: version ${offer.live.version} is what’s live. Say what to change first.`
          : 'There’s no main offer yet. Say what it should say first, or build it in Settings → Main offer.',
      );
    const anyway = str(args['anyway']);
    const under = draft.score ? underBar(draft.score) : [];
    return {
      card: settingsCard(toolCallId, 'main_offer_go_live', {
        title: `Put version ${nextVersion(offer)} of your main offer live`,
        fields: [
          ...SCORED_PARTS.map((p) => ({
            label: draft.score
              ? `${SCORED_PART_LABELS[p]} (${draft.score.parts[p].score})`
              : SCORED_PART_LABELS[p],
            value: partSays(draft.parts, p),
          })),
          { label: 'In one line', value: draft.parts.line ?? '' },
        ],
        confirmLabel: 'Go live',
        warnings: [
          !draft.score
            ? {
                kind: 'note',
                text: `The AI scores it first. It goes live only if every part scores ${MAIN_OFFER_BAR} or more${anyway ? `, or anyway, because: “${anyway}”` : ''}.`,
              }
            : under.length && anyway
              ? {
                  kind: 'note',
                  text: `${underWords(under, draft.score)} ${under.length === 1 ? 'is' : 'are'} under ${MAIN_OFFER_BAR}. It goes live anyway, because: “${anyway}”.`,
                }
              : under.length
                ? {
                    kind: 'note',
                    text: `${underWords(under, draft.score)} ${under.length === 1 ? 'is' : 'are'} under ${MAIN_OFFER_BAR}, so it won’t go live without a reason.`,
                  }
                : { kind: 'note', text: `Every part scores ${MAIN_OFFER_BAR} or more.` },
          ...(offer.live
            ? [
                {
                  kind: 'note',
                  text: 'People already reached keep hearing the version they were first pitched with.',
                },
              ]
            : []),
        ],
      }),
      result: { waiting: true, version: nextVersion(offer) },
    };
  },

  async commit(db, ctx, args, deps) {
    const offer = await offerOf(db, ctx);
    const href = hrefOf(ctx);
    if (!offer.draft)
      throw HfosError.rule(
        'main_offer_no_draft',
        409,
        'Someone put the draft live or threw it away in the meantime. Look at Settings → Main offer for where it is now.',
      );
    let score = offer.draft.score;
    if (!score) {
      const scored = await scoreDraft(deps, ctx, offer.revision);
      if ('cannot' in scored)
        return {
          outcome: `It isn’t live: it couldn’t be scored. ${scored.cannot}`,
          href,
          command: 'main_offer.publish',
        };
      score = scored.score;
    }
    const live = await goLive(
      db,
      ctx,
      offer.revision,
      offer.draft.parts,
      score,
      str(args['anyway']),
    );
    return {
      outcome: `${live} Scores: ${scoresLine(score)}.`,
      href,
      command: 'main_offer.publish',
    };
  },
};

const PART_NAMES = (take: readonly ScoredPart[]) => {
  const names = take.map((p) => SCORED_PART_LABELS[p].toLowerCase());
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

const manageMainOffer: MainOfferConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const offer = await offerOf(db, ctx);
    const action = String(args['action'] ?? '');
    // Names aren't scored or versioned, and the screen keeps them whether or not the offer is in use.
    if (action !== 'set_names') inUse(offer);
    switch (action) {
      case 'discard_draft': {
        if (!offer.draft)
          throw HfosError.rule('main_offer_no_draft', 409, 'There’s no draft to throw away.');
        return {
          card: settingsCard(toolCallId, 'manage_main_offer', {
            title: 'Throw away your main offer’s draft',
            fields: [
              { label: 'Started by', value: offer.draft.by?.name ?? '' },
              ...SCORED_PARTS.map((p) => ({
                label: SCORED_PART_LABELS[p],
                value: partSays(offer.draft!.parts, p),
              })),
            ],
            confirmLabel: 'Throw it away',
            warnings: [
              {
                kind: 'note',
                text: offer.live
                  ? `Version ${offer.live.version} stays live as it is.`
                  : 'There’s no live version, so the offer starts again from nothing.',
              },
            ],
          }),
          result: { waiting: true, action },
        };
      }
      case 'set_direction': {
        const direction = str(args['direction']) ?? '';
        if (direction === (offer.direction ?? ''))
          throw HfosError.rule(
            'main_offer_nothing_to_change',
            400,
            'That’s the direction it has now.',
          );
        return {
          card: settingsCard(toolCallId, 'manage_main_offer', {
            title: direction ? 'Change the direction for your offer' : 'Clear the direction',
            fields: [
              { label: 'Direction', value: direction || 'None' },
              { label: 'Was', value: offer.direction ?? '' },
            ],
            confirmLabel: 'Save it',
            warnings: [
              {
                kind: 'note',
                text: 'Every score and try follows it, so the draft is scored again against it.',
              },
            ],
          }),
          result: { waiting: true, action },
        };
      }
      case 'set_names': {
        const names = strings(args['names']) ?? [];
        return {
          card: settingsCard(toolCallId, 'manage_main_offer', {
            title: 'Change the names your business goes by',
            fields: [
              {
                label: 'Names',
                value: names.length ? names.join(', ') : `Just ${offer.businessName}`,
              },
              { label: 'Was', value: offer.names.join(', ') },
            ],
            confirmLabel: 'Save them',
            warnings: [
              {
                kind: 'note',
                text: 'Social Outreach’s profile check takes each one as your business’s.',
              },
            ],
          }),
          result: { waiting: true, action },
        };
      }
      case 'take_from_try': {
        const take = (Array.isArray(args['take']) ? args['take'] : []) as ScoredPart[];
        const found = await tryOf(db, ctx, str(args['tryId']));
        if (!take.length)
          throw HfosError.rule(
            'main_offer_nothing_to_change',
            400,
            'Say which parts to take from the try.',
          );
        return {
          card: settingsCard(toolCallId, 'manage_main_offer', {
            title: `Take the ${PART_NAMES(take)} from try ${found.number} into your draft`,
            fields: take.map((p) => ({
              label: `${SCORED_PART_LABELS[p]} (${found.score.parts[p].score})`,
              value: partSays(found.parts, p),
            })),
            confirmLabel: 'Take them in',
            warnings: [{ kind: 'note', text: 'The rest of the draft stays as it is.' }],
          }),
          result: { waiting: true, action },
        };
      }
      default:
        throw HfosError.rule('unknown_action', 400, 'Say what to do with the main offer.');
    }
  },

  async commit(db, ctx, args) {
    const offer = await offerOf(db, ctx);
    const href = hrefOf(ctx);
    switch (String(args['action'] ?? '')) {
      case 'discard_draft':
        await command(db, ctx, 'main_offer.discard_draft', {});
        return {
          outcome: 'The draft is thrown away',
          href,
          command: 'main_offer.discard_draft',
        };
      case 'set_direction':
        await command(db, ctx, 'main_offer.save_direction', {
          revision: offer.revision,
          direction: str(args['direction']) ?? '',
        });
        return { outcome: 'The direction is saved', href, command: 'main_offer.save_direction' };
      case 'set_names': {
        const { names } = await command<{ names: string[] }>(db, ctx, 'main_offer.save_names', {
          names: strings(args['names']) ?? [],
        });
        return {
          outcome: names.length
            ? `It goes by ${names.join(', ')}`
            : `It goes by ${offer.businessName}`,
          href,
          command: 'main_offer.save_names',
        };
      }
      default: {
        const take = args['take'] as ScoredPart[];
        const out = await command<{ lineFromTry: boolean }>(db, ctx, 'main_offer.try_apply', {
          revision: offer.revision,
          tryId: args['tryId'],
          take,
        });
        return {
          outcome: `The ${PART_NAMES(take)} ${take.length === 1 ? 'is' : 'are'} in the draft.${
            out.lineFromTry
              ? ''
              : ' The one line and the few words for messages need writing again for the mix.'
          } It needs scoring again before it goes live.`,
          href,
          command: 'main_offer.try_apply',
        };
      }
    }
  },
};

/** One of this round's tries, or a refusal that says what to do. */
async function tryOf(db: Db, ctx: ToolContext, id: string | undefined): Promise<MainOfferTryOut> {
  const { tries } = await query<{ tries: MainOfferTryOut[] }>(db, ctx, 'main_offer.tries');
  const found = tries.find((t) => t.id === id);
  if (!found)
    throw HfosError.rule(
      'main_offer_try_gone',
      409,
      'That try isn’t there anymore: tries are kept only until the next version goes live. Make a new one.',
    );
  return found;
}

export const mainOfferConfirmTools: Record<string, MainOfferConfirmTool> = {
  edit_main_offer: editMainOffer,
  main_offer_go_live: mainOfferGoLive,
  manage_main_offer: manageMainOffer,
};

type MainOfferAutoTool = (
  db: Db,
  ctx: ToolContext,
  args: Args,
  deps: MainOfferDeps | null,
) => Promise<ToolOutcome>;

/** The draft, or the words the model passes on when there's none. */
async function draftOf(db: Db, ctx: ToolContext, what: string) {
  const offer = await offerOf(db, ctx);
  inUse(offer);
  if (!offer.draft)
    throw HfosError.rule(
      'main_offer_no_draft',
      409,
      offer.live
        ? `There’s no draft to ${what}: version ${offer.live.version} is live as it is. Change a part of it first.`
        : `There’s no main offer yet to ${what}. Say what it should say first, or build it in Settings → Main offer.`,
    );
  return { offer, draft: offer.draft };
}

const scoreMainOffer: MainOfferAutoTool = async (db, ctx, _args, deps) => {
  const { offer } = await draftOf(db, ctx, 'score');
  const scored = await scoreDraft(deps, ctx, offer.revision);
  if ('cannot' in scored) throw HfosError.rule('main_offer_not_scored', 503, scored.cannot);
  return { result: scoreResult(scored.score) };
};

const tryMainOffer: MainOfferAutoTool = async (db, ctx, args, deps) => {
  const { offer } = await draftOf(db, ctx, 'write a try from');
  if (!deps?.ai.provider) throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
  const out = await offerTry(deps, ctx.actor, {
    workspaceId: ctx.workspaceId,
    revision: offer.revision,
    notes: (args['notes'] ?? {}) as Record<string, string>,
    keep: (args['keep'] ?? []) as ScoredPart[],
  });
  if (!out.saved || !out.try)
    throw HfosError.conflict(
      'Someone changed the draft while the AI wrote the try. Ask again to write one from it as it is now.',
      'main_offer_draft_moved',
    );
  const t = out.try;
  return {
    result: {
      tryId: t.id,
      number: t.number,
      changed: SCORED_PARTS.filter((p) => t.why[p]).map((p) => ({
        part: p,
        says: partSays(t.parts, p),
        why: t.why[p],
      })),
      line: t.parts.line ?? null,
      score: scoreResult(t.score),
      next: 'Nothing changed yet. Take the parts the person picks with manage_main_offer (take_from_try).',
    },
  };
};

export const mainOfferAutoTools: Record<string, MainOfferAutoTool> = {
  score_main_offer: scoreMainOffer,
  try_main_offer: tryMainOffer,
};

/** What the panel says while each one runs. */
export const mainOfferStepLabels: Record<string, string> = {
  edit_main_offer: 'Changing your main offer',
  main_offer_go_live: 'Getting your offer ready to go live',
  manage_main_offer: 'Changing your main offer',
  score_main_offer: 'Scoring your offer',
  try_main_offer: 'Writing a try of your offer',
};
