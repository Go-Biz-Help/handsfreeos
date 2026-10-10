'use client';
/**
 * "Is this one of these?": before someone goes in Contacts from Social Outreach, the customers already there with the
 * same name (`outreach.lookup`), so the person says "It's them" rather than making a second. Used by Add to Contacts
 * (./person-menu.tsx) and Save to their card (./chat-keep.tsx).
 */
import {
  OUTREACH_WORDS,
  sameNamePeople,
  type SameNamePerson,
} from '@hfos/core/addons/outreach/words';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, unwrap } from '@/lib/api/client';

const P = OUTREACH_WORDS.person;

export type SameName = SameNamePerson;

/**
 * Customers in Contacts with this name. For someone kept as a profile, only those not saved with a Facebook profile
 * yet: one who is has a profile of their own, so is someone else.
 */
export async function sameNamesFor(
  workspaceId: string,
  name: string,
  { withoutProfile }: { withoutProfile: boolean },
): Promise<SameName[]> {
  const found = unwrap(
    await apiBrowser().POST('/v1/queries/outreach.lookup', {
      body: { workspaceId, names: [name] },
    }),
  );
  return sameNamePeople(found, { withoutProfile });
}

export function SameNameDialog({
  name,
  people,
  busy,
  onPick,
  onNew,
  onClose,
}: {
  name: string;
  people: readonly SameName[];
  busy: boolean;
  onPick: (personId: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={P.sameTitle(name)} description={P.sameAbout}>
        <ul className="mt-4 grid gap-2" data-testid="person-same-name">
          {people.map((p) => (
            <li
              key={p.personId}
              className="flex items-center justify-between gap-3 rounded-menu bg-card-2 p-2.5"
            >
              <span className="min-w-0 text-[13px]">
                <span className="font-medium">{p.name}</span>
                <span className="block text-[12px] text-text-3">{p.detail}</span>
              </span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onPick(p.personId)}
                data-testid="person-same-them"
              >
                {P.itsThem}
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" disabled={busy} onClick={onNew} data-testid="person-same-new">
            {P.addAsNew}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
