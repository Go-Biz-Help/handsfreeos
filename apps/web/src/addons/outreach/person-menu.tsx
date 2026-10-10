'use client';
/**
 * Someone kept in Social Outreach as a profile, wherever the app shows them (docs/outreach.md, decision 43): on Today,
 * the Friends tab, the Chats tab and Waiting for you. Its menu has **Add to Contacts**, **Demo booked** and **Don't
 * pitch**, which the extension's panel had for any profile. Adding to Contacts looks for customers with the same name
 * first (./same-name.tsx), so the person says "It's them" rather than making a second; with none it adds them at once
 * (`outreach.profile.contact`, Facebook as the source).
 */
import { OUTREACH_WORDS } from '@hfos/core/addons/outreach/words';
import { Ban, CalendarCheck, MoreHorizontal, UserPlus, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { SameNameDialog, sameNamesFor, type SameName } from './same-name';
import { useAct } from './use-act';

const P = OUTREACH_WORDS.person;

/** Who the menu is for. A list that doesn't say leaves `personId` or `demoBooked` out. */
export interface MenuPerson {
  readonly profileId: string | null;
  readonly name: string;
  /** The customer they're saved to; left out where the list doesn't know. */
  readonly personId?: string | null;
  /** They booked a demo (`outreach.demo.mark`); left out where the list doesn't know. */
  readonly demoBooked?: boolean;
}

export function PersonMenu({
  workspaceId,
  who,
  dontPitch = true,
}: {
  workspaceId: string;
  who: MenuPerson;
  /** Offer Don't pitch: left off where the row has its own switch for it. */
  dontPitch?: boolean;
}) {
  const { busy, act } = useAct();
  const [same, setSame] = useState<readonly SameName[] | null>(null);
  const profileId = who.profileId;
  if (!profileId) return null;
  const contact = (personId: string | null) =>
    act(
      'contact',
      async () => {
        const saved = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.profile.contact', {
            body: { workspaceId, profileId, personId },
          }),
        );
        setSame(null);
        return saved;
      },
      personId ? P.tied(who.name) : P.added(who.name),
    );
  // Customers with the same name, not saved with a Facebook profile yet: the person says whether it's them.
  const addToContacts = () =>
    void act('contact', async () => {
      const people = await sameNamesFor(workspaceId, who.name, { withoutProfile: true });
      if (people.length) {
        setSame(people);
        return;
      }
      const saved = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.profile.contact', {
          body: { workspaceId, profileId, personId: null },
        }),
      );
      toast.success(saved.addedPerson ? P.added(who.name) : P.already(who.name));
    });
  const demo = (booked: boolean) =>
    void act(
      'demo',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.demo.mark', {
            body: { workspaceId, profileId, booked },
          }),
        ),
      booked ? P.demoMarked(who.name) : P.demoUnmarked,
    );
  const noPitch = () =>
    void act(
      'dont-pitch',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.friend.set', {
            body: { workspaceId, profileId, dontPitch: true },
          }),
        ),
      P.dontPitchDone(who.name),
    );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={P.menu(who.name)}
            className="h-7 w-7"
            loading={busy !== null}
            data-testid="person-menu"
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {who.personId ? (
            <DropdownMenuItem asChild>
              <Link
                href={`/app/w/${workspaceId}/customers/people/${who.personId}`}
                data-testid="person-in-contacts"
              >
                <UserRound className="h-4 w-4" strokeWidth={1.5} />
                {P.inContacts}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={addToContacts} data-testid="person-add-contact">
              <UserPlus className="h-4 w-4" strokeWidth={1.5} />
              {P.addToContacts}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => demo(!who.demoBooked)} data-testid="person-demo-mark">
            <CalendarCheck className="h-4 w-4" strokeWidth={1.5} />
            {who.demoBooked ? P.notDemo : P.demoBooked}
          </DropdownMenuItem>
          {dontPitch ? (
            <DropdownMenuItem danger onSelect={noPitch} data-testid="person-dont-pitch">
              <Ban className="h-4 w-4" strokeWidth={1.5} />
              {P.dontPitch}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {same ? (
        <SameNameDialog
          name={who.name}
          people={same}
          busy={busy !== null}
          onPick={(personId) => void contact(personId)}
          onNew={() => void contact(null)}
          onClose={() => setSame(null)}
        />
      ) : null}
    </>
  );
}
