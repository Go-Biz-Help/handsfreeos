/**
 * AI Social Media Content Creator's calls to HandsFreeOS from the background (docs/socialcontent.md; ./run.ts): only
 * its own `socialcontent.*` operations, core's problem report, and its actions on the worker (the helper, and what
 * watching a video gave), never Social Outreach's (decision 1). Each answers its value, or throws `ResearchRefused` with HandsFreeOS's words and rule.
 */
import { isApiErrorBody } from '@hfos/api-client';
import type { HelperLookOutput, ProblemReport } from '@hfos/core/problem-report';
import type { ContentNetwork } from '@hfos/core/addons/socialcontent/networks';
import type {
  FoundCreator,
  PostIn,
  WorkProgressSaid,
} from '@hfos/core/addons/socialcontent/shapes';
import type { ReadKind } from '@hfos/core/addons/socialcontent/helper';
import { api, token } from '../hfos/session';
import { config } from '../hfos/config';

/** HandsFreeOS said no, or couldn't be reached (`status` null). */
export class ResearchRefused extends Error {
  constructor(
    message: string,
    readonly rule: string | null,
    readonly status: number | null,
  ) {
    super(message);
  }
}

async function got<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await request;
  } catch {
    throw new ResearchRefused('Couldn’t reach HandsFreeOS.', null, null);
  }
  if (result.data !== undefined && result.response.ok) return result.data;
  const said = isApiErrorBody(result.error) ? result.error.error : null;
  throw new ResearchRefused(
    said?.message ?? 'Something went wrong in HandsFreeOS.',
    said?.rule ?? null,
    result.response.status,
  );
}

export type ResearchWork = NonNullable<Awaited<ReturnType<typeof workNext>>['work']>;

/** The businesses this person may read for: the add-on on, and they may use it. */
export async function researchBusinesses(): Promise<{ id: string; name: string }[]> {
  const me = await got(api().POST('/v1/queries/account.me', { body: {} }));
  return me.workspaces
    .filter(
      (w) => w.addons.includes('socialcontent') && w.permissions.includes('socialcontent.use'),
    )
    .map((w) => ({ id: w.id, name: w.name }));
}

export const workNext = (workspaceId: string, reads: ContentNetwork[]) =>
  got(
    api().POST('/v1/commands/socialcontent.work.next', {
      body: { workspaceId, reads, version: chrome.runtime.getManifest().version.slice(0, 20) },
    }),
  );

/** How the work it took is going, as it goes (docs/socialcontent.md, "What it's doing"). */
export const workProgress = (workspaceId: string, workId: string, progress: WorkProgressSaid) =>
  got(
    api().POST('/v1/commands/socialcontent.work.progress', {
      body: { workspaceId, workId, progress },
    }),
  );

export const workFinish = (workspaceId: string, workId: string, failure: string | null) =>
  got(
    api().POST('/v1/commands/socialcontent.work.finish', {
      body: { workspaceId, workId, failure: failure?.slice(0, 300) ?? null },
    }),
  );

export const creatorsFound = (workspaceId: string, workId: string, found: FoundCreator[]) =>
  got(
    api().POST('/v1/commands/socialcontent.creators.found', {
      body: { workspaceId, workId, found },
    }),
  );

export const creatorRead = (
  workspaceId: string,
  creatorId: string,
  read: Pick<FoundCreator, 'name' | 'bio' | 'followers' | 'lastPostAt'>,
) =>
  got(
    api().POST('/v1/commands/socialcontent.creator.read', {
      body: { workspaceId, creatorId, ...read },
    }),
  );

export const postsSave = (workspaceId: string, creatorId: string, posts: PostIn[]) =>
  got(
    api().POST('/v1/commands/socialcontent.posts.save', {
      body: { workspaceId, creatorId, posts },
    }),
  );

export const reportProblem = (workspaceId: string, report: ProblemReport) =>
  got(api().POST('/v1/commands/problem_report.send', { body: { workspaceId, report } }));

/** One of the add-on's actions on the worker, where the AI is. */
async function workerAction<T>(
  workspaceId: string,
  name: string,
  input: unknown,
  otherwise: string,
): Promise<T> {
  if (!config.workerUrl) throw new ResearchRefused('This build can’t reach the AI.', null, null);
  const bearer = await token();
  let response: Response;
  try {
    response = await fetch(`${config.workerUrl}/v1/addons/socialcontent/actions/${name}`, {
      method: 'POST',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workspaceId, input }),
    });
  } catch {
    throw new ResearchRefused('Couldn’t reach HandsFreeOS.', null, null);
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) return json as T;
  const said = isApiErrorBody(json) ? json.error : null;
  throw new ResearchRefused(said?.message ?? otherwise, said?.rule ?? null, response.status);
}

/** The AI helper's look at a read that didn't work (`socialcontent.helper.look`). */
export const helperLook = (
  workspaceId: string,
  input: {
    network: ContentNetwork;
    read: ReadKind;
    why: string;
    view: string;
    moves: {
      do: 'click' | 'scroll' | 'escape' | 'wait' | 'press';
      on: string | null;
      went: boolean;
    }[];
  },
): Promise<HelperLookOutput> =>
  workerAction(workspaceId, 'socialcontent.helper.look', input, 'The AI helper didn’t answer.');

/** What watching a standout video gave (`socialcontent.post.watch`): the AI looks and listens on the worker. */
export const watchSend = (
  workspaceId: string,
  input: {
    workId: string;
    postId: string;
    seconds: number | null;
    frames: readonly { at: number; jpeg: string }[];
    sound: string | null;
  },
): Promise<{ watched: boolean; failure: string | null }> =>
  workerAction(workspaceId, 'socialcontent.post.watch', input, 'The AI couldn’t watch that video.');
