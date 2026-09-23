/**
 * Ideas, the roadmap and What's new (0102): a board with something on it. Every change goes through the
 * commands, so the counts are the database's, the story under each idea is real, and the followers' emails reach
 * Mailpit like anybody else's.
 * - Seven ideas from four businesses: one planned (Dale's "on the way" texts, with a note from Chris), one being
 *   built (Renée's QuickBooks sync, which Dale's own duplicate was merged into), one shipped in What's new (Tom's
 *   photos on estimates), one plainly not planned, and two still under review — one with a question from the team.
 * - What's new: three published entries (new, improved, fixed) and a draft only the team sees.
 */
import {
  executeCommand,
  ideaComment,
  ideaMerge,
  ideaSetStatus,
  ideaShare,
  ideaVote,
  whatsNewPublish,
  whatsNewSave,
  type CommandDef,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';

export interface SeedIdeasDeps {
  readonly api: Db;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
}

interface Person {
  readonly user: TestUser;
  /** The business they share and vote from. */
  readonly workspaceId: string;
}

export interface SeededIdeas {
  readonly ideas: number;
  readonly published: number;
}

export async function seedIdeas(
  deps: SeedIdeasDeps,
  people: {
    /** HandsFreeOS's own: answers ideas and runs the roadmap. */
    readonly chris: TestUser;
    readonly dale: Person;
    readonly priya: Person;
    readonly marco: Person;
    readonly renee: Person;
    readonly tom: Person;
    readonly riley: Person;
  },
): Promise<SeededIdeas> {
  const run = async <I extends z.ZodType, O extends z.ZodType>(
    cmd: CommandDef<I, O>,
    input: unknown,
    who: TestUser,
  ): Promise<z.output<O>> =>
    (await executeCommand(deps.api, cmd, input, deps.actor(who), deps.meta())).output;
  const share = (p: Person, title: string, body: string, areaId: string) =>
    run(ideaShare, { workspaceId: p.workspaceId, title, body, areaId }, p.user);
  const vote = async (ideaId: string, voters: readonly Person[]) => {
    for (const p of voters) await run(ideaVote, { ideaId, workspaceId: p.workspaceId }, p.user);
  };
  const { chris, dale, priya, marco, renee, tom, riley } = people;

  deps.step('Ideas: seven from four businesses, a roadmap, and What’s new');
  const onTheWay = await share(
    dale,
    'Text the customer when the tech is on the way',
    'A one-tap “On my way” from the phone app that texts the customer with the tech’s name and a rough arrival time.\n\nHalf our no-shows are people who didn’t know we were coming today.',
    'calendar',
  );
  await vote(onTheWay.ideaId, [priya, marco, renee, tom, riley]);
  await run(
    ideaComment,
    {
      ideaId: onTheWay.ideaId,
      body: 'Same here — and it would save the “are you still coming?” calls.',
    },
    tom.user,
  );
  await run(
    ideaSetStatus,
    {
      ideaId: onTheWay.ideaId,
      status: 'planned',
      note: 'Planned for the phone app’s next release, using the drive time the calendar already works out.',
    },
    chris,
  );

  const quickbooks = await share(
    renee,
    'Two-way sync with QuickBooks Online',
    'Invoices and payments should land in QuickBooks without us typing them in twice.',
    'money',
  );
  await vote(quickbooks.ideaId, [tom, riley, priya]);
  const duplicate = await share(
    dale,
    'Send our invoices to QuickBooks',
    'Our bookkeeper re-types every invoice.',
    'money',
  );
  await run(
    ideaMerge,
    {
      ideaId: duplicate.ideaId,
      intoIdeaId: quickbooks.ideaId,
      note: `Same idea as #${quickbooks.number}, so the votes are together now.`,
    },
    chris,
  );
  await run(
    ideaSetStatus,
    {
      ideaId: quickbooks.ideaId,
      status: 'in_progress',
      note: 'Being built now: invoices and payments first, then customers.',
    },
    chris,
  );

  const photos = await share(
    tom,
    'Photos on estimates',
    'Let us attach before photos to an estimate so the customer sees what we saw on the roof.',
    'money',
  );
  await vote(photos.ideaId, [dale, renee, riley]);

  const recurring = await share(
    riley,
    'Recurring jobs on the calendar',
    'Monthly and quarterly service visits that book themselves, like the maintenance plans do for billing.',
    'calendar',
  );
  await vote(recurring.ideaId, [tom]);

  const spanish = await share(
    priya,
    'Spanish replies from the AI teammate',
    'A lot of our customers text in Spanish. Ava should answer in the language they wrote in.',
    'ai_teammate',
  );
  await vote(spanish.ideaId, [marco, renee]);
  await run(
    ideaComment,
    {
      ideaId: spanish.ideaId,
      body: 'Thanks, Priya — do most of those come in by text, or through the website chat?',
    },
    chris,
  );

  const clock = await share(
    marco,
    'Clock in and out from the phone app',
    'So the office knows who is on the clock without a separate time app.',
    'phone_app',
  );
  await run(
    ideaSetStatus,
    {
      ideaId: clock.ideaId,
      status: 'not_planned',
      note: 'Not for now: payroll apps do this well, and we would rather connect to one than build a worse one.',
    },
    chris,
  );

  const shipped = await run(
    whatsNewSave,
    {
      title: 'Photos on estimates and invoices',
      body: 'Attach up to ten photos to any line of an estimate or invoice. Customers see them on their own page before they accept.\n\n- Add them from the phone app, straight from the camera\n- They print with the document',
      kind: 'new',
      areaId: 'money',
      ideaIds: [photos.ideaId],
    },
    chris,
  );
  await run(whatsNewPublish, { id: shipped.id }, chris);
  const search = await run(
    whatsNewSave,
    {
      title: 'Inbox search finds more',
      body: 'Search now looks inside email as well as texts, and finds a customer by any number they have texted from.',
      kind: 'improved',
      areaId: 'inbox',
    },
    chris,
  );
  await run(whatsNewPublish, { id: search.id }, chris);
  const fix = await run(
    whatsNewSave,
    {
      title: 'Reminders no longer go out twice after a reschedule',
      body: 'Moving an appointment used to leave the old reminder waiting as well. Only the new one goes out now.',
      kind: 'fixed',
      areaId: 'calendar',
    },
    chris,
  );
  await run(whatsNewPublish, { id: fix.id }, chris);
  await run(
    whatsNewSave,
    {
      title: 'QuickBooks Online, both ways',
      body: 'Draft: goes out when the sync leaves beta.',
      kind: 'new',
      areaId: 'money',
      ideaIds: [quickbooks.ideaId],
    },
    chris,
  );
  return { ideas: 7, published: 3 };
}
