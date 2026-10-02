import { can } from '@hfos/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConnectSourceButton, StartMigrationButton } from '@/components/migrations/connect';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { loadMigrations, STATUS_WORDS } from '@/lib/agency/migrations';
import { apiServer, getMe, getWorkspaceShell } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Migrations' };

/**
 * Moving this business here from the CRM it uses today.
 *
 * Its own page rather than a tab inside Imports: that page lists spreadsheets going into an existing
 * business, and this moves a whole business across — its customers, its history and everything attached to
 * them. They look alike for about a second and then stop.
 *
 * The same page serves both readers. A business owner sees their own move; an agency sees it here too, and
 * sees every client's from Migrations in the agency area. Whoever started it, it looks the same to both.
 */
export default async function WorkspaceMigrationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const me = await getMe();
  // Viewing as a teammate (20261018000100), it's their business the page is for.
  const shell = await getWorkspaceShell(workspaceId);
  const current = shell.teammateView
    ? shell.current
    : me.workspaces.find((w) => w.id === workspaceId);
  if (!current) notFound();
  if (!can(current.permissions, 'migrations.manage')) notFound();

  const { migrations, connections } = await loadMigrations(
    api,
    current.organizationId,
    workspaceId,
  );
  const live = connections.filter((c) => c.status === 'active');

  return (
    <>
      <PageHeader
        section
        title="Migrations"
        description={`Bring ${current.name} here from the CRM it uses today. We look first and count everything, you choose what comes, and your old account is never changed or cancelled.`}
        actions={
          <ConnectSourceButton organizationId={current.organizationId} workspaceId={workspaceId} />
        }
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
                  <div className="text-xs text-text-3">
                    {c.authKind === 'private_token'
                      ? 'Connected with a private token'
                      : c.missingScopes.length > 0
                        ? `${c.missingScopes.length} ${
                            c.missingScopes.length === 1 ? 'thing' : 'things'
                          } this sign-in cannot read`
                        : 'Ready to look at'}
                  </div>
                </div>
                <StartMigrationButton
                  organizationId={current.organizationId}
                  workspaceId={workspaceId}
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
              href={`/app/w/${workspaceId}/settings/migrations/${m.id}`}
              data-testid={`migration-${m.id}`}
              className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-card p-4 hover:bg-card-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{m.name}</div>
                <div className="truncate text-xs text-text-3">From {m.sourceLabel}</div>
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
