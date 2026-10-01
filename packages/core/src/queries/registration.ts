import { eq } from 'drizzle-orm';
import { registrationDrafts } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { RegistrationGetDraftInput, RegistrationGetDraftOutput } from '../schemas/telephony';

/** The texting registration's answers as they were left, for the wizard to pick up where it stopped. */
export const registrationGetDraft = defineQuery({
  name: 'registration.get_draft',
  description:
    'The texting registration’s answers saved while it was being filled in, or nothing when none are saved.',
  input: RegistrationGetDraftInput,
  output: RegistrationGetDraftOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select({ answers: registrationDrafts.answers, updatedAt: registrationDrafts.updatedAt })
      .from(registrationDrafts)
      .where(eq(registrationDrafts.workspaceId, input.workspaceId));
    return {
      answers: row ? (row.answers as Record<string, unknown>) : null,
      savedAt: row ? row.updatedAt.toISOString() : null,
    };
  },
});
