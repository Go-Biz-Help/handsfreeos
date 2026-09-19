'use client';
import { Download, Link2, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { CopyField } from '@/components/ui/copy-field';
import { Field, Hint } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FormSummary } from '@/lib/api/types';

/**
 * The four ways a form reaches people: the link, a website embed, the AI teammate asking it in a
 * conversation, and a QR code for a truck door. The link and the QR need nothing set up; the embed needs
 * the sites it may appear on, which is also what stops anybody else framing it.
 */
export function FormShare({
  workspaceId,
  form,
  siteSlug,
  canManage,
}: {
  workspaceId: string;
  form: FormSummary;
  siteSlug: string | null;
  canManage: boolean;
}) {
  const [origins, setOrigins] = useState(form.embedOrigins.join('\n'));
  const [inChat, setInChat] = useState(form.inChat);
  const [qr, setQr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const link =
    siteSlug && typeof window !== 'undefined'
      ? `${window.location.origin}/f/${siteSlug}/${form.slug}`
      : siteSlug
        ? `/f/${siteSlug}/${form.slug}`
        : null;

  useEffect(() => {
    if (!link) return;
    void QRCode.toDataURL(link, { margin: 1, width: 512 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [link]);

  async function save(next: { embedOrigins?: string[]; inChat?: boolean }) {
    setSaving(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/form.set_delivery', {
          body: { workspaceId, formId: form.formId, ...next },
        }),
      );
      toast.success('Saved.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (form.status === 'draft')
    return (
      <Card className="px-6 py-10 text-center">
        <Link2 className="mx-auto h-7 w-7 text-text-3" strokeWidth={1.5} />
        <h2 className="mt-3 text-[15px] font-medium text-text">Not shared yet</h2>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-2">
          Publish it and the link, the embed and the QR code appear here.
        </p>
      </Card>
    );

  const embedSnippet = link
    ? `<iframe src="${link}?embed=1" title="${form.name}" width="100%" height="720" style="border:0" loading="lazy"></iframe>`
    : '';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-4 p-4">
        <div>
          <h3 className="text-[14px] font-medium text-text">The link</h3>
          <p className="mt-0.5 text-[12.5px] text-text-3">
            Text it, email it, put it in a signature. It keeps working if you rename the form.
          </p>
        </div>
        {link ? <CopyField value={link} label="Copy the link" copied="Copied the link" /> : null}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <QrCode className="mt-0.5 h-5 w-5 shrink-0 text-text-3" strokeWidth={1.75} />
          <div>
            <h3 className="text-[14px] font-medium text-text">QR code</h3>
            <p className="mt-0.5 text-[12.5px] text-text-3">
              For a truck door, a yard sign or the counter.
            </p>
          </div>
        </div>
        {qr ? (
          <div className="flex items-center gap-4">
            {/* A data: URL made in this browser: no loader, no request. */}
            <img
              src={qr}
              alt="QR code for the form"
              className="h-28 w-28 rounded-card border border-border"
            />
            <a
              href={qr}
              download={`${form.slug}-qr.png`}
              className="inline-flex h-9 items-center gap-2 rounded-control border border-border-strong bg-card px-3.5 text-sm font-medium text-text shadow-1 hover:bg-card-2"
            >
              <Download className="h-4 w-4" strokeWidth={1.75} />
              Download
            </a>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <h3 className="text-[14px] font-medium text-text">On your own website</h3>
          <p className="mt-0.5 text-[12.5px] text-text-3">
            Paste the snippet where you want the form. Only the sites you list here may show it.
          </p>
        </div>
        <Field
          label="Sites allowed to show it"
          htmlFor="embed-origins"
          hint="One per line, like https://example.com. Empty means it isn’t embedded anywhere."
        >
          <Input
            id="embed-origins"
            placeholder="https://example.com"
            value={origins}
            disabled={!canManage || saving}
            onChange={(e) => setOrigins(e.target.value)}
            onBlur={() =>
              save({
                embedOrigins: origins
                  .split(/[\s,]+/)
                  .map((o: string) => o.trim().toLowerCase())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        {embedSnippet ? (
          <CopyField value={embedSnippet} label="Copy the snippet" copied="Copied the snippet" />
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[14px] font-medium text-text">Let the AI teammate ask it</h3>
            <Hint>
              In a text or a chat, it asks these questions one at a time instead of sending a link.
            </Hint>
          </div>
          <Switch
            label="Let the AI teammate ask it"
            checked={inChat}
            disabled={!canManage || saving}
            onChange={(on) => {
              setInChat(on);
              void save({ inChat: on });
            }}
            testId="form-in-chat"
          />
        </div>
      </Card>
    </div>
  );
}
