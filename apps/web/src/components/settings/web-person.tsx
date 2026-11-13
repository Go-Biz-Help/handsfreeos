'use client';
/**
 * "Email your web person" and "Hide the website chat until texting is approved" (the owner, 2026-11-12).
 *
 * Getting texting approved often means asking whoever looks after a business's website to add the form, update the
 * privacy policy and terms, or add the chat. The button emails them, each change in its own text file (core's
 * website-fixes.ts), from HandsFreeOS in the business's name, with replies to whoever sent it. The worker writes the
 * files the dialog shows, from the same code that writes the ones it sends.
 *
 * The switch is for a business whose customers agree on a form: its chat is paused while the carriers look (its code
 * stays on the site and shows nothing) and comes back on by itself once texting is approved.
 *
 * Shown on the texting registration's "How customers agree" and "Before it goes" steps and on Settings → Texting &
 * calls while the carriers review it or after they turn it down.
 */
import {
  fixesForPath,
  normalizeChatOrigins,
  WEBSITE_FIX_IDS,
  WEBSITE_FIXES,
  type WebsiteFixId,
} from '@hfos/core';
import { ChevronDown, ChevronRight, FileText, Loader2, Mail, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { cn } from '@/lib/utils';

/** A published form a website could show. */
export interface WebPersonForm {
  readonly formId: string;
  readonly name: string;
  readonly embedOrigins: readonly string[];
}

/** A website chat, as much of it as these need. */
export interface WebPersonChat {
  readonly id: string;
  readonly allowedOrigins: readonly string[];
  readonly smsConsent: boolean;
  readonly paused: boolean;
  readonly hiddenUntilTexting: boolean;
}

/** The chat the files are about, as the worker picks it: one with the texts box first, a hidden one counting as on. */
function chatOf(chats: readonly WebPersonChat[]): WebPersonChat | null {
  const on = chats.filter((c) => !c.paused || c.hiddenUntilTexting);
  return on.find((c) => c.smsConsent) ?? on[0] ?? null;
}

const hostOf = (url: string | null): string => {
  if (!url) return 'your website';
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url;
  }
};

/** Which fix a refusal is about, by its rule, so it shows under that one. */
function fixOfRule(rule: string | undefined): WebsiteFixId | null {
  if (!rule) return null;
  if (rule.startsWith('web_person_form') || rule === 'web_person_no_form') return 'form';
  if (rule.startsWith('web_person_chat') || rule === 'web_person_no_chat') return 'chat';
  if (rule === 'web_person_no_policy') return 'policy';
  return null;
}

interface Preview {
  readonly files: readonly { id: WebsiteFixId; filename: string; label: string; text: string }[];
}

/** Whether a button has already opened itself for ?webPerson=1, so only one does. */
let autoOpened = false;

/** The button, and the dialog it opens. */
export function WebPersonButton({
  workspaceId,
  website,
  forms,
  chats,
  suggested,
  path = null,
  variant = 'secondary',
  className,
}: {
  workspaceId: string;
  /** The business's website, as the registration has it. */
  website: string | null;
  forms: readonly WebPersonForm[];
  chats: readonly WebPersonChat[];
  /** The fixes to tick to start with: the ones the checks found missing. Left out, what the way customers agree needs. */
  suggested?: readonly WebsiteFixId[];
  path?: 'hosted' | 'own_site' | 'in_person' | null;
  variant?: 'primary' | 'secondary' | 'ghost';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Opened from an Admin ticket's "Email their web person" (?webPerson=1): the first button on the page opens itself.
  useEffect(() => {
    if (autoOpened || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('webPerson') !== '1') return;
    autoOpened = true;
    url.searchParams.delete('webPerson');
    window.history.replaceState(null, '', url.toString());
    setOpen(true);
  }, []);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        className={className}
        onClick={() => setOpen(true)}
        data-testid="web-person-open"
      >
        <Mail className="h-4 w-4" />
        Email your web person
      </Button>
      {open ? (
        <WebPersonDialog
          workspaceId={workspaceId}
          website={website}
          forms={forms}
          chats={chats}
          suggested={suggested?.length ? suggested : fixesForPath(path)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function WebPersonDialog({
  workspaceId,
  website,
  forms,
  chats,
  suggested,
  onClose,
}: {
  workspaceId: string;
  website: string | null;
  forms: readonly WebPersonForm[];
  chats: readonly WebPersonChat[];
  suggested: readonly WebsiteFixId[];
  onClose: () => void;
}) {
  const router = useRouter();
  const chat = chatOf(chats);
  const [to, setTo] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [fixes, setFixes] = useState<WebsiteFixId[]>(() =>
    WEBSITE_FIX_IDS.filter((id) => suggested.includes(id) && (id !== 'chat' || !!chat)),
  );
  // '' is a form of their own.
  const [formId, setFormId] = useState<string>(forms[0]?.formId ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<{
    fix: WebsiteFixId | null;
    message: string;
    rule?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [shown, setShown] = useState<WebsiteFixId | null>(null);
  const [fixing, setFixing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (fixes.length === 0) {
      setPreview(null);
      setProblem(null);
      return;
    }
    setLoading(true);
    try {
      const got = await workerPost<Preview>('/v1/telephony/web-person-preview', {
        workspaceId,
        fixes,
        formId: fixes.includes('form') ? formId || null : undefined,
      });
      setPreview(got);
      setProblem(null);
    } catch (e) {
      setPreview(null);
      const rule = e instanceof ApiError ? e.rule : undefined;
      setProblem({ fix: fixOfRule(rule), message: errorMessage(e), rule });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fixes, formId]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: WebsiteFixId, on: boolean) =>
    setFixes((now) => WEBSITE_FIX_IDS.filter((x) => (x === id ? on : now.includes(x))));

  /** Puts the website on the form's or the chat's sites, so it shows there: the one refusal the dialog can fix. */
  async function allowSite() {
    if (!website || !problem?.rule) return;
    setFixing(true);
    try {
      const { origins } = normalizeChatOrigins([website], { allowNone: true });
      if (problem.rule === 'web_person_form_site') {
        const form = forms.find((f) => f.formId === formId);
        if (!form) return;
        unwrap(
          await apiBrowser().POST('/v1/commands/form.set_delivery', {
            body: {
              workspaceId,
              formId: form.formId,
              embedOrigins: [...new Set([...form.embedOrigins, ...origins])],
            },
          }),
        );
      } else if (problem.rule === 'web_person_chat_site' && chat) {
        unwrap(
          await apiBrowser().POST('/v1/commands/chat_widget.update', {
            body: {
              workspaceId,
              widgetId: chat.id,
              allowedOrigins: [...new Set([...chat.allowedOrigins, ...origins])],
            },
          }),
        );
      }
      toast.success(`${hostOf(website)} added`);
      router.refresh();
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setFixing(false);
    }
  }

  async function send() {
    setError(null);
    if (!to.trim()) return setError('Enter their email address.');
    if (fixes.length === 0) return setError('Tick at least one change to send.');
    setSending(true);
    try {
      const got = unwrap(
        await apiBrowser().POST('/v1/commands/registration.email_web_person', {
          body: {
            workspaceId,
            to: to.trim(),
            ...(name.trim() ? { name: name.trim() } : {}),
            fixes,
            ...(fixes.includes('form') ? { formId: formId || null } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      );
      toast.success(
        `Sent to ${got.sentTo}, with ${got.files.length === 1 ? 'one file' : `${got.files.length} files`}. Replies come to you, and you get a copy.`,
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  const fileOf = (id: WebsiteFixId) => preview?.files.find((f) => f.id === id) ?? null;
  const canAllow =
    !!website &&
    (problem?.rule === 'web_person_form_site' ||
      (problem?.rule === 'web_person_chat_site' && !!chat));

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent
        title="Email your web person"
        description="Each change goes in its own text file, so the email stays short. It comes from HandsFreeOS in your business’s name, and replies come to you."
        className="max-h-[calc(100vh-32px)] w-[min(600px,calc(100vw-32px))] overflow-y-auto"
      >
        <div className="mt-4 space-y-4" data-testid="web-person-dialog">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Their email" htmlFor="web-person-to">
              <Input
                id="web-person-to"
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="dana@example.com"
                autoComplete="off"
                data-testid="web-person-to"
              />
            </Field>
            <Field label="Their name (optional)" htmlFor="web-person-name">
              <Input
                id="web-person-name"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 80))}
                placeholder="Dana"
                autoComplete="off"
              />
            </Field>
          </div>

          <div>
            <p className="mb-2 text-[13px] font-medium">What they need to do</p>
            <ul className="space-y-2.5">
              {WEBSITE_FIX_IDS.map((id) => {
                const picked = fixes.includes(id);
                const file = picked ? fileOf(id) : null;
                const noChat = id === 'chat' && !chat;
                return (
                  <li
                    key={id}
                    className="rounded-menu border border-border bg-card-2 p-3"
                    data-testid={`web-person-fix-${id}`}
                  >
                    <Checkbox
                      label={<span className="font-medium">{WEBSITE_FIXES[id].label}</span>}
                      checked={picked}
                      disabled={noChat}
                      onChange={(e) => toggle(id, e.target.checked)}
                    />
                    <p className="ml-[28px] mt-0.5 text-[12.5px] text-text-3">
                      {noChat
                        ? 'You don’t have a website chat yet. Set one up in Settings → Website chat first.'
                        : WEBSITE_FIXES[id].hint}
                    </p>
                    {picked && id === 'form' ? (
                      <div className="ml-[28px] mt-2">
                        <label htmlFor="web-person-form" className="sr-only">
                          Which form
                        </label>
                        <Select
                          id="web-person-form"
                          selectSize="sm"
                          value={formId}
                          onChange={(e) => setFormId(e.target.value)}
                          data-testid="web-person-form"
                        >
                          {forms.map((f) => (
                            <option key={f.formId} value={f.formId}>
                              Our form: {f.name}
                            </option>
                          ))}
                          <option value="">
                            A form of their own (we send the box and its words)
                          </option>
                        </Select>
                      </div>
                    ) : null}
                    {picked && problem && problem.fix === id ? (
                      <div className="ml-[28px] mt-2" role="alert">
                        <p className="text-[12.5px] text-danger-text">{problem.message}</p>
                        {canAllow ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="mt-1.5"
                            onClick={() => void allowSite()}
                            disabled={fixing}
                            data-testid="web-person-allow-site"
                          >
                            {fixing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            Allow it on {hostOf(website)}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {file ? (
                      <div className="ml-[28px] mt-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-text hover:underline"
                          onClick={() => setShown(shown === id ? null : id)}
                          aria-expanded={shown === id}
                          data-testid={`web-person-show-${id}`}
                        >
                          {shown === id ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          <FileText className="h-3.5 w-3.5" />
                          {file.filename}
                        </button>
                        {shown === id ? (
                          <pre
                            className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-menu border border-border bg-card p-3 font-mono text-[12px] leading-relaxed text-text-2"
                            data-testid={`web-person-file-${id}`}
                          >
                            {file.text}
                          </pre>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {problem && !problem.fix ? (
              <p role="alert" className="mt-2 text-[12.5px] text-danger-text">
                {problem.message}
              </p>
            ) : null}
            {loading ? (
              <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-text-3" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Writing the files…
              </p>
            ) : null}
          </div>

          <Field label="A note from you (optional)" htmlFor="web-person-note">
            <Textarea
              id="web-person-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 1000))}
              placeholder="Anything else they should know, like when you need it done."
            />
          </Field>

          {error ? (
            <p role="alert" className="text-[12.5px] text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void send()}
              disabled={sending || loading || !!problem || fixes.length === 0}
              data-testid="web-person-send"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Hide the website chat until texting is approved": every chat paused while the carriers look, back on by itself once
 * texting is approved. For a business whose customers agree on a form; nothing to show without a chat.
 */
export function HideChatSwitch({
  workspaceId,
  chats,
  className,
}: {
  workspaceId: string;
  chats: readonly WebPersonChat[];
  className?: string;
}) {
  const router = useRouter();
  const held = chats.some((c) => c.hiddenUntilTexting);
  const [hidden, setHidden] = useState(held);
  const [busy, setBusy] = useState(false);
  useEffect(() => setHidden(held), [held]);
  // Chats paused by hand stay as they are: only one that's on (or hidden by this) has anything to switch.
  if (!chats.some((c) => !c.paused || c.hiddenUntilTexting)) return null;

  async function flip(next: boolean) {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/chat_widget.hide_until_texting', {
          body: { workspaceId, hide: next },
        }),
      );
      setHidden(next);
      toast.success(
        next
          ? 'Your website chat is hidden. It comes back by itself once texting is approved.'
          : 'Your website chat is showing again.',
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn('flex items-start justify-between gap-3', className)}
      data-testid="hide-chat-until-texting"
    >
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium">Hide the website chat until texting is approved</p>
        <p className="mt-0.5 text-[12.5px] text-text-3">
          {hidden
            ? 'Hidden now. Its code can stay on your site, and it comes back by itself when the carriers approve.'
            : 'Your customers agree on a form, so the chat can wait. Its code stays on your site and shows nothing, then it comes back by itself when the carriers approve.'}
        </p>
      </div>
      <Switch
        checked={hidden}
        onChange={(next) => void flip(next)}
        busy={busy}
        label="Hide the website chat until texting is approved"
        testId="hide-chat-switch"
      />
    </div>
  );
}
