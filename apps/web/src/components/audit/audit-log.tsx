'use client';
import { ChevronDown, Copy, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TeammateMark } from '@/components/ai-team/mark';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AuditEntry, AuditList } from '@/lib/api/types';
import {
  AUDIT_CATEGORY_LABEL,
  auditActor,
  auditCategory,
  describeAudit,
  isAuditDetection,
} from '@/lib/audit-describe';
import { cn } from '@/lib/utils';

type Range = 'today' | '7d' | '30d';
const RANGE_MS: Record<Range, number> = { today: 0, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
/** Categories that map to one action prefix are filtered by the API; the rest are filtered here. */
const ACTION_PREFIX: Record<string, string | undefined> = {
  all: undefined,
  members: 'membership.',
  invitations: 'invitation.',
  files: 'file.',
  imports: 'import.',
  // attention.* and attention_item.* (the action filter is a prefix).
  action_center: 'attention',
};

function sinceFor(range: Range): string {
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  return new Date(Date.now() - RANGE_MS[range]).toISOString();
}

/** Filtered here, not by the API: the AI teammate's own changes and the ones about it (drafts, hand-offs). */
const AI_TEAMMATE = 'ai_teammate';

/** What the API filters by for the choices on screen. "Assistant" is where a change came from. */
function filters(range: Range, actor: string, category: string) {
  return {
    since: sinceFor(range),
    ...(actor !== 'all' && actor !== 'system' && actor !== 'workflows' && actor !== AI_TEAMMATE
      ? { actorId: actor }
      : {}),
    // What workflows did comes through the workflow channel.
    ...(actor === 'workflows' ? { channel: 'workflow' as const } : {}),
    ...(ACTION_PREFIX[category] ? { action: ACTION_PREFIX[category] } : {}),
    ...(category === 'assistant' ? { channel: 'assistant' as const } : {}),
  };
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function AuditLog({
  workspaceId,
  initial,
  teammateName = null,
}: {
  workspaceId: string;
  initial: AuditList;
  /** The business's AI teammate, for "Ava (AI)" rows and the filter. */
  teammateName?: string | null;
}) {
  const [range, setRange] = useState<Range>('30d');
  const [actor, setActor] = useState('all');
  const [category, setCategory] = useState('all');
  const [q, setQ] = useState('');
  /** What the Action Center noticed on its own (an item opened, came back, cleared): hidden until asked for. */
  const [noticed, setNoticed] = useState(false);
  const [data, setData] = useState<AuditList>(initial);
  const [open, setOpen] = useState<string | null>(initial.entries[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (range === '30d' && actor === 'all' && category === 'all') {
      setData(initial);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const res = unwrap(
          await apiBrowser().POST('/v1/queries/audit.list', {
            body: { workspaceId, limit: 50, ...filters(range, actor, category) },
          }),
        );
        if (!cancelled) setData(res);
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, range, actor, category, initial]);

  const actors = useMemo(() => {
    const map = new Map<string, string>();
    // The AI teammate has its own choice below.
    for (const e of [...initial.entries, ...data.entries])
      if (e.actor.userId && e.actor.type !== 'ai_employee')
        map.set(e.actor.userId, auditActor(e, teammateName).name);
    // People first, then each workflow ("Workflow: Speed to lead"): a workflow is recorded as itself.
    return [...map.entries()].sort(
      ([, a], [, b]) =>
        Number(a.startsWith('Workflow: ')) - Number(b.startsWith('Workflow: ')) ||
        a.localeCompare(b),
    );
  }, [initial, data, teammateName]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.entries.filter((e) => {
      if (!noticed && isAuditDetection(e)) return false;
      if (actor === 'system' && e.actor.type !== 'system') return false;
      if (actor === 'workflows' && e.actor.type !== 'workflow') return false;
      if (
        actor === AI_TEAMMATE &&
        e.actor.type !== 'ai_employee' &&
        auditCategory(e.action) !== 'ai_team'
      )
        return false;
      if (category === 'assistant') {
        if (e.channel !== 'assistant') return false;
      } else if (category === 'workflows') {
        // Changes to workflows, and everything a workflow did.
        if (auditCategory(e.action) !== 'workflows' && e.actor.type !== 'workflow') return false;
      } else if (category !== 'all' && auditCategory(e.action) !== category) return false;
      if (!needle) return true;
      return `${auditActor(e, teammateName).name} ${describeAudit(e)} ${e.action}`
        .toLowerCase()
        .includes(needle);
    });
  }, [data, q, actor, category, teammateName, noticed]);

  async function loadMore() {
    if (!data.nextCursor) return;
    setBusy(true);
    try {
      const res = unwrap(
        await apiBrowser().POST('/v1/queries/audit.list', {
          body: {
            workspaceId,
            limit: 50,
            cursor: data.nextCursor,
            ...filters(range, actor, category),
          },
        }),
      );
      setData({ entries: [...data.entries, ...res.entries], nextCursor: res.nextCursor });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const groups: { label: string; entries: AuditEntry[] }[] = [];
  for (const e of visible) {
    const label = dayLabel(e.createdAt);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.entries.push(e);
    else groups.push({ label, entries: [e] });
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Today' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
          ]}
        />
        <Select
          selectSize="sm"
          className="w-[190px]"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          aria-label="Filter by person"
        >
          <option value="all">Everyone</option>
          {actors.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
          <option value="workflows">All workflows</option>
          <option value={AI_TEAMMATE}>
            {teammateName ? `${teammateName} (AI teammate)` : 'AI teammate'}
          </option>
          <option value="system">HandsFreeOS (system)</option>
        </Select>
        <Select
          selectSize="sm"
          className="w-[170px]"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by activity"
        >
          <option value="all">All activity</option>
          <option value="members">Members</option>
          <option value="invitations">Invitations</option>
          <option value="workspace">Workspace</option>
          <option value="customers">Customers</option>
          <option value="inbox">Inbox &amp; texting</option>
          <option value="calendar">Calendar</option>
          <option value="leads">Leads</option>
          <option value="tasks">Tasks</option>
          <option value="files">Files</option>
          <option value="imports">Imports</option>
          <option value="workflows">Workflows</option>
          <option value="action_center">Action Center</option>
          <option value="assistant">Assistant</option>
        </Select>
        {category === 'all' || category === 'action_center' ? (
          <Checkbox
            label="Show what HandsFreeOS noticed"
            checked={noticed}
            onChange={(e) => setNoticed(e.target.checked)}
            className="text-[13px] text-text-2"
            data-testid="audit-show-noticed"
          />
        ) : null}
        <div className="relative max-w-[320px] flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-2 h-[18px] w-[18px] text-text-3"
            strokeWidth={1.5}
          />
          <Input
            inputSize="sm"
            className="pl-[34px]"
            placeholder="Search names, emails, actions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search"
          />
        </div>
        <span className="ml-auto text-[13px] text-text-3">
          {busy ? 'Loading…' : `${visible.length} ${visible.length === 1 ? 'entry' : 'entries'}`}
        </span>
      </div>
      <Card className="overflow-hidden p-0" data-testid="audit-log">
        {groups.length === 0 ? (
          <div className="px-10 py-10 text-center text-[13px] text-text-2">
            Nothing matches these filters.
          </div>
        ) : null}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="border-b border-border bg-card-2 px-4 pb-1.5 pt-2.5 text-xs font-medium tracking-wide text-text-3">
              {g.label}
            </div>
            {g.entries.map((e) => {
              const expanded = open === e.id;
              const who = auditActor(e, teammateName);
              const actorName = who.name;
              return (
                <div key={e.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : e.id)}
                    aria-expanded={expanded}
                    className={cn(
                      'grid w-full grid-cols-[84px_1fr_28px] items-center gap-3 border-b border-border px-4 py-3 text-left hover:bg-card-2 lg:grid-cols-[130px_1fr_auto_28px] lg:gap-4',
                      expanded && 'bg-card-2',
                    )}
                  >
                    <span className="text-[13px] tabular-nums text-text-2">
                      {new Date(e.createdAt).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="flex min-w-0 items-center gap-2.5">
                      {who.kind === 'ai' ? (
                        <TeammateMark size="sm" label={actorName} />
                      ) : (
                        <Avatar
                          name={actorName}
                          seed={e.actor.userId ?? 'system'}
                          size="sm"
                          className={e.actor.type === 'system' ? 'bg-[#5b616a]' : undefined}
                        />
                      )}
                      <span className="truncate">
                        <strong className="font-semibold">{actorName}</strong> {describeAudit(e)}
                      </span>
                    </span>
                    <span className="hidden items-center gap-2 lg:flex">
                      <Badge variant="gray">{AUDIT_CATEGORY_LABEL[auditCategory(e.action)]}</Badge>
                      <Badge variant="gray" className="font-mono text-[11px]">
                        {e.channel}
                      </Badge>
                    </span>
                    <ChevronDown
                      className={cn(
                        'h-[18px] w-[18px] text-text-3 transition-transform',
                        expanded && 'rotate-180',
                      )}
                      strokeWidth={1.5}
                    />
                  </button>
                  {expanded ? (
                    <div className="border-b border-border bg-card-2 px-4 pb-4 pt-1.5 lg:pl-[182px]">
                      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[300px_1fr_1fr]">
                        <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                          <dt className="text-text-3">Action</dt>
                          <dd className="font-mono text-[12.5px]">{e.action}</dd>
                          <dt className="text-text-3">Entity</dt>
                          <dd>
                            {e.entityType}
                            {e.entityName ? ` · ${e.entityName}` : ''}
                          </dd>
                          <dt className="text-text-3">Channel</dt>
                          <dd>{e.channel}</dd>
                          {who.kind === 'workflow' && who.workflowId ? (
                            <>
                              <dt className="text-text-3">Workflow</dt>
                              <dd className="flex flex-wrap gap-x-2.5">
                                <Link
                                  href={`/app/w/${workspaceId}/workflows/${who.workflowId}`}
                                  className="text-accent-text hover:underline"
                                  data-testid="audit-workflow-link"
                                >
                                  {e.actor.workflow?.name ?? 'Open the workflow'}
                                </Link>
                                <Link
                                  href={`/app/w/${workspaceId}/workflows/runs/${e.correlationId}`}
                                  className="text-accent-text hover:underline"
                                >
                                  See the run
                                </Link>
                              </dd>
                            </>
                          ) : null}
                          <dt className="text-text-3">Correlation</dt>
                          <dd className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-[12.5px] text-text-2">
                              {e.correlationId}
                            </span>
                            <button
                              type="button"
                              className="rounded p-0.5 text-text-3 hover:text-text"
                              aria-label="Copy correlation id"
                              onClick={() => {
                                void navigator.clipboard.writeText(e.correlationId);
                                toast.success('Copied');
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </dd>
                          {e.causationId ? (
                            <>
                              <dt className="text-text-3">Caused by</dt>
                              <dd className="truncate font-mono text-[12.5px] text-text-2">
                                {e.causationId}
                              </dd>
                            </>
                          ) : null}
                          {e.reason ? (
                            <>
                              <dt className="text-text-3">Reason</dt>
                              <dd>{e.reason}</dd>
                            </>
                          ) : null}
                        </dl>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[13px] font-semibold text-text-3">Before</span>
                          <pre className="whitespace-pre-wrap rounded-control border border-border bg-card p-3 font-mono text-xs leading-relaxed">
                            {JSON.stringify(e.before, null, 2)}
                          </pre>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[13px] font-semibold text-text-3">After</span>
                          <pre className="whitespace-pre-wrap rounded-control border border-border bg-card p-3 font-mono text-xs leading-relaxed">
                            {JSON.stringify(e.after, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        {data.nextCursor ? (
          <div className="flex justify-center p-3">
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void loadMore()}>
              Load older entries
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}
