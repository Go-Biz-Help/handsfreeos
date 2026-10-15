'use client';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/errors';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Offer } from '@/lib/api/types';
import { archiveOffer, createOffer, updateOffer, type OfferFields } from '@/lib/knowledge/actions';
import { formatDateOnly } from '@/lib/format';

const STATE: Record<Offer['state'], { label: string; variant: 'ok' | 'pending' | 'gray' }> = {
  live: { label: 'Running now', variant: 'ok' },
  upcoming: { label: 'Starts later', variant: 'pending' },
  ended: { label: 'Ended', variant: 'gray' },
};

const BLANK: OfferFields = { name: '', details: '', startsOn: null, endsOn: null };

/** "Through Oct 31", "From Nov 1", "Nov 1 – Nov 30", or "No end date". */
function when(o: { startsOn: string | null; endsOn: string | null }): string {
  const d = formatDateOnly;
  if (o.startsOn && o.endsOn) return `${d(o.startsOn)} – ${d(o.endsOn)}`;
  if (o.endsOn) return `Through ${d(o.endsOn)}`;
  if (o.startsOn) return `From ${d(o.startsOn)}`;
  return 'No end date';
}

/**
 * Offers (M18): a short list the owner types in — a name, the details, and the dates it runs. The AI teammate
 * tells customers about the ones running today and never makes one up.
 */
export function OfferList({
  workspaceId,
  canManage,
  offers,
}: {
  workspaceId: string;
  canManage: boolean;
  offers: readonly Offer[];
}) {
  const router = useRouter();
  // null: no form open; 'new': adding; an id: editing that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<OfferFields>(BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const open = (o: Offer | null) => {
    setErrors({});
    setDraft(
      o ? { name: o.name, details: o.details, startsOn: o.startsOn, endsOn: o.endsOn } : BLANK,
    );
    setEditing(o ? o.id : 'new');
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return setErrors({ name: 'Name the promotion.' });
    setBusy(true);
    setErrors({});
    try {
      if (editing === 'new') await createOffer(workspaceId, draft);
      else if (editing) await updateOffer(workspaceId, editing, draft);
      toast.success(editing === 'new' ? 'Promotion added.' : 'Promotion saved.');
      setEditing(null);
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(o: Offer) {
    setBusy(true);
    try {
      await archiveOffer(workspaceId, o.id);
      toast.success(`Removed “${o.name}”.`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <Card className="flex flex-col gap-3 p-4" data-testid="offer-form">
      <form onSubmit={save} noValidate className="flex flex-col gap-3">
        <Field label="Name" htmlFor="offer-name" error={errors.name}>
          <Input
            id="offer-name"
            value={draft.name}
            maxLength={120}
            placeholder="$50 off a furnace tune-up"
            invalid={!!errors.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field
          label="Details"
          htmlFor="offer-details"
          hint="Who it’s for and anything the customer needs to know."
          error={errors.details}
        >
          <Textarea
            id="offer-details"
            value={draft.details}
            maxLength={1000}
            placeholder="New customers only. Book by the end of the month."
            onChange={(e) => setDraft({ ...draft, details: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts" htmlFor="offer-starts" hint="Leave empty to start now.">
            <Input
              id="offer-starts"
              type="date"
              value={draft.startsOn ?? ''}
              onChange={(e) => setDraft({ ...draft, startsOn: e.target.value || null })}
            />
          </Field>
          <Field
            label="Ends"
            htmlFor="offer-ends"
            hint="The last day it runs. Leave empty for no end."
            error={errors.endsOn}
          >
            <Input
              id="offer-ends"
              type="date"
              value={draft.endsOn ?? ''}
              invalid={!!errors.endsOn}
              onChange={(e) => setDraft({ ...draft, endsOn: e.target.value || null })}
            />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy} data-testid="offer-save">
            {editing === 'new' ? 'Add promotion' : 'Save'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );

  return (
    <div className="flex max-w-[760px] flex-col gap-3" data-testid="offers">
      <p className="text-[13px] leading-[1.5] text-text-2">
        What you’re running right now. Your AI teammate tells customers about the promotions that
        are running today, and never makes one up. It doesn’t take them off a bill; your team does.
      </p>
      {canManage && editing === null ? (
        <div>
          <Button size="sm" onClick={() => open(null)} data-testid="offer-add">
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Add a promotion
          </Button>
        </div>
      ) : null}
      {editing === 'new' ? form : null}
      {!offers.length && editing !== 'new' ? (
        <EmptyState title="No promotions yet" dashed>
          Add one and your AI teammate starts sharing it right away.
        </EmptyState>
      ) : null}
      {offers.map((o) =>
        editing === o.id ? (
          <div key={o.id}>{form}</div>
        ) : (
          <Card key={o.id} className="flex items-start gap-3 p-4" data-testid={`offer-${o.id}`}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{o.name}</span>
                <Badge variant={STATE[o.state].variant} className="h-5 text-[11.5px]">
                  {STATE[o.state].label}
                </Badge>
              </div>
              {o.details ? <p className="text-[13px] text-text-2">{o.details}</p> : null}
              <span className="text-xs text-text-3">{when(o)}</span>
            </div>
            {canManage ? (
              <div className="flex flex-none gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${o.name}`}
                  disabled={busy || editing !== null}
                  onClick={() => open(o)}
                >
                  <Pencil className="h-4 w-4" strokeWidth={1.75} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${o.name}`}
                  disabled={busy || editing !== null}
                  onClick={() => void remove(o)}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </div>
            ) : null}
          </Card>
        ),
      )}
    </div>
  );
}
