'use client';
import {
  CHAT_BLOCKED_NOTE,
  COMPOSER_WORDS,
  composerPlaceholder,
  crossChannelCanText,
  crossChannelLine,
  emailFromLabel,
  emailNote as emailNoteWords,
  emailSubjectOf,
  photosSavedLine,
  quietLine as quietLineOf,
  quietQuestion,
  SENT_WORDS,
  sendLabel,
  switchRefusal,
  TEXTING_STATUS_LINK,
  textFromLine,
  textNote as textNoteWords,
  type ComposerNote,
} from '@hfos/core';
import {
  AlertTriangle,
  CircleAlert,
  Clock,
  Globe,
  Image as ImageIcon,
  Mail,
  MessageCircle,
  Moon,
  Paperclip,
  Phone,
  Send,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { uploadFile } from '@/components/files/upload-zone';
import { providerName } from '@/components/settings/provider-logos';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { ConversationGet, EmailComposeOptions, PhoneSetupStatus } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { AttachmentChip } from './attachment-chip';
import { ChannelIcon, QuietStrip, SegmentCounter, Words } from './bits';
import type { PendingText } from './hooks';

/** A text in quiet hours: ask first, send now anyway, or hold it until quiet hours end. */
type QuietChoice = 'ask' | 'now' | 'later';

const PHOTO_TYPES = 'image/jpeg,image/png,image/gif';
const PHOTO = new Set(PHOTO_TYPES.split(','));

/** Texts and email switch between each other; a website chat's replies stay in the chat. */
type Mode = 'sms' | 'email' | 'chat';

interface Attachment {
  readonly fileId: string;
  readonly name: string;
  /** A local preview, for photos only. */
  readonly preview: string;
  /** Texts carry photos only; email carries any file. */
  readonly photo: boolean;
}

/** What the composer needs to know about who it writes to and whether it can. */
export interface ComposerTarget {
  readonly workspaceId: string;
  /** The conversation, or the customer when there isn't one yet (the record page). */
  readonly conversationId?: string;
  readonly personId?: string | null;
  /** "Mike", or null for a number nobody has linked. */
  readonly firstName: string | null;
  /** The thread's channel, where the composer starts (texts when there's no thread). */
  readonly channel?: Mode;
  /** "(713) 555-0142", where texts go; empty when there's no number. */
  readonly phoneDisplay: string;
  /** Where email goes, when the customer has an address. */
  readonly email?: string | null;
  readonly canText: ConversationGet['canText'];
  readonly quiet: ConversationGet['quiet'];
  readonly fromNumber: string | null;
  readonly businessName?: string;
  /**
   * Above the box when sending changes who answers: the AI teammate is handling the conversation, or it waits
   * for a person ("Sending takes this conversation over from Ava.").
   */
  readonly handoverNote?: string | null;
  /** A website chat whose visitor was blocked: replies can't reach them. */
  readonly chatBlocked?: boolean;
}

const NOTE_ICON: Record<ComposerNote['icon'], LucideIcon> = {
  alert: CircleAlert,
  clock: Clock,
  phone: Phone,
  mail: Mail,
};

interface Note {
  /** Core's words for the note. */
  readonly words: ComposerNote;
  readonly tone: 'danger' | 'info' | 'warning';
  readonly icon: LucideIcon;
  readonly body: ReactNode;
  readonly placeholder: string;
  readonly action?: ReactNode;
}

interface FromChoice {
  readonly key: string;
  readonly label: string;
  readonly address: string;
  readonly emailAddressId?: string;
  readonly mailboxConnectionId?: string;
}

/** Core's note as the composer shows it: its icon, its words with the bold parts, a link and a button. */
function noteOf(
  words: ComposerNote | null,
  workspaceId: string,
  actions: { email?: () => void; editPerson?: () => void },
): Note | null {
  if (!words) return null;
  const onAction =
    words.action?.kind === 'email'
      ? actions.email
      : words.action?.kind === 'edit_person'
        ? actions.editPerson
        : undefined;
  return {
    words,
    tone: words.tone,
    icon: NOTE_ICON[words.icon],
    body: (
      <>
        <Words parts={words.parts} />
        {words.link === 'texting_status' ? (
          <>
            {' '}
            <Link href={`/app/w/${workspaceId}/settings/texting`} className="font-medium underline">
              {TEXTING_STATUS_LINK}
            </Link>
          </>
        ) : null}
      </>
    ),
    placeholder: words.placeholder,
    action:
      words.action && onAction ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onAction}
          data-testid={words.action.kind === 'email' ? 'note-email' : 'note-edit-person'}
        >
          {words.action.kind === 'email' ? (
            <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />
          ) : null}
          {words.action.label}
        </Button>
      ) : undefined,
  };
}

/** The note that replaces the box when texting can't happen, and the box's placeholder then. */
function textNote(
  target: ComposerTarget,
  reason: ConversationGet['canText']['reason'],
  setup: PhoneSetupStatus | null,
  onEmail?: () => void,
): Note | null {
  const reg = setup?.registrations.find(
    (r) => r.status === 'submitted' || r.status === 'in_review',
  );
  return noteOf(
    textNoteWords(reason, {
      firstName: target.firstName,
      inReviewSince: reg?.submittedAt ? formatDate(reg.submittedAt) : null,
      tollFree: setup?.number?.numberType !== 'local',
      offerEmail: !!onEmail,
    }),
    target.workspaceId,
    { email: onEmail },
  );
}

/** Why email to this customer can't go out: no address, or the address is stopped (bounced, spam, by hand). */
function emailNote(
  opts: EmailComposeOptions | null,
  target: ComposerTarget,
  onEditPerson?: () => void,
): Note | null {
  if (!opts) return null;
  return noteOf(
    emailNoteWords(opts.canEmail, {
      to: opts.to,
      suppressedReason: opts.suppressed?.reason ?? null,
      firstName: target.firstName,
      canEditPerson: !!onEditPerson,
    }),
    target.workspaceId,
    { editPerson: onEditPerson },
  );
}

/**
 * Write a text or an email. Texts: Enter sends and Shift+Enter adds a line, photos ride along as a picture
 * message, and quiet hours ask "send it now anyway?". Email: from a workspace address (or a connected
 * mailbox), a subject, copies and any file. `variant` picks the desktop box (with the Text / Email switch),
 * the phone's rounded input, or the record page's sheet; the last two write in the thread's own channel.
 */
export function Composer({
  target,
  variant,
  onPending,
  onSettled,
  onDropPending,
  onSent,
  onEditPerson,
  initialText,
  initialSubject,
}: {
  target: ComposerTarget;
  variant: 'desktop' | 'phone' | 'sheet';
  onPending?: (p: Omit<PendingText, 'messageId' | 'error'>) => void;
  onSettled?: (clientId: string, result: { messageId?: string }) => void;
  onDropPending?: (clientId: string) => void;
  /** `crossChannel`: it went to the customer's other thread (an email from a text thread, or back). */
  onSent?: (out: { messageId: string; conversationId: string; crossChannel: boolean }) => void;
  /** Opens the customer's edit dialog (the bounced-email note offers it). */
  onEditPerson?: () => void;
  /** A draft to start from (the Assistant's Edit). */
  initialText?: string;
  initialSubject?: string;
}) {
  const channel: Mode = target.channel ?? 'sms';
  const [mode, setMode] = useState<Mode>(channel);
  const [text, setText] = useState(initialText ?? '');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmQuiet, setConfirmQuiet] = useState(false);
  const [setup, setSetup] = useState<PhoneSetupStatus | null>(null);
  const [opts, setOpts] = useState<EmailComposeOptions | null>(null);
  const [optsNonce, setOptsNonce] = useState(0);
  const [subject, setSubject] = useState<string | null>(initialSubject ?? null);
  const [cc, setCc] = useState('');
  const [ccOpen, setCcOpen] = useState(false);
  const [fromKey, setFromKey] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const previews = useRef(new Set<string>());
  const ccId = useId();
  const email = mode === 'email';
  const chat = mode === 'chat';
  const cross = mode !== channel;
  // Texting from an email thread goes to the customer's text thread; the server has the last word there.
  const canText = crossChannelCanText(
    channel,
    target.canText,
    target.phoneDisplay,
    target.fromNumber,
  );
  const reason = canText.reason;
  const who = target.firstName ?? target.phoneDisplay;
  const emailLive = useLiveVersion(
    ['email_suppression', 'email_address', 'mailbox', 'person'],
    300,
  );

  // "In review since…" needs the registration; only fetched when it matters.
  useEffect(() => {
    if (reason !== 'not_ready' || email) return;
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
  }, [reason, email, target.workspaceId]);

  // Email needs the addresses it can go from, the reply subject, and whether the customer's address takes
  // mail. An email thread asks about itself; anywhere else asks about the customer.
  const optsConversation = channel === 'email' ? (target.conversationId ?? null) : null;
  const optsPerson = optsConversation ? null : (target.personId ?? null);
  useEffect(() => {
    if (!email || (!optsConversation && !optsPerson)) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/email.compose_options', {
        body: {
          workspaceId: target.workspaceId,
          ...(optsConversation ? { conversationId: optsConversation } : { personId: optsPerson! }),
        },
      })
      .then((r) => {
        if (!cancelled) setOpts(unwrap(r));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [email, optsConversation, optsPerson, target.workspaceId, emailLive, optsNonce]);

  // Photo previews are local object URLs: let them go with the component.
  useEffect(() => {
    const all = previews.current;
    return () => all.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  // The textarea grows with the draft, up to about six lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const choices: FromChoice[] = opts
    ? [
        ...[...opts.addresses]
          .filter((a) => a.usable)
          .sort(
            (a, b) =>
              Number(b.id === opts.fromAddressId) - Number(a.id === opts.fromAddressId) ||
              Number(b.isDefault) - Number(a.isDefault),
          )
          .map((a) => ({
            key: `a:${a.id}`,
            label: emailFromLabel(a.address),
            address: a.address,
            emailAddressId: a.id,
          })),
        ...opts.mailboxes
          .filter((m) => m.accountEmail)
          .map((m) => ({
            key: `m:${m.id}`,
            label: emailFromLabel(m.accountEmail!, providerName(m.provider)),
            address: m.accountEmail!,
            mailboxConnectionId: m.id,
          })),
      ]
    : [];
  const from = choices.find((c) => c.key === fromKey) ?? choices[0] ?? null;
  const subjectValue = subject ?? opts?.replySubject ?? '';
  const note: Note | null = chat
    ? target.chatBlocked
      ? noteOf(CHAT_BLOCKED_NOTE, target.workspaceId, {})
      : null
    : email
      ? emailNote(opts, target, onEditPerson)
      : textNote(
          target,
          reason,
          setup,
          variant === 'desktop' && target.email ? () => switchMode('email') : undefined,
        );
  const off = chat ? !!target.chatBlocked : email ? !!opts && !opts.canEmail.ok : !canText.ok;
  const sendDisabled = off || busy || !text.trim() || (email && (!opts || !from));

  function switchMode(next: Mode) {
    if (next === mode) return;
    if (next === 'email' && !target.email) {
      toast(
        switchRefusal('email', {
          personId: target.personId ?? null,
          firstName: target.firstName,
        }),
      );
      return;
    }
    if (next === 'sms' && !target.phoneDisplay) {
      toast(
        switchRefusal('sms', { personId: target.personId ?? null, firstName: target.firstName }),
      );
      return;
    }
    setMode(next);
    setConfirmQuiet(false);
    // A text carries photos only.
    if (next === 'sms') setFiles((all) => all.filter((f) => f.photo));
  }

  function removeFile(fileId: string) {
    setFiles((all) => all.filter((x) => x.fileId !== fileId));
  }

  async function attach(list: FileList | null) {
    if (!list || !target.personId) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const fileId = await uploadFile(target.workspaceId, 'person', target.personId, file);
        const photo = PHOTO.has(file.type);
        const preview = photo ? URL.createObjectURL(file) : '';
        if (preview) previews.current.add(preview);
        setFiles((all) => [...all, { fileId, name: file.name, preview, photo }]);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  /**
   * A text. In quiet hours `ask` puts the question first: Send now (`acknowledgeQuietHours`), or Send at 8:00 AM
   * when quiet hours end (`sendAfterQuietHours`: it waits in the thread, cancellable, and goes then).
   */
  async function sendText(body: string, when: QuietChoice) {
    if (target.quiet.quiet && when === 'ask') {
      setConfirmQuiet(true);
      return;
    }
    const clientId = crypto.randomUUID();
    if (!cross) onPending?.({ clientId, body, at: new Date().toISOString() });
    setText('');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/message.send', {
          body: {
            workspaceId: target.workspaceId,
            ...(!cross && target.conversationId
              ? { conversationId: target.conversationId }
              : { personId: target.personId! }),
            channel: 'sms',
            body,
            attachmentFileIds: files.map((f) => f.fileId),
            clientId,
            ...(when === 'later'
              ? { sendAfterQuietHours: true }
              : { acknowledgeQuietHours: when === 'now' }),
          },
        }),
      );
      if (!cross) onSettled?.(clientId, { messageId: out.messageId });
      setFiles([]);
      setConfirmQuiet(false);
      if (out.scheduledFor) toast.success(SENT_WORDS.held(who, out.scheduledFor));
      else if (cross) toast.success(SENT_WORDS.textElsewhere(target.phoneDisplay));
      onSent?.({
        messageId: out.messageId,
        conversationId: out.conversationId,
        crossChannel: cross,
      });
    } catch (e) {
      if (!cross) onDropPending?.(clientId);
      setText(body);
      if (e instanceof ApiError && e.rule === 'quiet_hours') setConfirmQuiet(true);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail(body: string) {
    if (!opts || !from) return;
    // A new email with no subject goes out under the business name.
    const subj = emailSubjectOf(subjectValue, {
      defaultDisplayName: opts.addresses.find((a) => a.isDefault)?.displayName,
      businessName: target.businessName,
    });
    const copies = cc.split(/[\s,;]+/).filter(Boolean);
    const clientId = crypto.randomUUID();
    if (!cross)
      onPending?.({
        clientId,
        body,
        at: new Date().toISOString(),
        channel: 'email',
        subject: subj,
        from: from.address,
      });
    setText('');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/message.send', {
          body: {
            workspaceId: target.workspaceId,
            ...(!cross && target.conversationId
              ? { conversationId: target.conversationId }
              : target.personId
                ? { personId: target.personId }
                : { toEmail: opts.to! }),
            channel: 'email',
            body,
            subject: subj,
            cc: copies,
            ...(from.mailboxConnectionId
              ? { mailboxConnectionId: from.mailboxConnectionId }
              : { emailAddressId: from.emailAddressId }),
            attachmentFileIds: files.map((f) => f.fileId),
            clientId,
          },
        }),
      );
      if (!cross) onSettled?.(clientId, { messageId: out.messageId });
      setFiles([]);
      setCc('');
      setCcOpen(false);
      setSubject(null);
      setOptsNonce((n) => n + 1);
      if (cross) toast.success(SENT_WORDS.emailElsewhere(opts.to ?? ''));
      onSent?.({
        messageId: out.messageId,
        conversationId: out.conversationId,
        crossChannel: cross,
      });
    } catch (e) {
      if (!cross) onDropPending?.(clientId);
      setText(body);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** A reply in the website chat: it shows in their chat window (no quiet hours, no attachments). */
  async function sendChat(body: string) {
    if (!target.conversationId) return;
    const clientId = crypto.randomUUID();
    onPending?.({ clientId, body, at: new Date().toISOString() });
    setText('');
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/message.send', {
          body: {
            workspaceId: target.workspaceId,
            conversationId: target.conversationId,
            channel: 'chat',
            body,
            clientId,
          },
        }),
      );
      onSettled?.(clientId, { messageId: out.messageId });
      onSent?.({
        messageId: out.messageId,
        conversationId: out.conversationId,
        crossChannel: false,
      });
    } catch (e) {
      onDropPending?.(clientId);
      setText(body);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function send(when: QuietChoice = 'ask') {
    const body = text.trim();
    if (!body || busy || off) return;
    void (chat ? sendChat(body) : email ? sendEmail(body) : sendText(body, when));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }
  /** Quiet hours' question: send now, or when they end where the business is. */
  const ask = quietQuestion(target.quiet, who);

  const placeholder = composerPlaceholder({
    mode,
    off,
    note: note?.words ?? null,
    firstName: target.firstName,
    phoneDisplay: target.phoneDisplay,
    compact: variant === 'phone',
  });
  const handover = target.handoverNote ? (
    <div
      className={cn(
        'flex items-start gap-1.5 text-xs leading-[1.4] text-warning-text',
        variant === 'phone' && 'mx-3 mt-2',
      )}
      data-testid="composer-handover"
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      <span>{target.handoverNote}</span>
    </div>
  ) : null;
  const hidden = (
    <input
      ref={fileInput}
      type="file"
      accept={email ? undefined : PHOTO_TYPES}
      multiple
      className="sr-only"
      aria-label={email ? 'Choose files' : 'Choose photos'}
      data-testid="composer-file"
      onChange={(e) => {
        void attach(e.target.files);
        e.target.value = '';
      }}
    />
  );
  const tray =
    !email && files.length > 0 ? (
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
              onClick={() => removeFile(f.fileId)}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-text text-card"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        ))}
        <span className="flex-1 text-xs text-text-3">{photosSavedLine(target.firstName)}</span>
      </div>
    ) : null;
  const chips =
    email && files.length > 0
      ? files.map((f) => (
          <AttachmentChip
            key={f.fileId}
            file={{ name: f.name }}
            onRemove={() => removeFile(f.fileId)}
          />
        ))
      : null;
  const quietLine = quietLineOf(target.quiet);
  const noteBox = note ? (
    <Callout
      tone={note.tone}
      icon={note.icon}
      className={variant === 'phone' ? 'mx-3 mt-2.5 px-3 py-2.5' : 'px-3 py-2.5'}
      action={note.action}
      data-testid="composer-note"
    >
      {note.body}
    </Callout>
  ) : null;

  if (variant === 'phone')
    return (
      <div
        className="flex-none border-t border-border bg-card"
        data-testid="composer"
        data-mode={mode}
      >
        {handover}
        {noteBox}
        {tray ? <div className="px-3 pt-2.5">{tray}</div> : null}
        {chips ? <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">{chips}</div> : null}
        <div
          className={cn(
            'flex items-end gap-1.5 pb-[calc(env(safe-area-inset-bottom)+10px)] pr-2.5 pt-2',
            chat ? 'pl-3' : 'pl-2.5',
          )}
        >
          {hidden}
          {chat ? null : (
            <button
              type="button"
              title={COMPOSER_WORDS.attachPhoto}
              aria-label={COMPOSER_WORDS.attachPhoto}
              disabled={off || uploading || !target.personId}
              onClick={() => fileInput.current?.click()}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2 disabled:opacity-45"
            >
              <Paperclip className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </button>
          )}
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
            disabled={sendDisabled}
            onClick={() => send()}
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
                <h3 className="text-[15px] font-semibold">{ask.title}</h3>
                <p className="text-[13px] text-text-2">{ask.body}</p>
              </div>
            </div>
            <div className="mt-[18px] flex flex-col gap-2">
              <Button size="lg" onClick={() => send('later')} data-testid="quiet-send-later">
                {ask.later}
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => send('now')}
                data-testid="quiet-send-now"
              >
                {ask.now}
              </Button>
              <Button size="lg" variant="ghost" onClick={() => setConfirmQuiet(false)}>
                {ask.keep}
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );

  const fromControl =
    choices.length > 1 ? (
      <Select
        selectSize="sm"
        aria-label="Send from"
        value={from?.key}
        onChange={(e) => setFromKey(e.target.value)}
        className="min-w-0 max-w-[310px] flex-1 text-[13px]"
        data-testid="composer-from"
      >
        {choices.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </Select>
    ) : from ? (
      <span className="truncate text-xs text-text-3" data-testid="composer-from">
        {emailFromLabel(from.address)}
      </span>
    ) : null;
  const subjectInput = (
    <Input
      inputSize="sm"
      aria-label={COMPOSER_WORDS.subject}
      placeholder={COMPOSER_WORDS.subject}
      maxLength={200}
      value={subjectValue}
      onChange={(e) => setSubject(e.target.value)}
      data-testid="composer-subject"
    />
  );

  return (
    <div
      className={cn(
        'flex flex-none flex-col gap-2 border-t border-border bg-card',
        variant === 'sheet' ? 'px-5 pb-2.5 pt-3' : 'px-4 py-3',
      )}
      data-testid="composer"
      data-mode={mode}
    >
      {variant === 'desktop' && chat ? (
        <div className="flex items-center justify-between gap-2">
          <span
            className="inline-flex h-7 items-center gap-1.5 rounded-[6px] bg-card-2 px-2.5 text-[13px] font-medium text-text-2"
            data-testid="composer-mode-chat"
          >
            <Globe className="h-3.5 w-3.5" strokeWidth={1.5} />
            {COMPOSER_WORDS.websiteChat}
          </span>
          <span className="truncate text-xs text-text-3">{COMPOSER_WORDS.chatReplies}</span>
        </div>
      ) : null}
      {variant === 'desktop' && !chat ? (
        <div className="flex items-center justify-between gap-2">
          <Segmented
            value={mode}
            onChange={switchMode}
            ariaLabel="Send as"
            options={[
              {
                value: 'sms',
                label: COMPOSER_WORDS.text,
                icon: <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />,
                testId: 'composer-mode-text',
              },
              {
                value: 'email',
                label: COMPOSER_WORDS.email,
                icon: <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />,
                testId: 'composer-mode-email',
              },
            ]}
          />
          {email ? (
            fromControl
          ) : target.fromNumber ? (
            <span className="truncate text-xs text-text-3">
              {textFromLine(target.fromNumber, target.businessName)}
            </span>
          ) : null}
        </div>
      ) : null}
      {variant === 'desktop' && cross ? (
        <p className="text-xs text-text-2" data-testid="composer-cross">
          {email
            ? crossChannelLine('email', opts?.to ?? target.email ?? '')
            : crossChannelLine('sms', target.phoneDisplay)}
        </p>
      ) : null}
      {handover}
      {noteBox ??
        (!email && !chat && target.quiet.quiet ? <QuietStrip>{quietLine}</QuietStrip> : null)}
      {email && !off && variant === 'desktop' ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="w-[52px] flex-none text-text-3">{COMPOSER_WORDS.to}</span>
            <span className="min-w-0 flex-1 truncate font-medium" data-testid="composer-to">
              {opts?.to ?? target.email}
            </span>
            {ccOpen ? null : (
              <button
                type="button"
                onClick={() => setCcOpen(true)}
                className="text-xs font-medium text-accent-text hover:underline"
                data-testid="composer-add-cc"
              >
                {COMPOSER_WORDS.cc}
              </button>
            )}
          </div>
          {ccOpen ? (
            <div className="flex items-center gap-2 text-[13px]">
              <label htmlFor={ccId} className="w-[52px] flex-none text-text-3">
                {COMPOSER_WORDS.cc}
              </label>
              <Input
                id={ccId}
                inputSize="sm"
                autoFocus
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="name@example.com"
                className="min-w-0 flex-1"
                data-testid="composer-cc"
              />
            </div>
          ) : null}
          {subjectInput}
        </div>
      ) : null}
      {email && !off && variant === 'sheet' ? subjectInput : null}
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
          {chat ? null : (
            <Button
              variant="ghost"
              size="icon"
              title={
                !target.personId
                  ? COMPOSER_WORDS.addCustomerForPhotos
                  : email
                    ? variant === 'sheet'
                      ? COMPOSER_WORDS.attach
                      : COMPOSER_WORDS.attachPhotoOrFile
                    : COMPOSER_WORDS.attachPhoto
              }
              aria-label={email ? COMPOSER_WORDS.attachFile : COMPOSER_WORDS.attachPhoto}
              disabled={off || uploading || !target.personId}
              loading={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? null : <Paperclip className="h-[18px] w-[18px]" strokeWidth={1.5} />}
            </Button>
          )}
          {variant === 'desktop' ? (
            <span className="hidden pl-0.5 text-xs text-text-3 lg:inline">
              {COMPOSER_WORDS.enterSends}
            </span>
          ) : null}
          <span className="flex-1" />
          {off || email || chat ? null : <SegmentCounter text={text} photos={files.length} />}
          <Button
            size="sm"
            disabled={sendDisabled}
            loading={busy}
            onClick={() => send()}
            data-testid="composer-send"
          >
            {busy ? null : <Send className="h-3.5 w-3.5" strokeWidth={1.5} />}
            {sendLabel(mode, target.quiet.quiet, off)}
          </Button>
        </div>
      </div>
      {email && (chips || (variant === 'desktop' && !cross && !off)) ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="email-attachments">
          {chips}
          {variant === 'desktop' && !cross && !off ? (
            <span className="text-xs text-text-3">{COMPOSER_WORDS.repliesHere}</span>
          ) : null}
        </div>
      ) : null}
      {confirmQuiet ? (
        <div className="flex flex-wrap items-center justify-end gap-2" data-testid="quiet-confirm">
          <span className="min-w-[160px] flex-1 text-xs text-text-2">{ask.inline}</span>
          <Button variant="ghost" size="sm" onClick={() => setConfirmQuiet(false)}>
            {ask.keepShort}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => send('now')}
            data-testid="quiet-send-now"
          >
            {ask.now}
          </Button>
          <Button size="sm" onClick={() => send('later')} data-testid="quiet-send-later">
            {ask.laterLong}
          </Button>
        </div>
      ) : null}
      {files.length === 0 && uploading ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-text-3">
          <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
          {email ? COMPOSER_WORDS.addingFile : COMPOSER_WORDS.addingPhoto}
        </span>
      ) : null}
    </div>
  );
}
