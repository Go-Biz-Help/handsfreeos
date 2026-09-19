/** The wording library, as the picker and the Templates screen both read it. */
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { messageTemplates } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { templateVars } from '../workflows/templates';
import { TemplateListInput, TemplateListOutput } from '../schemas/template';

export const templateList = defineQuery({
  name: 'template.list',
  description:
    'The wording this business reuses, most-used first, with the folders it is filed under and the {{placeholders}} each one needs.',
  input: TemplateListInput,
  output: TemplateListOutput,
  // Reading the library is not managing it: anyone who can use the inbox can reach for the wording.
  permission: 'inbox.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const conditions = [eq(messageTemplates.workspaceId, input.workspaceId)];
    if (!input.includeArchived) conditions.push(isNull(messageTemplates.archivedAt));
    if (input.channel) conditions.push(eq(messageTemplates.channel, input.channel));
    if (input.search) {
      const like = `%${input.search}%`;
      const match = or(
        ilike(messageTemplates.name, like),
        ilike(messageTemplates.body, like),
        ilike(messageTemplates.folder, like),
      );
      if (match) conditions.push(match);
    }
    const list = await ctx.tx
      .select()
      .from(messageTemplates)
      .where(and(...conditions))
      .orderBy(desc(messageTemplates.usedCount), asc(sql`lower(${messageTemplates.name})`));
    return {
      templates: list.map((t) => ({
        id: t.id,
        name: t.name,
        channel: t.channel,
        subject: t.subject,
        body: t.body,
        folder: t.folder,
        usedCount: t.usedCount,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        archivedAt: t.archivedAt?.toISOString() ?? null,
        // The same reader a workflow step uses, so "what does this need?" has one answer everywhere.
        placeholders: [
          ...new Set(
            templateVars(`${t.subject ?? ''}\n${t.body}`)
              .filter((v) => v.valid)
              .map((v) => v.path),
          ),
        ],
        createdAt: t.createdAt.toISOString(),
      })),
      folders: [
        ...new Set(list.map((t) => t.folder).filter((f): f is string => !!f && f.length > 0)),
      ].sort((a, b) => a.localeCompare(b)),
    };
  },
});

export const templateQueries = [templateList] as const;
