'use client';
/**
 * Start fresh, on Social Outreach's Settings tab for owners (docs/outreach.md, "Starting fresh"): everything it keeps
 * for the business erased, after typing its name, and it comes back empty, ready to set up (`addon.start_fresh`, the
 * moves an owner would make on Settings → Add-ons one after another). Then Settings → Add-ons shows it coming back.
 */
import { START_FRESH_WORDS as F } from '@hfos/core/addons/outreach/words';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useAct } from './use-act';

const NAME = 'Social Outreach';

export function StartFresh({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const { busy, errors, act } = useAct();
  const typedRight = typed.trim().toLowerCase() === NAME.toLowerCase();
  const go = () =>
    void act(
      'fresh',
      async () => {
        unwrap(
          await apiBrowser().POST('/v1/commands/addon.start_fresh', {
            body: { workspaceId, addonId: 'outreach', confirmName: typed },
          }),
        );
        setOpen(false);
        router.push(`/app/w/${workspaceId}/add-ons`);
      },
      F.started,
    );
  return (
    <section
      className="space-y-3 rounded-card border border-border bg-card p-4"
      data-testid="outreach-start-fresh"
    >
      <h2 className="text-[15px] font-semibold">{F.title}</h2>
      <p className="text-[13px] text-text-2">{F.about}</p>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setTyped('');
        }}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="outreach-start-fresh-open"
        >
          {F.button}
        </Button>
        <DialogContent title={F.confirmTitle} description={F.confirmAbout}>
          <form
            className="mt-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (typedRight) go();
            }}
          >
            <Field
              label={F.typeName}
              htmlFor="outreach-start-fresh-name"
              error={errors.confirmName}
            >
              <Input
                id="outreach-start-fresh-name"
                autoComplete="off"
                autoFocus
                placeholder={NAME}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                data-testid="outreach-start-fresh-name"
              />
            </Field>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                loading={busy === 'fresh'}
                disabled={!typedRight || busy !== null}
                data-testid="outreach-start-fresh-yes"
              >
                {F.yes}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
