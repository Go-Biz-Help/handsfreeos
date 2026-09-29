'use client';
import { GUIDE_WORDS, ONBOARDING_WORDS } from '@hfos/core';
import { ListChecks, LifeBuoy } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Asking HandsFreeOS for help from inside HandsFreeOS (M13).
 *
 * The advantage over an email is that we already know who they are, which business they are in and what
 * screen they were on, so nobody has to ask "which account is this?" as their first reply. The page is sent
 * with the message; nothing else about what is on it is.
 *
 * While the person's Getting started guide isn't finished, Get help is a short menu instead: the guide (brought
 * back to Home when they hid it, with a dot on Get help meanwhile) and the same "Ask us for help".
 */
export function GetHelp({
  workspaceId,
  className,
  guide,
}: {
  workspaceId: string;
  className?: string;
  /** This person's guide in this business (users.settings.onboarding); left out, Get help is only the form. */
  guide?: { readonly hidden: boolean; readonly finished: boolean };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return setError('Tell us what is going on.');
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/support.request.create', {
          body: {
            workspaceId,
            subject: subject.trim(),
            body: body.trim(),
            context: { page: pathname.slice(0, 200), platform: 'web' },
          },
        }),
      );
      setSent(out.number);
      setSubject('');
      setBody('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const home = `/app/w/${workspaceId}`;
  const showGuide = async () => {
    if (guide?.hidden) {
      try {
        const r = await apiBrowser().POST('/v1/commands/onboarding.set_view', {
          body: { workspaceId, hidden: false },
        });
        unwrap(r);
        toast(ONBOARDING_WORDS.shownAgain);
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
    }
    router.push(`${home}#getting-started`);
    router.refresh();
  };
  const trigger = cn(
    'flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-sm font-medium text-text-2 hover:bg-card-2 hover:text-text',
    className,
  );
  const label = (
    <>
      <LifeBuoy className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
      Get help
    </>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {guide && !guide.finished ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-testid="get-help" className={trigger}>
              {label}
              {guide.hidden ? (
                <span
                  className="ml-auto h-2 w-2 rounded-full bg-accent"
                  aria-label="Getting started isn’t finished"
                  data-testid="get-help-dot"
                />
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuItem
              className="h-auto py-2"
              onSelect={() => void showGuide()}
              data-testid="get-help-guide"
            >
              <ListChecks className="h-4 w-4 flex-none text-text-2" strokeWidth={1.5} />
              <span className="flex flex-col">
                <span className="font-medium">{GUIDE_WORDS.menuItem}</span>
                <span className="text-xs text-text-3">
                  {guide.hidden ? GUIDE_WORDS.menuShow : GUIDE_WORDS.menuOnHome}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setOpen(true)} data-testid="get-help-ask">
              <LifeBuoy className="h-4 w-4 flex-none text-text-2" strokeWidth={1.5} />
              {GUIDE_WORDS.askForHelp}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="get-help"
          className={trigger}
        >
          {label}
        </button>
      )}
      <DialogContent
        title="Ask us for help"
        description="A person reads these, Monday to Friday, and answers by email. We already know which business you are in and what screen you were on."
      >
        {sent ? (
          <div className="mt-4">
            <p className="text-sm">
              Got it — that is ticket <strong>#{sent}</strong>. We will answer by email.
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                setSent(null);
                setOpen(false);
              }}
            >
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={send} className="mt-4 flex flex-col gap-4">
            <Field label="In a few words" htmlFor="help-subject">
              <Input
                id="help-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Appointment reminders stopped going out"
                data-testid="help-subject"
              />
            </Field>
            <Field
              label="What happened?"
              htmlFor="help-body"
              hint="What you were doing, what you expected, and roughly when. Do not include passwords or card numbers."
            >
              <Textarea
                id="help-body"
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                data-testid="help-body"
              />
            </Field>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy} data-testid="help-send">
                Send it
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
