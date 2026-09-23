import { lowerLabel } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FieldsSettings, type FieldTarget } from '@/components/settings/fields-settings';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Fields' };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

export default async function FieldsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = got.workspace.role === 'owner' || got.workspace.role === 'admin';
  if (!canManage) notFound();
  const { types: kinds } = unwrapPage(
    await api.POST('/v1/queries/custom_record_type.list', { body: { workspaceId } }),
  );
  // Customers and companies, then each kind of record the business keeps (?for=<its id>).
  const targets: FieldTarget[] = [
    {
      key: 'person',
      label: 'Customers',
      one: 'customer',
      entity: 'person',
      recordTypeId: null,
      icon: 'heart',
    },
    {
      key: 'company',
      label: 'Companies',
      one: 'company',
      entity: 'company',
      recordTypeId: null,
      icon: 'building',
    },
    ...kinds.map((k): FieldTarget => ({
      key: k.id,
      label: k.plural,
      one: lowerLabel(k.singular),
      entity: 'custom_record',
      recordTypeId: k.id,
      icon: k.icon,
    })),
  ];
  const target = targets.find((t) => t.key === one(sp.for)) ?? targets[0]!;
  const { fields } = unwrapPage(
    await api.POST('/v1/queries/custom_field.list', {
      body: target.recordTypeId
        ? { workspaceId, entity: 'custom_record', recordTypeId: target.recordTypeId }
        : { workspaceId, entity: target.entity },
    }),
  );
  return (
    <>
      <PageHeader title="Settings" description={`How ${got.workspace.name} is set up.`} />
      <SettingsNav workspaceId={workspaceId} canManage />
      <FieldsSettings workspaceId={workspaceId} targets={targets} target={target} fields={fields} />
    </>
  );
}
