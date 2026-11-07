/**
 * The screens' own commands as the Assistant's tools (packages/core/src/assistant/screen-actions.ts): each runs as
 * the person, through the kernel, with the business's ids put on after the model's arguments. A change waits on a
 * card drawn from what it would be given, after the command is tried and rolled back, so a card its rules would
 * refuse now is never drawn; on Confirm it runs with the arguments the card was drawn from.
 */
import {
  chatSnippet,
  chatSnippetSrc,
  chatWidgetRotateKey,
  executeCommand,
  foundingApprove,
  FOUNDING_WORDS,
  foundingClaimPath,
  HfosError,
  money,
  registry,
  rehearseCommand,
  screenActionTools,
  VIDEO_LINK_DAYS,
  videoLinkCreate,
  walletAdjust,
  type CommandDef,
  type Permission,
  type RequestMeta,
  type ScreenActionTool,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { keptAnswer } from './committed';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { setupCard, setupInput, setupOutcome } from './setup-screens';
import { staffCardFields, staffCautions, staffKept } from './staff-cards';
import { cardFields } from './tools-addons';
import { query } from './tools-read';
import { ownArguments, scopeIds } from './tools-screen-reads';
import { settingsCard } from './tools-settings-calendar';
import { workflowScreenCards } from './tools-workflow';

type Args = Record<string, unknown>;

/** The most of an answer, in characters of JSON, the model reads whole. */
const MOST = 16_000;

let derived: ScreenActionTool[] | null = null;
/** Every one, from the registry, made once. */
export const allScreenActionTools = (): readonly ScreenActionTool[] =>
  (derived ??= screenActionTools(registry));

/** The ones a person may use: those their permissions allow, as the screens are; a staff one only for staff. */
export const screenActionToolsFor = (
  can: (permission: Permission) => boolean,
): ScreenActionTool[] => allScreenActionTools().filter((t) => can(t.permission));

let byName: ReadonlyMap<string, ScreenActionTool> | null = null;
/**
 * One by name, whether or not this person could be offered it now: what a waiting card is confirmed with. The kernel
 * checks the permission again when it runs.
 */
export const screenActionToolByName = (name: string): ScreenActionTool | undefined =>
  (byName ??= new Map(allScreenActionTools().map((t) => [t.name, t]))).get(name);

const meta = (ctx: ToolContext): RequestMeta => ({
  correlationId: ctx.correlationId,
  channel: 'assistant',
});

/**
 * The command's input for one call: the arguments, then the business's ids on top (audit AI-3): the business asked
 * in, the agency alone when it's asked of the whole agency, or the client business it names once that is checked to
 * be the agency's (scopeIds). A staff command looks across businesses, so the business it acts on is one of its own
 * arguments (screen-actions.ts) and is kept.
 */
async function inputOf(
  db: Db,
  tool: ScreenActionTool,
  args: Args,
  ctx: ToolContext,
): Promise<Args> {
  if (tool.staff) {
    const declared = new Set(Object.keys(tool.input.shape));
    return Object.fromEntries(Object.entries(args).filter(([k]) => declared.has(k)));
  }
  return { ...ownArguments(tool, args), ...(await scopeIds(db, ctx, tool, args)) };
}

/**
 * The card's line for which business an agency's change is in, when that isn't simply the one asked in: the client
 * business it names, or the whole agency.
 */
async function whereLine(
  db: Db,
  ctx: ToolContext,
  tool: ScreenActionTool,
  input: Args,
): Promise<{ label: string; value: string } | null> {
  if (tool.agencyDoor && !input['workspaceId'])
    return { label: 'For', value: 'The whole agency, as Agency area → Migrations does it' };
  if (!tool.forBusiness || typeof input['workspaceId'] !== 'string') return null;
  const me = await query<{ workspaces: { id: string; name: string }[] }>(db, ctx, 'account.me');
  const name = me.workspaces.find((w) => w.id === input['workspaceId'])?.name;
  return name ? { label: 'Business', value: name } : null;
}

/** What the model reads back: the command's answer, cut short when it is too long to read. */
function answerOf(output: unknown): Args {
  const json = JSON.stringify(output ?? null);
  return json.length <= MOST
    ? { data: output ?? null }
    : {
        data: `${json.slice(0, MOST)}…`,
        cutShort: true,
        note: 'That was too long to read whole.',
      };
}

/** A change of risk 0 (setting a note aside, marking a notification opened): through the kernel, now. */
export async function runScreenAction(
  db: Db,
  tool: ScreenActionTool,
  args: Args,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (tool.autonomy !== 'auto') throw new Error(`${tool.name} waits for the person’s OK`);
  const done = await executeCommand(
    db,
    tool.command,
    await inputOf(db, tool, args, ctx),
    ctx.actor,
    meta(ctx),
  );
  return {
    result: { done: true, ...answerOf(done.output) },
    command: tool.command.name,
    record: { outcome: 'Done', command: tool.command.name },
  };
}

/**
 * A change that waits for the person's OK: a card saying what it does and what it would be given, with its warning
 * when it costs something or can't be taken back. The command's own schema checks the arguments first, then it is
 * tried and rolled back.
 */
export async function prepareScreenAction(
  db: Db,
  tool: ScreenActionTool,
  args: Args,
  ctx: ToolContext,
  toolCallId: string,
  /** The web app's address, for the address of the business's page the setup's chat goes on. */
  webUrl = '',
): Promise<PreparedAction> {
  // The guided setup's saves take the screens' whole answers: the model's go over the ones kept (setup-screens.ts).
  // A staff command gets what its screen puts on, and keeps what the model leaves out (staff-cards.ts).
  const given = {
    ...(await inputOf(db, tool, args, ctx)),
    ...(tool.staff ? await staffKept(db, ctx, tool, args, toolCallId) : {}),
  };
  const setup = await setupInput(db, ctx, tool, given, webUrl);
  const input = setup?.input ?? given;
  const checked = tool.command.input.safeParse(input);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    throw HfosError.validation(
      issues,
      issues[0]?.message ??
        `Some of that doesn’t fit what this takes. Check the details and call ${tool.name} again.`,
    );
  }
  const tried = await rehearseCommand(db, tool.command, input, ctx.actor, meta(ctx));
  // Drawn from the answers as the command reads them, so one it would drop (a key it doesn't take) never shows.
  if (setup) return setupCard(toolCallId, tool, { ...setup, input: checked.data as Args }, tried);
  // A command whose screen says it in a dialog of its own (Publish, Restore, Run test) is drawn the way it says it.
  const own = workflowScreenCards[tool.command.name];
  if (own) return own.prepare(db, ctx, args, { name: tool.name, toolCallId });
  const shown = tool.input.safeParse(args);
  // Which business it's in goes on its own line, by name, never as the id or the door it was asked through. A staff
  // card names the business, person, ticket or affiliate by name, from what will run, and says amounts in dollars.
  const fields = tool.staff
    ? await staffCardFields(db, ctx, tool, checked.data as Args)
    : cardFields(tool, ownArguments(tool, shown.success ? (shown.data as Args) : args));
  const where = await whereLine(db, ctx, tool, input);
  const cautions = [
    ...(tool.warning ? [tool.warning] : []),
    ...(tool.staff ? await staffCautions(db, ctx, tool, input) : []),
  ];
  return {
    card: settingsCard(toolCallId, tool.name, {
      title: 'Do this?',
      fields: where ? [...fields.slice(0, 1), where, ...fields.slice(1, 9)] : fields,
      confirmLabel: 'Confirm',
      warnings: cautions.map((text) => ({ kind: 'caution', text })),
    }),
    result: { waiting: true, what: tool.description },
  };
}

/** What the card says this once (`now`), and what is kept in its place (`kept`). */
interface PassedOn {
  readonly now: string;
  readonly kept: string;
}

const NOT_KEPT = 'showed on this card once, when you confirmed, and isn’t kept.';

/**
 * What a person must pass on from a command that shows it only once (its `shownOnce`), as the screens hand it over:
 * the founding claim link to email, the link asking a customer for a video. A path is made a whole link with the
 * rest of what the model reads (tools-write.ts), on the business's own domain when it is a public page; the claim
 * link is the app's own, so it goes on `webUrl` here, as the Admin area's dialog does.
 */
const PASS_ON: Readonly<Record<string, (output: Args, webUrl: string) => PassedOn | null>> = {
  // By the commands' own names: these stay screen actions (coverage.ts), not tools of their own.
  [foundingApprove.name]: (o, webUrl) => {
    const token = o['claimToken'];
    const until = o['expiresAt'];
    if (typeof token !== 'string' || typeof until !== 'string') return null;
    const works = FOUNDING_WORDS.linkWorks(until);
    return {
      now: `Approved, and their seat is held. Copy this claim link into an email to them now. ${works} It isn’t shown again: ${webUrl}${foundingClaimPath(token)}`,
      kept: `Approved, and their seat is held. The claim link ${NOT_KEPT} ${works}`,
    };
  },
  [videoLinkCreate.name]: (o) => {
    const path = o['path'];
    if (typeof path !== 'string') return null;
    return {
      now: `Made the link. Text it to them so they can send you a video. It lasts ${VIDEO_LINK_DAYS} days and isn’t shown again: ${path}`,
      kept: `Made a link for them to send a video. It ${NOT_KEPT}`,
    };
  },
};

/**
 * What a card says once done in place of "Done", when what the command made is something to use straight away: a
 * website chat's new key, with the snippet Add it to your site now copies. Its address goes as a path, which the
 * executor writes out whole on the business's own domain when one is serving, as the screen does.
 */
const SAID_WHEN_DONE: Readonly<Record<string, (output: Args) => string | null>> = {
  [chatWidgetRotateKey.name]: (o) =>
    typeof o['publicKey'] === 'string'
      ? `Done. The snippet on the site stopped working: paste this one in its place, just before </body> on every page. ${chatSnippet(chatSnippetSrc('', o['publicKey']))}`
      : null,
  // The same card confirmed twice is the same credit, recorded once (its reference is the card's).
  [walletAdjust.name]: (o) =>
    o['recorded'] === false
      ? 'That credit was already on their statement, so nothing new went on.'
      : typeof o['balanceCents'] === 'number'
        ? `Done. Their balance is now ${money(o['balanceCents'])}.`
        : null,
};

/** Any other command's one-time link or code, should one be offered: said the same plain way. */
function passedOn(command: CommandDef, output: unknown, webUrl: string): PassedOn | null {
  if (!command.shownOnce?.length || !output || typeof output !== 'object') return null;
  const o = output as Args;
  const own = PASS_ON[command.name];
  if (own) return own(o, webUrl);
  const value = ['path', 'code'].find(
    (k) => command.shownOnce!.includes(k) && typeof o[k] === 'string',
  );
  return value
    ? {
        now: `Done. It isn’t shown again, so copy it now: ${String(o[value])}`,
        kept: `Done. What it made ${NOT_KEPT}`,
      }
    : null;
}

/**
 * The person pressed Confirm: the command runs through the kernel, which checks the permission again. Its answer is
 * kept for the model, and anything shown only once goes to the card alone (routes.ts).
 */
export async function commitScreenAction(
  db: Db,
  tool: ScreenActionTool,
  args: Args,
  ctx: ToolContext,
  /** The web app's address, for a link that is the app's own (the founding claim link). */
  webUrl = '',
  /** The card's own id, which a staff credit's reference is made from, as it was when the card was drawn. */
  toolCallId = '',
): Promise<CommittedAction> {
  // Over the answers kept now, so only what the card showed changing changes.
  const given = {
    ...(await inputOf(db, tool, args, ctx)),
    ...(tool.staff ? await staffKept(db, ctx, tool, args, toolCallId) : {}),
  };
  const setup = await setupInput(db, ctx, tool, given, webUrl);
  const done = await executeCommand(db, tool.command, setup?.input ?? given, ctx.actor, meta(ctx));
  // The command has run by now, so a look-up for its words that fails falls back to the plain answer below, never
  // to a refusal saying nothing changed.
  const own = workflowScreenCards[tool.command.name];
  const said = own ? await own.done(db, ctx, args, done.output as Args).catch(() => null) : null;
  if (said) {
    return {
      outcome: said.outcome,
      href: said.href,
      command: tool.command.name,
      answer: keptAnswer(said.answer ?? done.output, tool.command.shownOnce),
    };
  }
  const once = passedOn(tool.command, done.output, webUrl);
  const made = setup
    ? setupOutcome(done.output)
    : (SAID_WHEN_DONE[tool.command.name]?.((done.output ?? {}) as Args) ?? null);
  return {
    outcome: once?.kept ?? made ?? 'Done',
    href: null,
    command: tool.command.name,
    answer: keptAnswer(done.output, tool.command.shownOnce),
    ...(once ? { shownOnce: once.now } : {}),
  };
}

/** What the panel says while one runs. */
export const screenActionStep = (tool: ScreenActionTool) =>
  tool.autonomy === 'auto' ? 'Working on it' : 'Preparing it for your OK';
