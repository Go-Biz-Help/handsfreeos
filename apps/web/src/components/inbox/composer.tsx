'use client';
import { formatClock } from '@hfos/core';
import {
  CircleAlert,
  Clock,
  Image as ImageIcon,
  MessageCircle,
  Moon,
  Paperclip,
  Send,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { uploadFile } from '@/components/files/upload-zone';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { ConversationGet, PhoneSetupStatus } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChannelIcon, QuietStrip, SegmentCounter } from './bits';
import type { PendingText } from './hooks';

const PHOTO_TYPES = 'image/jpeg,image/png,image/gif';

interface Attachment {
  readonly fileId: string;
  readonly name: string;
  readonly preview: string;
}

/** What the composer needs to know about who it texts and whether it can. */
export interface ComposerTarget {
  readonly workspaceId: string;
  /** The conversation, or the customer when there isn't one yet (the record page). */
  readonly conversationId?: string;
  readonly personId?: string | null;
  /** "Mike", or null for a number nobody has linked. */
  readonly firstName: string | null;
  /** "(713) 555-0142". */
  readonly phoneDisplay: string;
  readonly canText: ConversationGet['canText'];
  readonly quiet: ConversationGet['quiet'];
  readonly fromNumber: string | null;
  readonly businessName?: string;
}

/** The note that replaces the box when texting can't happen, and the box's placeholder then. */
function blocked(target: ComposerTarget, setup: PhoneSetupStatus | null) {
  const who = target.firstName ?? 'this number';
  switch (target.canText.reason) {
    case 'opted_out':
      return {
        tone: 'danger' as const,
        icon: CircleAlert,
        body: (
          <>
            Texting is off for {who}. They can text <strong>START</strong> to turn it back on.
          </>
        ),
        placeholder: `You can’t text ${who} right now`,
      };
    case 'not_ready': {
      const reg = setup?.registrations.find(
        (r) => r.status === 'submitted' || r.status === 'in_review',
      );
      const tollFree = setup?.number?.numberType !== 'local';
      return {
        tone: 'info' as const,
        icon: Clock,
        body: (
          <>
            Texting turns on when the carriers approve your registration.
            {reg?.submittedAt ? ` In review since ${formatDate(reg.submittedAt)},` : ''}
            {reg?.submittedAt ? ` usually ${tollFree ? 'a few days' : '1 to 3 weeks'}.` : ''} Calls
            already work.{' '}
            <Link
              href={`/app/w/${target.workspaceId}/settings/texting`}
              className="font-medium underline"
            >
              See status
            </Link>
          </>
        ),
        placeholder: 'Texting isn’t on yet',
      };
    }
    case 'no_phone':
      return {
        tone: 'warning' as const,
        icon: CircleAlert,
        body: <>Add a mobile number to text {who}.</>,
        placeholder: `No mobile number for ${who}`,
      };
    case 'email_channel':
      return {
        tone: 'info' as const,
        icon: MessageCircle,
        body: (
          <>
            Email replies arrive with the email setup. Texts to this customer have their own thread.
          </>
        ),
        placeholder: 'Email replies aren’t on yet',
      };
    default:
      return null;
  }
}

/**
 * Write a text: Enter sends and Shift+Enter adds a line, photos ride along as a picture message, and quiet
 * hours ask "send it now anyway?" before anything goes out. `variant` picks the desktop box, the phone's
 * rounded input, or the record page's sheet.
 */
export function Composer({
  target,
  variant,
  onPending,
  onSettled,
  onDropPending,
  onSent,
}: {
  target: ComposerTarget;
  variant: 'desktop' | 'phone' | 'sheet';
  onPending?: (p: Omit<PendingText, 'messageId' | 'error'>) => void;
  onSettled?: (clientId: string, result: { messageId?: string }) => void;
  onDropPending?: (clientId: string) => void;
  onSent?: (out: { messageId: string; conversationId: string }) => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmQuiet, setConfirmQuiet] = useState(false);
  const [setup, setSetup] = useState<PhoneSetupStatus | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const reason = target.canText.reason;
  const off = !target.canText.ok;
  const note = blocked(target, setup);
  const who = target.firstName ?? target.phoneDisplay;

  // "In review since…" needs the registration; only fetched when it matters.
  useEffect(() => {
    if (reason !== 'not_ready') return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/phone.setup_status', { body: { workspaceId: target.workspaceId } })
      .then((r) => {
        if (!cancelled) setSetup(unwrap(r));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reason, target.workspaceId]);

  // Photo previews are local object URLs: let them go with the component.
  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.preview)), [files]);

  // The textarea grows with the draft, up to about six lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  async function attach(list: FileList | null) {
    if (!list || !target.personId) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const fileId = await uploadFile(target.workspaceId, 'person', target.personId, file);
        setFiles((all) => [
          ...all,
          { fileId, name: file.name, preview: URL.createObjectURL(file) },
        ]);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  async function send(acknowledgeQuietHours: boolean) {
    const body = text.trim();
    if (!body || busy || off) return;
    if (target.quiet.quiet && !acknowledgeQuietHours) {
      setConfirmQuiet(true);
      return;
    }
    const clientId = crypto.randomUUID();
    onPending?.({ clientId, body, at: new Date().toISOString() });
    setText('');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/message.send', {
          body: {
            workspaceId: target.workspaceId,
            ...(target.conversationId
              ? { conversationId: target.conversationId }
              : { personId: target.personId! }),
            channel: 'sms',
            body,
            attachmentFileIds: files.map((f) => f.fileId),
            clientId,
            acknowledgeQuietHours,
          },
        }),
      );
      onSettled?.(clientId, { messageId: out.messageId });
      setFiles([]);
      setConfirmQuiet(false);
      onSent?.({ messageId: out.messageId, conversationId: out.conversationId });
    } catch (e) {
      onDropPending?.(clientId);
      setText(body);
      if (e instanceof ApiError && e.rule === 'quiet_hours') setConfirmQuiet(true);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(false);
    }
  }

  const placeholder = off
    ? (note?.placeholder ?? 'Texting isn’t available')
    : `Text ${target.firstName ?? target.phoneDisplay}…`;
  const hidden = (
    <input
      ref={fileInput}
      type="file"
      accept={PHOTO_TYPES}
      multiple
      className="sr-only"
      aria-label="Choose photos"
      data-testid="composer-file"
      onChange={(e) => {
        void attach(e.target.files);
        e.target.value = '';
      }}
    />
  );
  const tray =
    files.length > 0 ? (
      <div className="flex items-center gap-2" data-testid="attachment-tray">
        {files.map((f) => (
          <div key={f.fileId} className="relative h-16 w-16 flex-none">
            {/* A local preview of a photo about to be sent. */}
            <img
              src={f.preview}
              alt={f.name}
              className="h-16 w-16 rounded-[10px] border border-border object-cover"
            />
            <button
              type="button"
              aria-label={`Remove ${f.name}`}
              onClick={() => setFiles((all) => all.filter((x) => x.fileId !== f.fileId))}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-text text-card"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        ))}
        <span className="flex-1 text-xs text-text-3">
          Photos you send are saved to {target.firstName ? `${target.firstName}’s` : 'their'} files
          too.
        </span>
      </div>
    ) : null;
  const quietLine = `It’s ${formatClock(target.quiet.localTime)} where the business is.${
    target.quiet.endsAt ? ` Quiet hours end at ${formatClock(target.quiet.endsAt)}.` : ''
  }`;

  if (variant === 'phone')
    return (
      <div className="flex-none border-t border-border bg-card" data-testid="composer">
        {note ? (
          <Callout tone={note.tone} icon={note.icon} className="mx-3 mt-2.5 px-3 py-2.5">
            {note.body}
          </Callout>
        ) : null}
        {tray ? <div className="px-3 pt-2.5">{tray}</div> : null}
        <div className="flex items-end gap-1.5 px-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2">
          {hidden}
          <button
            type="button"
            title="Attach a photo"
            aria-label="Attach a photo"
            disabled={off || uploading || !target.personId}
            onClick={() => fileInput.current?.click()}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2 disabled:opacity-45"
          >
            <Paperclip className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
          <textarea
            ref={area}
            rows={1}
            value={text}
            disabled={off}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            enterKeyHint="send"
            aria-label="Message"
            placeholder={placeholder}
            className="min-h-11 flex-1 resize-none rounded-[22px] border border-border-strong bg-card px-4 py-[10px] text-base leading-[1.4] placeholder:text-placeholder focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring disabled:border-border disabled:bg-card-2"
          />
          <button
            type="button"
            title="Send"
            aria-label="Send"
            data-testid="composer-send"
            disabled={off || busy || !text.trim()}
            onClick={() => void send(false)}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-white disabled:opacity-45"
          >
            <Send className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
        </div>
        <Sheet open={confirmQuiet} onOpenChange={setConfirmQuiet}>
          <SheetContent title="Quiet hours" hideHeader>
            <div className="flex items-start gap-3">
              <ChannelIcon icon={Moon} tone="warning" size={40} />
              <div className="flex flex-col gap-1">
                <h3 className="text-[15px] font-semibold">
                  It’s {formatClock(target.quiet.localTime)} where the business is
                </h3>
                <p className="text-[13px] text-text-2">
                  Quiet hours
                  {target.quiet.endsAt ? ` end at ${formatClock(target.quiet.endsAt)}` : ' are on'}.
                  Send this text to {who} now anyway?
                </p>
              </div>
            </div>
            <div className="mt-[18px] flex flex-col gap-2">
              <Button size="lg" onClick={() => void send(true)} data-testid="quiet-send-now">
                Send now
              </Button>
              <Button size="lg" variant="ghost" onClick={() => setConfirmQuiet(false)}>
                Keep it as a draft
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );

  return (
    <div
      className={cn(
        'flex flex-none flex-col gap-2 border-t border-border bg-card',
        variant === 'sheet' ? 'px-5 pb-2.5 pt-3' : 'px-4 py-3',
      )}
      data-testid="composer"
    >
      {variant === 'desktop' ? (
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2">
            <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
            Text
          </span>
          {target.fromNumber ? (
            <span className="truncate text-xs text-text-3">
              From {target.businessName ? `${target.businessName} · ` : ''}
              {target.fromNumber}
            </span>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <Callout
          tone={note.tone}
          icon={note.icon}
          className="px-3 py-2.5"
          data-testid="composer-note"
        >
          {note.body}
        </Callout>
      ) : target.quiet.quiet ? (
        <QuietStrip>{quietLine}</QuietStrip>
      ) : null}
      {tray}
      <div
        className={cn(
          'rounded-card border transition-[border-color,box-shadow]',
          off
            ? 'cursor-not-allowed border-border bg-card-2'
            : 'border-border-strong bg-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring',
        )}
      >
        {hidden}
        <textarea
          ref={area}
          rows={variant === 'sheet' ? 3 : 2}
          value={text}
          disabled={off}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message"
          placeholder={placeholder}
          className="block min-h-[46px] w-full resize-none bg-transparent px-3 pb-0.5 pt-2.5 text-[14.5px] leading-[1.45] placeholder:text-placeholder focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-1">
          <Button
            variant="ghost"
            size="icon"
            title={target.personId ? 'Attach a photo' : 'Add them as a customer to send photos'}
            aria-label="Attach a photo"
            disabled={off || uploading || !target.personId}
            loading={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? null : <Paperclip className="h-[18px] w-[18px]" strokeWidth={1.5} />}
          </Button>
          {variant === 'desktop' ? (
            <span className="hidden pl-0.5 text-xs text-text-3 lg:inline">
              Enter sends · Shift+Enter adds a line
            </span>
          ) : null}
          <span className="flex-1" />
          {off ? null : <SegmentCounter text={text} photos={files.length} />}
          <Button
            size="sm"
            disabled={off || busy || !text.trim()}
            loading={busy}
            onClick={() => void send(false)}
            data-testid="composer-send"
          >
            {busy ? null : <Send className="h-3.5 w-3.5" strokeWidth={1.5} />}
            {target.quiet.quiet && !off ? 'Send…' : 'Send text'}
          </Button>
        </div>
      </div>
      {confirmQuiet ? (
        <div className="flex items-center justify-end gap-2" data-testid="quiet-confirm">
          <span className="flex-1 text-xs text-text-2">Send it now anyway?</span>
          <Button variant="ghost" size="sm" onClick={() => setConfirmQuiet(false)}>
            Keep as draft
          </Button>
          <Button size="sm" onClick={() => void send(true)} data-testid="quiet-send-now">
            Send now
          </Button>
        </div>
      ) : null}
      {files.length === 0 && uploading ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-text-3">
          <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
          Adding the photo…
        </span>
      ) : null}
    </div>
  );
}
