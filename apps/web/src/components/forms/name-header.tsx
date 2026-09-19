'use client';
import { ArrowLeft, Check, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FormSummary } from '@/lib/api/types';
import { answersLine } from '@/lib/forms/words';
import { FormModeBadge } from './chips';

/** The form's name, changed in place, with the way back to the list. */
export function FormNameHeader({
  workspaceId,
  form,
  canManage,
}: {
  workspaceId: string;
  form: FormSummary;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(form.name);
  const [busy, setBusy] = useState(false);

  async function rename() {
    if (!name.trim() || name.trim() === form.name) {
      setEditing(false);
      setName(form.name);
      return;
    }
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/form.rename', {
          body: { workspaceId, formId: form.formId, name: name.trim() },
        }),
      );
      setEditing(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5">
      <Link
        href={`/app/w/${workspaceId}/forms`}
        className="inline-flex items-center gap-1.5 text-[12.5px] text-text-3 hover:text-text-2"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
        Forms
      </Link>
      <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
        {editing ? (
          <>
            <Input
              value={name}
              autoFocus
              className="max-w-sm"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename();
                if (e.key === 'Escape') {
                  setEditing(false);
                  setName(form.name);
                }
              }}
            />
            <Button size="sm" onClick={rename} loading={busy} aria-label="Save the name">
              <Check className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-[21px] font-semibold tracking-tight text-text">{form.name}</h1>
            {canManage ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Rename"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            ) : null}
          </>
        )}
        <FormModeBadge mode={form.mode} />
      </div>
      <p className="mt-1 text-[13px] text-text-3">
        {answersLine(form.responseCount)}
        {form.version ? ` · version ${form.version}` : ' · never published'}
      </p>
    </div>
  );
}
