'use client';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ArrowLeft, Check, Info, UserRound } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import type { AttentionItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useAttentionEnv } from './attention-context';
import { customerOf, firstNameOf, LEAD_KINDS } from './attention-words';

const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;
const ITEM =
  'flex h-[34px] cursor-pointer select-none items-center gap-2.5 rounded-[6px] px-2.5 text-sm text-text outline-none data-[highlighted]:bg-card-2 data-[state=open]:bg-card-2';

/** What assigning changes, under the list. */
export function assignNote(item: AttentionItem): string {
  if (LEAD_KINDS.has(item.kind)) return 'This makes them the lead’s owner too.';
  if (item.kind === 'customer_waiting') return 'This assigns them the conversation too.';
  if (item.kind === 'overdue_task') return 'This makes it their task too.';
  return 'For appointments and approvals, this assigns only the item.';
}

function heading(item: AttentionItem): string {
  const name = customerOf(item);
  return !name || item.kind === 'unconfirmed_appointment' || item.kind === 'ai_approval'
    ? 'Assign this item to'
    : `Assign ${name} to`;
}

/** Assign… in the ⋯ menu: the team, with a tick on whoever has it now. */
export function AssignSubmenu({ item }: { item: AttentionItem }) {
  const env = useAttentionEnv();
  const current = item.assignee;
  return (
    <Menu.Sub>
      <Menu.SubTrigger className={ITEM} data-testid="attention-assign">
        <UserRound className="h-4 w-4 text-text-2" strokeWidth={1.5} />
        <span>Assign…</span>
        <span className="ml-auto pl-3 text-xs text-text-3">
          {current
            ? current.id === env.myUserId
              ? 'You'
              : firstNameOf(current.fullName)
            : 'Nobody'}
        </span>
      </Menu.SubTrigger>
      <Menu.Portal>
        <Menu.SubContent
          sideOffset={6}
          alignOffset={-6}
          className="z-40 w-[300px] max-w-[calc(100vw-32px)] rounded-menu border border-border bg-card p-1.5 shadow-2"
          data-testid="assign-menu"
        >
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {heading(item)}
          </div>
          {env.members.map((m) => (
            <Menu.Item
              key={m.id}
              className={ITEM}
              data-testid={`assign-${m.id}`}
              onSelect={() => env.act.assign(item, m.id)}
            >
              <Avatar name={m.fullName} seed={m.id} size="sm" />
              <span className="min-w-0 truncate">
                {m.fullName} <span className="text-xs text-text-3">· {ROLE[m.role]}</span>
              </span>
              {current?.id === m.id ? (
                <Check className="ml-auto h-4 w-4 flex-none text-accent-text" strokeWidth={2} />
              ) : null}
            </Menu.Item>
          ))}
          <Menu.Separator className="my-1 h-px bg-border" />
          <div className="flex items-start gap-1.5 px-2 pb-1 pt-1.5 text-xs leading-[1.4] text-text-3">
            <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
            <span>{assignNote(item)}</span>
          </div>
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}

/** The team as 52 px rows, in a phone's bottom sheet. */
export function AssignList({
  item,
  onPick,
  onBack,
}: {
  item: AttentionItem;
  onPick: (userId: string) => void;
  onBack: () => void;
}) {
  const env = useAttentionEnv();
  const current = item.assignee;
  return (
    <div data-testid="assign-menu">
      <button
        type="button"
        onClick={onBack}
        className="flex min-h-11 items-center gap-2 px-1 text-[13px] font-medium text-accent-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        Back
      </button>
      <div className="px-1 pb-0.5 pt-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {heading(item)}
      </div>
      {env.members.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onPick(m.id)}
          data-testid={`assign-${m.id}`}
          className={cn(
            'flex min-h-[52px] w-full items-center gap-3 border-t border-border px-1 py-1.5 text-left text-[15px]',
          )}
        >
          <Avatar name={m.fullName} seed={m.id} size="sm" />
          <span className="min-w-0 flex-1 truncate">
            {m.fullName} <span className="text-[13px] text-text-3">· {ROLE[m.role]}</span>
          </span>
          {current?.id === m.id ? (
            <Check className="h-5 w-5 flex-none text-accent-text" strokeWidth={2} />
          ) : null}
        </button>
      ))}
      <p className="flex items-start gap-1.5 border-t border-border px-1 pt-2.5 text-xs leading-[1.4] text-text-3">
        <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        {assignNote(item)}
      </p>
    </div>
  );
}
