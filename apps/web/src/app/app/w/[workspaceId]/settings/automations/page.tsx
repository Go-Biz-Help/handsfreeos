import { attentionSettingsOf, automationSettingsOf, can, type NudgeCheckContext } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AutomationsSettings } from '@/components/settings/automations/automations-page';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Automations' };

/** "https://www.acme.com/contact" → "www.acme.com", as the server's check reads a chat site. */
const hostOf = (u: string): string => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).host;
  } catch {
    return '';
  }
};

/**
 * Settings → Automations (owners and admins): every automation, grouped, each with a switch and an Adjust sheet
 * for its timing and wording. It took in Settings → Action Center: the kinds Home looks for and their thresholds,
 * the typical job value, when a lead goes quiet in each stage, the follow-up wording and replying C to confirm.
 * `?adjust=<automation id>` opens that automation's Adjust sheet (the AI teammate's Follow up links here).
 */
export default async function AutomationsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ adjust?: string | string[] }>;
}) {
  const { workspaceId } = await params;
  const { adjust } = await searchParams;
  const { api } = await apiServer();
  const [got, me] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    getMe(),
  ]);
  const role = got.workspace.role;
  if (!can(got.workspace.permissions, 'workspace.update')) notFound();
  const body = { body: { workspaceId } };
  // The number, addresses and chat sites are only for the wording's check (the business's own may be given).
  const [pipelines, worked, phone, email, widgets, team, forms, services, plans, prices] =
    await Promise.all([
      api.POST('/v1/queries/pipeline.list', body).then(unwrapPage),
      // What HandsFreeOS works out for a lead with no value: the median won lead over a year, else $500.
      api.POST('/v1/queries/attention.settings', body).then(unwrapPage),
      api
        .POST('/v1/queries/phone.setup_status', body)
        .then((r) => r.data ?? null)
        .catch(() => null),
      api
        .POST('/v1/queries/email.setup_status', body)
        .then((r) => r.data ?? null)
        .catch(() => null),
      api
        .POST('/v1/queries/chat_widget.list', body)
        .then((r) => r.data ?? null)
        .catch(() => null),
      api
        .POST('/v1/queries/ai_teammate.get', body)
        .then((r) => r.data?.teammate ?? null)
        .catch(() => null),
      // "Intake questions" picks one of them.
      api
        .POST('/v1/queries/form.list', body)
        .then((r) => r.data?.items ?? [])
        .catch(() => []),
      // "Maintenance due" has something to go on once a service repeats or a plan names one.
      api
        .POST('/v1/queries/service.list', body)
        .then((r) => r.data?.items ?? [])
        .catch(() => []),
      api
        .POST('/v1/queries/plan.list', body)
        .then((r) => r.data?.plans ?? [])
        .catch(() => []),
      // "Business landlines" says what checking a number costs, to someone who can see prices.
      api
        .POST('/v1/queries/usage.prices', body)
        .then((r) => r.data?.items ?? null)
        .catch(() => null),
    ]);
  const priced = (key: string) => prices?.find((p) => p.key === key)?.cents;
  const line = priced('lookup.line_type');
  const owner = priced('lookup.caller_name');
  const number = phone?.number && phone.number.status === 'active' ? phone.number : null;
  const addresses = email?.addresses.map((a) => a.address) ?? [];
  const domains = [
    ...(widgets?.items.flatMap((w) => w.allowedOrigins) ?? []).map(hostOf),
    ...addresses.map((a) => a.split('@')[1] ?? ''),
  ].filter(Boolean);
  const check: NudgeCheckContext = {
    businessName: got.workspace.name,
    businessPhone: number?.display ?? null,
    allowed: {
      domains: [...new Set(domains)],
      urlPrefixes: [],
      phones: number ? [number.e164] : [],
      emails: addresses,
    },
  };
  return (
    <>
      <AutomationsSettings
        workspaceId={workspaceId}
        initialAdjust={typeof adjust === 'string' ? adjust : null}
        role={role}
        businessName={got.workspace.name}
        initialAttention={attentionSettingsOf(got.workspace.settings)}
        initialAutomations={automationSettingsOf(got.workspace.settings)}
        teammate={
          team
            ? {
                id: team.id,
                name: team.name,
                status: team.status,
                revision: team.revision,
                config: team.config,
              }
            : null
        }
        workedOut={worked.typicalJobValueCents}
        typicalFrom={worked.typicalFrom}
        pipelines={pipelines.pipelines}
        replyMinutes={phone?.settings.unansweredReminderMinutes ?? 10}
        check={check}
        senderName={(me.user.fullName.trim() || me.user.email).split(/\s+/)[0] ?? 'the team'}
        forms={forms.map((f) => ({ id: f.formId, name: f.name, status: f.status }))}
        lineCheckCents={line !== undefined && owner !== undefined ? { line, owner } : null}
        maintenanceReady={
          services.some((s) => s.repeatMonths !== null) ||
          plans.some((p) => p.serviceId !== null && !p.archivedAt)
        }
      />
    </>
  );
}
