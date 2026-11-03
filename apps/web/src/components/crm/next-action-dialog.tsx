'use client';
import { instantOfInput, zonedInputValue } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ZonePick } from '@/components/calendar/zone-field';
import { useBusinessZone } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';

/**
 * Sets (or clears) the one thing to do next on a lead. Its When reads on the business's clock, as the lead shows it,
 * with a Time zone pick for a call set on the customer's ("call Mike at 9 his time").
 */
export function NextActionDialog({
  workspaceId,
  leadId,
  leadTitle,
  open,
  onOpenChange,
  current,
  onSaved,
}: {
  workspaceId: string;
  leadId: string;
  leadTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current?: { text: string | null; at: string | null };
  onSaved?: () => void;
}) {
  const router = useRouter();
  const businessZone = useBusinessZone();
  const [text, setText] = useState('');
  const [at, setAt] = useState('');
  const [zone, setZone] = useState(businessZone);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText(current?.text ?? '');
    setAt(current?.at ? zonedInputValue(current.at, businessZone) : '');
    setZone(businessZone);
    setErrors({});
  }, [open, current?.text, current?.at, businessZone]);

  const atMs = at ? instantOfInput(at, zone) : null;
  // Left as it opened, the moment stays exactly as it was (the box only shows minutes).
  const untouched =
    !!current?.at && at === zonedInputValue(current.at, businessZone) && zone === businessZone;

  async function save(clear = false) {
    if (!clear && !text.trim()) return setErrors({ text: 'What happens next?' });
    setBusy(true);
    setErrors({});
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/lead.set_next_action', {
          body: {
            workspaceId,
            leadId,
            text: clear ? null : text.trim(),
            dueAt:
              clear || atMs === null
                ? null
                : untouched
                  ? new Date(current!.at!).toISOString()
                  : new Date(atMs).toISOString(),
          },
        }),
      );
      toast.success(clear ? 'Next action cleared.' : 'Next action set.');
      onOpenChange(false);
      onSaved?.();
      router.refresh();
    } catch (e) {
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Next action" description={`What is the next step on ${leadTitle}?`}>
        <form
          onSubmit={submit}
          className="mt-4 flex flex-col gap-3.5"
          noValidate
          data-testid="next-action-form"
        >
          <Field label="Next action" htmlFor="na-text" error={errors.text}>
            <Input
              id="na-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Call back about the estimate"
              autoFocus
              invalid={!!errors.text}
            />
          </Field>
          <Field
            label="When"
            htmlFor="na-at"
            hint="Optional. Shows on the pipeline card and in Tasks later."
          >
            <Input
              id="na-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          {at ? (
            <ZonePick
              id="na-zone"
              value={zone}
              onChange={setZone}
              businessZone={businessZone}
              at={atMs}
              testId="next-action-zone"
            />
          ) : null}
          <div className="mt-1 flex justify-end gap-2">
            {current?.text ? (
              <Button variant="ghost" onClick={() => void save(true)} disabled={busy}>
                Clear
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="next-action-save">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
