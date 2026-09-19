'use client';
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Template } from '@/lib/api/types';

const CHANNEL_LABEL = { sms: 'Text', email: 'Email' } as const;

/** Wording that has never been used says so, rather than showing a zero nobody needs to read. */
function usedLabel(template: Template): string {
  if (template.usedCount === 0) return 'Not used yet';
  return template.usedCount === 1 ? 'Used once' : `Used ${template.usedCount} times`;
}

/**
 * The wording library: writing a piece, changing it, filing it, and putting it away.
 *
 * Archived wording stays on the screen behind a toggle rather than disappearing, because "where did the
 * quote follow-up go?" is the question this screen exists to never cause.
 */
export function TemplatesEditor({
  workspaceId,
  templates,
  folders,
}: {
  workspaceId: string;
  templates: Template[];
  folders: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const open = templates.filter((t) => !t.archivedAt);
  const archived = templates.filter((t) => t.archivedAt);
  const shown = showArchived ? archived : open;
  const groups = [...new Set(shown.map((t) => t.folder ?? ''))].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
  );

  async function call(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const channel = String(form.get('channel') ?? 'sms') as 'sms' | 'email';
    const body = {
      workspaceId,
      name: String(form.get('name') ?? '').trim(),
      channel,
      // A text has no subject line, and sending one would send nothing.
      subject: channel === 'email' ? String(form.get('subject') ?? '').trim() || null : null,
      body: String(form.get('body') ?? '').trim(),
      folder: String(form.get('folder') ?? '').trim() || null,
    };
    const existing = editing !== 'new' && editing ? editing : null;
    await call(
      'save',
      async () =>
        unwrap(
          existing
            ? await apiBrowser().POST('/v1/commands/template.update', {
                body: { ...body, templateId: existing.id },
              })
            : await apiBrowser().POST('/v1/commands/template.create', { body }),
        ),
      existing ? 'Saved.' : 'Template saved.',
    );
    setEditing(null);
  }

  const putAway = (template: Template, restore: boolean) =>
    call(
      `archive-${template.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/template.archive', {
            body: { workspaceId, templateId: template.id, restore },
          }),
        ),
      restore ? 'Back in the list.' : 'Put away.',
    );

  const draft = editing === 'new' ? null : editing;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={showArchived ? 'ghost' : 'secondary'}
            onClick={() => setShowArchived(false)}
          >
            In use ({open.length})
          </Button>
          {archived.length > 0 && (
            <Button
              size="sm"
              variant={showArchived ? 'secondary' : 'ghost'}
              onClick={() => setShowArchived(true)}
            >
              Put away ({archived.length})
            </Button>
          )}
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-4" /> New template
        </Button>
      </div>

      {shown.length === 0 && (
        <Card className="p-6 text-center text-[13px] text-text-2">
          {showArchived
            ? 'Nothing has been put away.'
            : 'Nothing saved yet. Write the thing you type most often and it will be one click from now on.'}
        </Card>
      )}

      {groups.map((folder) => (
        <section key={folder || 'none'} className="space-y-2">
          {groups.length > 1 && (
            <h3 className="text-[13px] font-medium text-text-2">{folder || 'Everything else'}</h3>
          )}
          {shown
            .filter((t) => (t.folder ?? '') === folder)
            .map((template) => (
              <Card key={template.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{template.name}</span>
                    <Badge variant="gray">{CHANNEL_LABEL[template.channel]}</Badge>
                    <span className="text-[12px] text-text-2">{usedLabel(template)}</span>
                  </div>
                  {template.subject && (
                    <p className="truncate text-[13px] text-text-2">{template.subject}</p>
                  )}
                  <p className="mt-1 line-clamp-2 text-[13px] text-text-2">{template.body}</p>
                  {template.placeholders.length > 0 && (
                    <p className="mt-1 text-[12px] text-text-2">
                      Fills in: {template.placeholders.join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${template.name}`}
                    onClick={() => setEditing(template)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`${template.archivedAt ? 'Restore' : 'Put away'} ${template.name}`}
                    disabled={busy === `archive-${template.id}`}
                    onClick={() => void putAway(template, !!template.archivedAt)}
                  >
                    {template.archivedAt ? (
                      <ArchiveRestore className="size-4" />
                    ) : (
                      <Archive className="size-4" />
                    )}
                  </Button>
                </div>
              </Card>
            ))}
        </section>
      ))}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={draft ? 'Edit template' : 'New template'}>
          <form onSubmit={(e) => void save(e)} className="space-y-3">
            <Field label="Name" htmlFor="tpl-name">
              <Input
                id="tpl-name"
                name="name"
                defaultValue={draft?.name ?? ''}
                required
                maxLength={120}
              />
            </Field>
            <Field label="Send as" htmlFor="tpl-channel">
              <Select id="tpl-channel" name="channel" defaultValue={draft?.channel ?? 'sms'}>
                <option value="sms">Text</option>
                <option value="email">Email</option>
              </Select>
            </Field>
            <Field label="Subject" htmlFor="tpl-subject" hint="Email only.">
              <Input
                id="tpl-subject"
                name="subject"
                defaultValue={draft?.subject ?? ''}
                maxLength={200}
              />
            </Field>
            <Field
              label="Message"
              htmlFor="tpl-body"
              hint="Put {{person.first_name}} where a name goes — the same shorthand a workflow uses."
            >
              <Textarea
                id="tpl-body"
                name="body"
                defaultValue={draft?.body ?? ''}
                required
                rows={8}
              />
            </Field>
            <Field label="Folder" htmlFor="tpl-folder" hint="Optional, and one level deep.">
              <Input
                id="tpl-folder"
                name="folder"
                defaultValue={draft?.folder ?? ''}
                maxLength={60}
                list="template-folders"
              />
              <datalist id="template-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy === 'save'}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
