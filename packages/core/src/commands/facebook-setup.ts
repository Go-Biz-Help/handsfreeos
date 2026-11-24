/**
 * The guided Facebook & Instagram setup's Check it over (the owner, 24 Nov 2026, picks F1 a to F4 a): Connect with
 * Facebook (or, with a Page already connected, Save my answers) saves what its questions decide, all together, before
 * Facebook's own sign-in. What happens when someone new writes is each channel's rules for someone new
 * (intake_source.update): Messenger always, Instagram when it's picked, and lead ads, on or off, once a sign-in may
 * read leads. Each runs as its own command, with all its own rules, so nothing here goes around them. Signing in is
 * meta_connection.connect, afterwards, since only the person can do it. Answers that are wrong are refused before
 * anything changes, in the setup's own words.
 */
import { and, eq, ne } from 'drizzle-orm';
import { guidedSetupDrafts, metaConnections } from '@hfos/db/schema';
import { HfosError } from '../errors';
import {
  FacebookSetupSaveInput,
  FacebookSetupSaveOutput,
  facebookSetupIntakeFields,
  facebookSetupProblems,
  facebookSetupQuestions,
} from '../guided-setup/facebook';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { z } from 'zod';
import type { IntakeChannelKind } from '../schemas/intake';
import { intakeSourceUpdate } from './intake-source';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const facebookSetupSave = defineCommand({
  name: 'facebook_setup.save',
  description:
    'Carry out the guided Facebook & Instagram setup’s answers, as its Connect with Facebook (or Save my answers) does before Facebook’s sign-in: whether someone new who messages the Page or the Instagram account becomes a customer and a lead, and in which pipeline and stage, and whether lead ads’ forms come in once a sign-in may read them. It never signs in to Facebook; only the person can. Nothing changes when an answer is wrong.',
  risk: 2,
  input: FacebookSetupSaveInput,
  output: FacebookSetupSaveOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const a = input.answers;
    const signIns = await ctx.tx
      .select({ scopes: metaConnections.scopes })
      .from(metaConnections)
      .where(
        and(
          eq(metaConnections.workspaceId, ws),
          ne(metaConnections.status, 'pending'),
          ne(metaConnections.status, 'disconnected'),
        ),
      );
    const readsLeads = signIns.some((c) => c.scopes.includes('leads_retrieval'));

    // Where leads land is checked by intake_source.update itself, with its own words; the rest is the setup's.
    const problems = facebookSetupQuestions(a).flatMap((q) =>
      facebookSetupProblems(q, a, { pipelines: [], readsLeads }).filter(
        (p) => p.path !== 'pipelineId' && p.path !== 'stageId',
      ),
    );
    if (problems.length)
      throw HfosError.validation(
        problems.map((p) => ({ path: `answers.${p.path}`, message: p.message })),
        problems[0]!.message,
      );

    const changed: z.infer<typeof IntakeChannelKind>[] = [];
    const update = async (
      kind: 'messenger' | 'instagram' | 'facebook_lead_ad',
      fields: Record<string, unknown>,
    ) => {
      const done = await executeCommandWithin(ctx, intakeSourceUpdate, {
        workspaceId: ws,
        kind,
        ...fields,
      });
      if (done.output.updated.length) changed.push(kind);
    };
    const rules = facebookSetupIntakeFields(a);
    await update('messenger', rules);
    if (a.instagram) await update('instagram', rules);
    if (readsLeads) await update('facebook_lead_ad', { active: a.leadAds });

    // The answers are spent: coming back starts from what's connected and set now.
    await ctx.tx
      .delete(guidedSetupDrafts)
      .where(and(eq(guidedSetupDrafts.workspaceId, ws), eq(guidedSetupDrafts.setup, 'facebook')));

    return { changed };
  },
});
