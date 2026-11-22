'use client';
import { contactFromSearch, NEW_CONTACT_WORDS, type ContactStart } from '@hfos/core';
import { UserPlus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useCan } from '@/components/shell/workspace-shell';
import { cn } from '@/lib/utils';
import { PersonDialog } from './person-dialog';

/** The contact just added (or the one who already had the number or email), as a picker hands them on. */
export interface NewContact {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * Adding a contact from a contact search, the same in every picker (core `new-contact.ts`): "Add “Dana Smith” as a new
 * contact" opens Add a person over the screen with what was typed already in it, and once she's saved she's the one
 * picked, without leaving. A number or email somebody already has offers them instead, and choosing them picks them.
 * Only for someone who may add contacts (`records.write`), and only where the picker allows it (`enabled`).
 */
export function useNewContact({
  workspaceId,
  enabled = true,
  onAdded,
}: {
  workspaceId: string;
  enabled?: boolean;
  onAdded: (contact: NewContact) => void;
}): { canAdd: boolean; begin: (typed: string) => void; dialog: ReactNode } {
  const can = useCan('records.write');
  const [start, setStart] = useState<ContactStart | null>(null);
  return {
    canAdd: enabled && can,
    begin: (typed) => setStart(contactFromSearch(typed)),
    dialog: start ? (
      <PersonDialog
        workspaceId={workspaceId}
        open
        onOpenChange={(open) => {
          if (!open) setStart(null);
        }}
        defaultName={start.name}
        defaultPhone={start.phone}
        defaultEmail={start.email}
        onSaved={(id, fullName, details) =>
          onAdded({
            id,
            fullName,
            email: details?.email ?? null,
            phone: details?.phone ?? null,
          })
        }
        onChooseMatch={(match) =>
          onAdded({ id: match.id, fullName: match.name, email: match.email, phone: match.phone })
        }
      />
    ) : null,
  };
}

/** The "Add “Dana Smith” as a new contact" row at the foot of a picker's list. */
export function AddContactOption({
  typed,
  onAdd,
  className,
}: {
  typed: string;
  onAdd: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-sm font-medium text-accent-text hover:bg-card-2 max-md:min-h-11',
        className,
      )}
      // Keeps the search box focused, so its own blur doesn't close the list before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAdd}
      data-testid="customer-add-new"
    >
      <UserPlus className="h-4 w-4 flex-none" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate">{NEW_CONTACT_WORDS.add(typed)}</span>
    </button>
  );
}
