'use client';
import { Eye, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * Who sees which conversations (M17).
 *
 * **The confirmation says the part that looks like data loss**, because it is the part people call about: a
 * member's phone drops the threads they no longer see. That is correct — the phone keeps only what the person
 * may read — but somebody watching it happen sees an inbox emptying, and finding out afterwards is much
 * worse than being told first.
 *
 * Nothing about it is hidden: pressing Everyone still shows a member every thread they may see. What changes
 * is which threads that is.
 */
export function InboxVisibilityCard({
  workspaceId,
  perPerson,
}: {
  workspaceId: string;
  perPerson: boolean;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(perPerson);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const pick = (next: boolean) => {
    setChoice(next);
    setConfirming(next !== perPerson);
  };

  async function save() {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/inbox.set_visibility', {
          body: { workspaceId, perPerson: choice },
        }),
      );
      toast.success(
        choice
          ? `Saved. ${out.conversationsChanged} conversation${out.conversationsChanged === 1 ? '' : 's'} moved to the people who own them.`
          : 'Saved. Everyone can see every conversation again.',
      );
      setConfirming(false);
      router.refresh();
    } catch (e) {
      // The one refusal a business can actually hit: too many threads to repaint in one go.
      toast.error(errorMessage(e));
      setChoice(perPerson);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-[820px] px-[22px] py-5" data-testid="inbox-visibility-card">
      <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
        Who sees which conversations
      </h2>
      <p className="mt-1 max-w-[540px] text-[13px] text-text-2">
        You and your admins always see everything. This is about everybody else.
      </p>
      <div
        role="radiogroup"
        aria-label="Who sees which conversations"
        className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <RadioCard
          selected={!choice}
          onSelect={() => pick(false)}
          testId="inbox-visibility-everyone"
          title={
            <span className="flex items-center gap-2">
              <Eye className="h-4 w-4" strokeWidth={1.8} />
              Everyone sees everything
            </span>
          }
          description="Anyone on your team can open any conversation. This is how it works now."
        />
        <RadioCard
          selected={choice}
          onSelect={() => pick(true)}
          testId="inbox-visibility-own"
          title={
            <span className="flex items-center gap-2">
              <Users className="h-4 w-4" strokeWidth={1.8} />
              Each person sees their own
            </span>
          }
          description="The conversations assigned to them, and the ones on the numbers they answer. A new customer nobody has picked up yet is still seen by everybody."
        />
      </div>

      {confirming ? (
        <div className="mt-3 rounded-[10px] bg-card-2 p-3" data-testid="inbox-visibility-confirm">
          <p className="text-[13px] text-text-2">
            {choice
              ? 'Your team will only see their own conversations, on the web and on their phones. On a phone the others will disappear from the inbox — nothing is deleted, and they come back the moment you switch this off.'
              : 'Everyone on your team will be able to see every conversation again, on the web and on their phones.'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={busy}
              onClick={() => void save()}
              data-testid="inbox-visibility-save"
            >
              {choice ? 'Yes, narrow it' : 'Yes, open it up'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChoice(perPerson);
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
