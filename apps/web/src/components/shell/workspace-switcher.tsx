'use client';
import { STAFF_ROLE_WORDS, type StaffRole } from '@hfos/core';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronsUpDown, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { agencyHref } from '@/lib/agency/org';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Me, WorkspaceSummary } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';
import { TIMEZONES } from '@/app/onboarding/onboarding-form';

/** `staff` is the person's role at HandsFreeOS support (`platform.me`), or null for everyone who doesn't work here. */
export function WorkspaceSwitcher({
  me,
  current,
  staff,
}: {
  me: Me;
  current: WorkspaceSummary;
  staff: StaffRole | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const canCreate = me.organizations.length > 0;

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const byOrg = new Map<
      string,
      { name: string; role: string | null; items: WorkspaceSummary[] }
    >();
    for (const w of me.workspaces) {
      if (needle && !w.name.toLowerCase().includes(needle)) continue;
      const g = byOrg.get(w.organizationId) ?? {
        name: w.organizationName,
        role: me.organizations.find((o) => o.id === w.organizationId)?.role ?? null,
        items: [],
      };
      g.items.push(w);
      byOrg.set(w.organizationId, g);
    }
    return [...byOrg.entries()];
  }, [me, q]);

  function go(w: WorkspaceSummary) {
    document.cookie = `${WORKSPACE_COOKIE}=${w.id}; path=/; max-age=31536000; samesite=lax`;
    setOpen(false);
    setQ('');
    router.push(`/app/w/${w.id}`);
  }

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid="workspace-switcher"
            className="flex h-[52px] w-full items-center gap-2.5 rounded-menu border border-border bg-card px-2.5 text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            <Avatar
              name={current.name}
              seed={current.id}
              square
              className="bg-accent-soft-2 text-accent-text"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold">{current.name}</span>
              <span className="truncate text-xs text-text-3">{current.organizationName}</span>
            </span>
            <ChevronsUpDown className="h-[18px] w-[18px] flex-none text-text-3" strokeWidth={1.5} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          {/* Above the phone navigation drawer (a z-50 sheet), which is where this opens from on mobile. */}
          <Popover.Content
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-[60] w-[304px] max-w-[calc(100vw-24px)] rounded-card border border-border bg-card p-0 shadow-2 focus:outline-none"
          >
            <div className="p-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-2 h-[18px] w-[18px] text-text-3"
                  strokeWidth={1.5}
                />
                <Input
                  inputSize="sm"
                  className="pl-[34px]"
                  placeholder="Find a workspace"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  autoFocus
                  aria-label="Find a workspace"
                />
              </div>
            </div>
            <div className="h-px bg-border" />
            <div className="max-h-[320px] overflow-y-auto p-1.5">
              {groups.length === 0 ? (
                <div className="px-2.5 py-2.5 text-[13px] text-text-3">No workspaces match.</div>
              ) : null}
              {groups.map(([orgId, g]) => (
                <div key={orgId}>
                  <div className="flex items-center gap-2 px-2.5 pb-1 pt-1.5 text-xs font-medium text-text-3">
                    <span className="min-w-0 flex-1 truncate">
                      {g.name}
                      {g.role ? ` · you are ${g.role === 'owner' ? 'Owner' : 'Admin'}` : ''}
                    </span>
                    {/* Org owners and admins run the agency area (templates and knowledge packs). */}
                    {g.role ? (
                      <Link
                        href={agencyHref(orgId)}
                        onClick={() => setOpen(false)}
                        className="flex-none rounded-[4px] font-semibold text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                        data-testid={`agency-link-${orgId}`}
                      >
                        Agency area
                      </Link>
                    ) : null}
                  </div>
                  {g.items.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => go(w)}
                      className={cn(
                        'flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2',
                        w.id === current.id && 'bg-accent-soft font-medium text-accent-text',
                      )}
                    >
                      <Avatar
                        name={w.name}
                        seed={w.id}
                        size="sm"
                        square
                        className="bg-card-3 text-text"
                      />
                      <span className="flex-1 truncate">{w.name}</span>
                      {w.id === current.id ? <Check className="h-4 w-4" strokeWidth={2} /> : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {/* HandsFreeOS's own support people open the admin area here, as an organization's owners and admins
                open its agency area above. It belongs to no business, so it sits outside the list and its search. */}
            {staff ? (
              <>
                <div className="h-px bg-border" />
                <div className="p-1.5">
                  <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-text-3">
                    <span className="min-w-0 flex-1 truncate">
                      HandsFreeOS · {STAFF_ROLE_WORDS[staff]}
                    </span>
                    <Link
                      href="/admin"
                      onClick={() => setOpen(false)}
                      className="flex-none rounded-[4px] font-semibold text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                      data-testid="admin-area-link"
                    >
                      Admin area
                    </Link>
                  </div>
                </div>
              </>
            ) : null}
            {canCreate ? (
              <>
                <div className="h-px bg-border" />
                <div className="p-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setCreating(true);
                    }}
                    className="flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
                  >
                    <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
                    Create workspace
                  </button>
                </div>
              </>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {canCreate ? (
        <CreateWorkspaceDialog
          open={creating}
          onOpenChange={setCreating}
          organizations={me.organizations}
        />
      ) : null}
    </>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
  organizations,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  organizations: Me['organizations'];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? '');
  const [timezone, setTimezone] = useState('America/Chicago');
  // Whether they are on the business or only administer it from the organization. Asked rather than
  // assumed: an agency setting one up for a client has no place in that client's team, and somebody
  // adding a business they run themselves expects to be on it. Changeable later on Members.
  const [joinAsOwner, setJoinAsOwner] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the business a name.');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workspace.create', {
          body: { organizationId: orgId, name: name.trim(), timezone, joinAsOwner },
        }),
      );
      toast.success(`${name.trim()} created.`);
      onOpenChange(false);
      setName('');
      document.cookie = `${WORKSPACE_COOKIE}=${out.workspaceId}; path=/; max-age=31536000; samesite=lax`;
      router.push(`/app/w/${out.workspaceId}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a business"
        description="Each business gets its own workspace under your organization."
      >
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
          {organizations.length > 1 ? (
            <Field label="Organization" htmlFor="ws-org">
              <Select id="ws-org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Business name" htmlFor="ws-name" error={error}>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Bayou Plumbing Co."
              invalid={!!error}
              autoFocus
            />
          </Field>
          <Field label="Time zone" htmlFor="ws-tz">
            <Select id="ws-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Who runs this business?" htmlFor="ws-join">
            <Select
              id="ws-join"
              value={joinAsOwner ? 'me' : 'client'}
              onChange={(e) => setJoinAsOwner(e.target.value === 'me')}
            >
              <option value="me">I do — put me on it</option>
              <option value="client">I’m setting it up for someone else</option>
            </Select>
            <p className="mt-1.5 text-[13px] text-text-3">
              {joinAsOwner
                ? 'You’ll be on its team, can be booked for its jobs, and get its emails.'
                : 'You won’t be on its team. You can still change everything, and its emails come to you until its own people are invited. You can put yourself on it later from Members.'}
            </p>
          </Field>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Add business
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
