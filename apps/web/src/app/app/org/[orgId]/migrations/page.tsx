import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConnectSourceButton, StartMigrationButton } from '@/components/migrations/connect';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { connectionWords, loadMigrations, STATUS_WORDS } from '@/lib/agency/migrations';
import { agencyOrganizations } from '@/lib/agency/org';
import { apiServer, fetchMe } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Migrations' };

/** Moving a business here from the CRM it uses today: the sources connected, and every move under way. */
export default async function MigrationsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const org = agencyOrganizations(me).find((o) => o.id === orgId);
  if (!org) notFound();
  const { migrations, connections } = await loadMigrations(api, orgId);
  const live = connections.filter((c) => c.status === 'active');

  return (
    <>
      <PageHeader
        title="Migrations"
        description="Bring a business here from the CRM it uses today. We look first and count everything, you choose what comes, and your old account is never changed or cancelled."
        actions={<ConnectSourceButton organizationId={orgId} />}
      />
      {live.length > 0 ? (
        <Card className="mb-5 p-5">
          <h2 className="text-base font-semibold">Connected</h2>
          <div className="mt-3 flex flex-col gap-2">
            {live.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center gap-3 rounded-control border border-border p-3"
                data-testid={`migration-connection-${c.source}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{c.displayName ?? c.sourceLabel}</div>
                  <div className="text-xs text-text-3">{connectionWords(c)}</div>
                </div>
                <StartMigrationButton
                  organizationId={orgId}
                  connectionId={c.id}
                  sourceLabel={c.sourceLabel}
                />
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {migrations.length === 0 ? (
        <EmptyState title="Nothing moving yet" dashed>
          Connect the CRM you&apos;re leaving. The first thing we do is look at what&apos;s in it
          and count everything — nothing moves until you&apos;ve seen the list.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {migrations.map((m) => (
            <Link
              key={m.id}
              href={`/app/org/${orgId}/migrations/${m.id}`}
              data-testid={`migration-${m.id}`}
              className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-card p-4 hover:bg-card-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{m.name}</div>
                <div className="truncate text-xs text-text-3">
                  From {m.sourceLabel} · {m.scopes} {m.scopes === 1 ? 'business' : 'businesses'}
                </div>
              </div>
              <Badge
                variant={
                  m.status === 'needs_attention' || m.status === 'failed'
                    ? 'pending'
                    : m.status === 'completed' || m.status === 'imported'
                      ? 'ok'
                      : 'gray'
                }
              >
                {STATUS_WORDS[m.status] ?? m.status}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
