import {
  assistantTools,
  executeQuery,
  hasWorkspacePermission,
  registry,
  ROLE_LABELS,
  type AssistantTool,
  type HumanActor,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { PromptContext } from './prompt';

export interface PageRecord {
  readonly type: 'person' | 'company' | 'lead' | 'conversation';
  readonly id: string;
}

export interface QuestionContext {
  readonly prompt: PromptContext;
  /** The tools this person's role allows (the commands check again when they run). */
  readonly tools: readonly AssistantTool[];
  readonly organizationId: string;
  readonly timezone: string;
}

/** Runs one of the person's own queries, exactly as the web app would. */
export async function personQuery<T>(
  db: Db,
  name: string,
  input: Record<string, unknown>,
  actor: HumanActor,
  correlationId: string,
): Promise<T> {
  const query = registry.query(name);
  if (!query) throw new Error(`Unknown query ${name}`);
  return (await executeQuery(db, query, input, actor, {
    correlationId,
    channel: 'assistant',
  })) as T;
}

interface WorkspaceGet {
  workspace: {
    name: string;
    timezone: string;
    organizationId: string;
    role: 'owner' | 'admin' | 'member';
  };
}
interface PipelineList {
  pipelines: {
    name: string;
    archivedAt: string | null;
    stages: { id: string; name: string; kind: string }[];
  }[];
}
interface Members {
  members: { userId: string; fullName: string; email: string; role: string }[];
  organizationAdmins: { userId: string; fullName: string; email: string; orgRole: string }[];
}

/** The name of the record on screen, or null when it can't be read (gone, or not this person's to see). */
async function pageLabel(
  db: Db,
  workspaceId: string,
  page: PageRecord,
  actor: HumanActor,
  correlationId: string,
): Promise<string | null> {
  const get = <T>(name: string, input: Record<string, unknown>) =>
    personQuery<T>(db, name, { workspaceId, ...input }, actor, correlationId);
  try {
    switch (page.type) {
      case 'person':
        return (await get<{ person: { fullName: string } }>('person.get', { personId: page.id }))
          .person.fullName;
      case 'company':
        return (await get<{ company: { name: string } }>('company.get', { companyId: page.id }))
          .company.name;
      case 'lead': {
        const { lead } = await get<{
          lead: { title: string; person: { fullName: string } | null };
        }>('lead.get', {
          leadId: page.id,
        });
        return lead.person ? `${lead.title} (${lead.person.fullName})` : lead.title;
      }
      case 'conversation': {
        const { conversation } = await get<{
          conversation: {
            channel: string;
            counterpartDisplay: string;
            person: { fullName: string } | null;
          };
        }>('conversation.get', { conversationId: page.id });
        const who = conversation.person?.fullName ?? conversation.counterpartDisplay;
        return `${conversation.channel === 'email' ? 'Email' : 'Texts'} with ${who}`;
      }
    }
  } catch {
    return null;
  }
}

/** Everything the model is told about the business, the person and the page, read as that person. */
export async function questionContext(
  db: Db,
  actor: HumanActor,
  workspaceId: string,
  page: PageRecord | null,
  correlationId: string,
  now: Date = new Date(),
): Promise<QuestionContext> {
  const get = <T>(name: string) => personQuery<T>(db, name, { workspaceId }, actor, correlationId);
  const [{ workspace }, { pipelines }, team] = await Promise.all([
    get<WorkspaceGet>('workspace.get'),
    get<PipelineList>('pipeline.list'),
    get<Members>('workspace.members'),
  ]);
  const me =
    team.members.find((m) => m.userId === actor.userId) ??
    team.organizationAdmins.find((m) => m.userId === actor.userId);
  const label = page ? await pageLabel(db, workspaceId, page, actor, correlationId) : null;
  return {
    organizationId: workspace.organizationId,
    timezone: workspace.timezone,
    tools: assistantTools.filter((t) => hasWorkspacePermission(workspace.role, t.permission)),
    prompt: {
      businessName: workspace.name,
      personName: me?.fullName || actor.email,
      role: ROLE_LABELS[workspace.role],
      timezone: workspace.timezone,
      now,
      pipelines: pipelines
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          name: p.name,
          stages: p.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
        })),
      team: [
        ...team.members.map((m) => ({
          userId: m.userId,
          fullName: m.fullName || m.email,
          role: m.role,
        })),
        ...team.organizationAdmins
          .filter((a) => !team.members.some((m) => m.userId === a.userId))
          .map((a) => ({
            userId: a.userId,
            fullName: a.fullName || a.email,
            role: `organization ${a.orgRole}`,
          })),
      ],
      page: page && label ? { type: page.type, id: page.id, label } : null,
    },
  };
}
