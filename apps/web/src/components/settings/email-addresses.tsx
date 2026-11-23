'use client';
import { firstName, type SettingKey } from '@hfos/core';
import { Check, Info, Lock, Plus, Shield, Sparkles, Trash2, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChannelIcon } from '@/components/inbox/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { copyText } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { EmailAddressInfo, EmailDomainInfo, EmailSetupStatus } from '@/lib/api/types';
import { settingAttrs } from './setting-anchor';

/** One card on Settings → Email. */
export function Section({
  title,
  description,
  aside,
  children,
  setting,
  asideByTitle,
}: {
  title: string;
  description: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  /** Its key in settings search. */
  setting?: SettingKey;
  /** The aside sits beside the title alone (a button), and the description keeps the card's whole width. */
  asideByTitle?: boolean;
}) {
  return (
    <Card className="p-6" {...settingAttrs(setting)}>
      {asideByTitle ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {aside}
          </div>
          <p className="mt-1 text-[13px] text-text-2">{description}</p>
        </>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <p className="mt-1 text-[13px] text-text-2">{description}</p>
          </div>
          {aside}
        </div>
      )}
      {children}
    </Card>
  );
}

export async function run<T>(fn: () => Promise<T>, done?: string): Promise<T | null> {
  try {
    const out = await fn();
    if (done) toast.success(done);
    return out;
  } catch (e) {
    toast.error(errorMessage(e));
    return null;
  }
}

/** Someone who works the inbox, who can be given an address of their own (M19). */
export type Person = { userId: string; name: string };

/** Who reads an address: the team, or one person by their id. */
type Reader = string;
const TEAM: Reader = 'team';

/** The business's AI teammate, for "Let Ava read this mail": null when it has none yet. */
export type AiReader = NonNullable<EmailSetupStatus['aiTeammate']> | null;

const cleanLocal = (v: string) => v.toLowerCase().replace(/[^a-z0-9._-]/g, '');

/** Turns the switch on a person's own address on or off. Only they can: the API refuses anyone else. */
async function setAiReads(workspaceId: string, emailAddressId: string, aiReads: boolean) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/email_address.set_ai_reads', {
      body: { workspaceId, emailAddressId, aiReads },
    }),
  );
}
/** "blake@", the short way a dialog names an address it has already shown in full. */
const short = (a: { localPart: string }) => `${a.localPart}@`;

/**
 * Your addresses (the guided setup's design, 2026-11-22): every address the business has, who reads each one and
 * which one customers hear from. Change on a row renames it, picks who reads it, moves which one customers hear
 * from, or removes it; Add an address puts another on a website name whose records are found.
 */
export function YourAddresses({
  workspaceId,
  addresses,
  domains,
  people,
  myUserId,
  aiTeammate,
  onChanged,
}: {
  workspaceId: string;
  addresses: EmailAddressInfo[];
  domains: EmailDomainInfo[];
  people: Person[];
  /** The person looking: "Only me" is theirs, and only they hand their own address back. */
  myUserId: string;
  /** Who "Let … read this mail" names, on the reader's own addresses. */
  aiTeammate: AiReader;
  onChanged: () => void;
}) {
  const ordered = [...addresses].sort((a, b) => Number(!!b.domain) - Number(!!a.domain));
  const verified = domains.filter((d) => d.status === 'verified');
  const ownDefault = addresses.some((a) => a.isDefault && a.domain);
  const current =
    addresses.find((a) => a.isDefault)?.displayName ?? addresses[0]?.displayName ?? '';
  const [changing, setChanging] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [flipping, setFlipping] = useState<string | null>(null);
  const open = addresses.find((a) => a.id === changing) ?? null;
  const isBackup = (a: EmailAddressInfo) => !a.domain && !a.isDefault && ownDefault;

  // Customers see one business name: it goes on every address.
  async function saveName() {
    setSaving(true);
    const ok = await run(async () => {
      for (const a of addresses)
        unwrap(
          await apiBrowser().POST('/v1/commands/email_address.update', {
            body: { workspaceId, emailAddressId: a.id, displayName: name.trim() },
          }),
        );
      return true;
    }, 'Saved');
    setSaving(false);
    if (ok) {
      setNaming(false);
      onChanged();
    }
  }

  // The switch saves as it is flipped: it is one person's yes or no, with nothing else to save beside it.
  async function letRead(a: EmailAddressInfo, on: boolean) {
    const name = aiTeammate?.name ?? 'Your AI teammate';
    setFlipping(a.id);
    await run(
      () => setAiReads(workspaceId, a.id, on),
      on
        ? `${name} now reads mail sent to ${a.address} and drafts answers for you`
        : `${name} no longer reads mail sent to ${a.address}`,
    );
    setFlipping(null);
    onChanged();
  }

  const reads = (a: EmailAddressInfo) =>
    a.ownerLeft
      ? `${a.ownerName ?? 'Its person'} no longer works here`
      : a.mine
        ? 'Only you read it'
        : a.ownerUserId
          ? `Only ${a.ownerName ?? 'one person'} reads it`
          : isBackup(a)
            ? 'Your free address. Emails go out from it if your own address ever stops working.'
            : a.domain
              ? 'The team reads it, in the Inbox'
              : 'Your free address. The team reads it, in the Inbox.';

  return (
    <Section
      title="Your addresses"
      setting="email.sending_address"
      asideByTitle
      description={
        verified.length
          ? `At ${verified.map((d) => d.domain).join(' and ')}. Click Change to rename one, pick who reads it, or remove it.`
          : 'Customers hear from your free address. Add your website name below to use addresses like office@yourbusiness.com.'
      }
      aside={
        verified.length ? (
          <Button
            variant="secondary"
            size="sm"
            className="flex-none"
            onClick={() => setAdding(true)}
            data-testid="address-add"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            Add an address
          </Button>
        ) : null
      }
    >
      <div className="mt-4 flex flex-col gap-2" data-testid="email-addresses">
        {ordered.map((a) => (
          <div
            key={a.id}
            className="rounded-menu border border-border"
            data-testid={`email-address-${a.localPart}`}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
              <ChannelIcon
                icon={a.ownerUserId ? Lock : isBackup(a) ? Shield : Users}
                className={isBackup(a) ? 'bg-card-2 text-text-2' : undefined}
              />
              <div className="min-w-[200px] flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="break-all font-mono text-[13px] font-medium">{a.address}</span>
                  {a.isDefault ? <Badge variant="owner">Customers hear from this one</Badge> : null}
                  {isBackup(a) ? <Badge variant="gray">Backup</Badge> : null}
                  {!a.usable ? <Badge variant="pending">Waiting for its records</Badge> : null}
                </div>
                <div className="mt-0.5 text-[13px] text-text-2" data-testid="address-reader">
                  {reads(a)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="Copy address"
                aria-label={`Copy ${a.address}`}
                onClick={() => void copyText(a.address, `Copied ${a.address}`)}
              >
                <CopyGlyph />
              </Button>
              {a.ownerLeft ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Change ${a.address}`}
                  onClick={() => setChanging(a.id)}
                  data-testid={`address-change-${a.localPart}`}
                >
                  Change
                </Button>
              )}
            </div>
            {a.ownerLeft ? (
              <LeftBehind
                workspaceId={workspaceId}
                address={a}
                people={people}
                onChanged={onChanged}
              />
            ) : a.mine ? (
              <div className="border-t border-border px-3.5 py-3">
                <LetAiRead
                  ai={aiTeammate}
                  address={short(a)}
                  checked={!!a.aiReads}
                  busy={flipping === a.id}
                  onChange={(on) => void letRead(a, on)}
                  testId={`address-ai-reads-${a.localPart}`}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-border pt-4">
        {naming ? (
          <>
            <Label htmlFor="email-display-name">Name customers see</Label>
            <div className="flex gap-2">
              <Input
                id="email-display-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                loading={saving}
                disabled={!name.trim() || name.trim() === current}
                onClick={() => void saveName()}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setName(current);
                  setNaming(false);
                }}
              >
                Cancel
              </Button>
            </div>
            <Hint>It goes on every address, so customers always see one name.</Hint>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-text-2">Name customers see</div>
              <div className="truncate text-sm" data-testid="email-display-name">
                {current}
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Change the name customers see"
              onClick={() => {
                setName(current);
                setNaming(true);
              }}
            >
              Change
            </Button>
          </div>
        )}
      </div>
      {open ? (
        <ChangeAddress
          key={open.id}
          workspaceId={workspaceId}
          address={open}
          addresses={ordered}
          people={people}
          myUserId={myUserId}
          aiTeammate={aiTeammate}
          onClose={() => setChanging(null)}
          onChanged={onChanged}
        />
      ) : null}
      {adding && verified.length ? (
        <AddAddress
          workspaceId={workspaceId}
          domains={verified}
          addresses={ordered}
          people={people}
          myUserId={myUserId}
          aiTeammate={aiTeammate}
          displayName={current}
          onClose={() => setAdding(false)}
          onChanged={onChanged}
        />
      ) : null}
    </Section>
  );
}

/**
 * "Let Ava read this mail" (owner, 2026-11-22): the switch a person has on their own address. On, the AI teammate
 * reads the mail that comes in to it and drafts answers only they see; they send a draft, or don't. It starts off.
 * A business with no AI teammate yet has nothing to switch on, so it says where to make one instead.
 */
function LetAiRead({
  ai,
  address,
  checked,
  onChange,
  busy,
  testId,
}: {
  ai: AiReader;
  /** "blake@". */
  address: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
  testId: string;
}) {
  if (!ai)
    return (
      <p className="flex items-start gap-2 text-[13px] text-text-2" data-testid={`${testId}-none`}>
        <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        <span>
          {`An AI teammate can draft answers to mail sent to ${address}. Set one up under AI teammate, and the switch shows here.`}
        </span>
      </p>
    );
  return (
    <div className="flex items-start gap-3">
      <Sparkles className="mt-0.5 h-4 w-4 flex-none text-accent" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{`Let ${ai.name} read this mail`}</div>
        <p className="mt-0.5 text-[13px] text-text-2">
          {`${ai.name} reads new mail sent to ${address} and writes a draft answer for you. Only you see the draft, and nothing is sent until you send it.`}
        </p>
        {checked && !ai.on ? (
          <p className="mt-1 text-[13px] text-warning-text">
            {`${ai.name} is turned off, so nothing is drafted until it’s back on: AI teammate, Status.`}
          </p>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        busy={busy}
        label={`Let ${ai.name} read mail sent to ${address}`}
        testId={testId}
      />
    </div>
  );
}

/** Only me, The team, or (with teammates) only one of them. */
function ReaderPicker({
  value,
  onPick,
  canBeMine,
  others,
  labelledBy,
}: {
  value: Reader;
  onPick: (to: Reader) => void;
  /** The person looking works the inbox, so the address can be theirs; their id. */
  canBeMine: string | null;
  /** Teammates it can go to instead. None for a person's own address: it only goes back to the team. */
  others: Person[];
  labelledBy: string;
}) {
  const other = others.some((p) => p.userId === value) ? value : '';
  return (
    <>
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        className="flex flex-col gap-2 sm:flex-row"
      >
        {canBeMine ? (
          <RadioCard
            selected={value === canBeMine}
            onSelect={() => onPick(canBeMine)}
            testId="reader-me"
            title={
              <span className="inline-flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" strokeWidth={1.5} />
                Only me
              </span>
            }
            description="Private. Nobody else can open it."
          />
        ) : null}
        <RadioCard
          selected={value === TEAM}
          onSelect={() => onPick(TEAM)}
          testId="reader-team"
          title={
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" strokeWidth={1.5} />
              The team
            </span>
          }
          description="Everyone who reads email here, in the Inbox."
        />
      </div>
      {others.length ? (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-text-2">
          <span className="flex-1">Or only one teammate</span>
          <Select
            selectSize="sm"
            className="w-[200px]"
            aria-label="Only one teammate reads it"
            value={other}
            onChange={(e) => onPick(e.target.value || TEAM)}
            data-testid="reader-other"
          >
            <option value="">Pick a person…</option>
            {others.map((p) => (
              <option key={p.userId} value={p.userId}>
                {`Only ${p.name}`}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </>
  );
}

/** The part before the @, with the website name fixed after it. */
function LocalPartInput({
  id,
  value,
  onChange,
  suffix,
  disabled,
  placeholder,
  onEnter,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  disabled?: boolean;
  placeholder?: string;
  onEnter?: () => void;
}) {
  return (
    <div
      className={
        'flex min-w-0 overflow-hidden rounded-control border border-border-strong bg-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring' +
        (disabled ? ' opacity-70' : '')
      }
    >
      <input
        id={id}
        aria-label="Address name"
        value={value}
        disabled={disabled}
        maxLength={64}
        onChange={(e) => onChange(cleanLocal(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter();
        }}
        placeholder={placeholder}
        className="h-[38px] min-w-0 flex-1 bg-transparent px-3 font-mono text-[14px] focus:outline-none disabled:cursor-not-allowed"
      />
      <span className="inline-flex h-[38px] max-w-[60%] items-center truncate border-l border-border bg-card-2 px-3 font-mono text-[12.5px] text-text-2">
        @{suffix}
      </span>
    </div>
  );
}

/** What saving will do, said before it happens. */
function WhenYouSave({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-4 flex items-start gap-2 text-[13px] text-text-2"
      data-testid="address-summary"
    >
      <Check className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      <span>{children}</span>
    </p>
  );
}

/**
 * Change this address: its name while it has carried no mail, who reads it, and which one customers hear from. When
 * the one customers hear from becomes one person's, it asks which address takes over and both change together
 * (what Burroughs Digital got stuck on). Its own person hands an address back to the team, and removes it.
 */
function ChangeAddress({
  workspaceId,
  address: a,
  addresses,
  people,
  myUserId,
  aiTeammate,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  address: EmailAddressInfo;
  addresses: EmailAddressInfo[];
  people: Person[];
  myUserId: string;
  aiTeammate: AiReader;
  onClose: () => void;
  onChanged: () => void;
}) {
  const suffix = a.address.split('@')[1] ?? '';
  const me = people.find((p) => p.userId === myUserId) ?? null;
  const theirs = !!a.ownerUserId && !a.mine;
  // The ones that can send for the business in its place: the team's, on a name whose records are found.
  const candidates = addresses.filter((x) => x.id !== a.id && !x.ownerUserId && x.usable);
  const today = addresses.find((x) => x.isDefault) ?? null;
  const lastFree = !a.domain && addresses.filter((x) => !x.domain).length <= 1;
  const [local, setLocal] = useState(a.localPart);
  const [reader, setReader] = useState<Reader>(a.ownerUserId ?? TEAM);
  const [takeover, setTakeover] = useState(candidates[0]?.id ?? '');
  const [makeDefault, setMakeDefault] = useState(false);
  const [aiReads, setAiReadsPick] = useState(!!a.aiReads);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const becomesPersons = !a.ownerUserId && reader !== TEAM;
  const handsBack = !!a.mine && reader === TEAM;
  const needsTakeover = a.isDefault && becomesPersons;
  const canBeDefault = !a.isDefault && a.usable && !theirs && reader === TEAM;
  const renamed = local !== a.localPart && local.length > 0;
  const to = people.find((p) => p.userId === reader) ?? null;
  const takes = candidates.find((x) => x.id === takeover) ?? null;
  const changed = renamed || becomesPersons || handsBack || (canBeDefault && makeDefault);
  const whose = reader === myUserId ? 'yours alone' : `${firstName(to?.name ?? '')}’s alone`;
  // The switch is only for an address that is, or is becoming, the reader's own.
  const mineAfter = reader === myUserId && !!a.domain;
  const flips = mineAfter && aiReads !== !!a.aiReads;
  const ai = aiTeammate?.name ?? 'Your AI teammate';

  async function save() {
    if (!changed && !flips) return onClose();
    setBusy('save');
    setError(null);
    try {
      if (!changed) {
        // Only the switch moved.
        const out = await setAiReads(workspaceId, a.id, aiReads);
        toast.success(
          aiReads
            ? `${ai} now reads mail sent to ${out.address} and drafts answers for you`
            : `${ai} no longer reads mail sent to ${out.address}`,
        );
        onChanged();
        return onClose();
      }
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/email_address.update', {
          body: {
            workspaceId,
            emailAddressId: a.id,
            ...(renamed ? { localPart: local } : {}),
            ...(becomesPersons
              ? { ownerUserId: reader, ...(needsTakeover ? { defaultToId: takeover } : {}) }
              : {}),
            ...(handsBack ? { ownerUserId: null } : {}),
            ...(canBeDefault && makeDefault ? { isDefault: true } : {}),
          },
        }),
      );
      // After the address is theirs: the switch is its own person's alone.
      if (flips) await setAiReads(workspaceId, a.id, aiReads);
      toast.success(
        becomesPersons && takes
          ? `${out.address} is ${whose} now, and customers hear from ${takes.address}`
          : becomesPersons
            ? `${out.address} is ${whose} now`
            : canBeDefault && makeDefault
              ? `Customers now hear from ${out.address}`
              : handsBack
                ? `${out.address} is the team’s now`
                : `Renamed to ${out.address}`,
      );
      onChanged();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    setBusy('remove');
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/email_address.remove', {
          body: { workspaceId, emailAddressId: a.id },
        }),
      );
      toast.success(
        out.threads
          ? `${out.address} is removed. Its ${out.threads === 1 ? 'conversation stays' : `${out.threads} conversations stay`} where ${out.threads === 1 ? 'it is' : 'they are'}.`
          : `${out.address} is removed`,
      );
      onChanged();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  }

  const alert = error ? (
    <p className="mt-3 text-[13px] text-danger-text" role="alert">
      {error}
    </p>
  ) : null;

  if (confirming)
    return (
      <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
        <DialogContent
          title="Remove this address?"
          description={<span className="font-mono">{a.address}</span>}
        >
          <ul
            className="mt-4 flex flex-col gap-2 text-[13.5px] text-text-2"
            data-testid="address-remove-what"
          >
            <li>
              {a.mine
                ? 'The mail it already got stays yours alone.'
                : 'The mail it already got stays in the Inbox.'}
            </li>
            <li>{`New mail sent to ${short(a)} goes to the team’s Inbox, so nothing is lost.`}</li>
            <li>You can add it back any time.</li>
          </ul>
          {alert}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy === 'remove'}
              onClick={() => void remove()}
              data-testid="address-remove-confirm"
            >
              Remove address
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent
        title="Change this address"
        description={<span className="font-mono">{a.address}</span>}
        className="max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto"
      >
        <div className="mt-5">
          <Label htmlFor={`address-local-${a.id}`}>Address</Label>
          <LocalPartInput
            id={`address-local-${a.id}`}
            value={local}
            onChange={setLocal}
            suffix={suffix}
            disabled={!a.renamable || theirs}
            onEnter={() => void save()}
          />
          <Hint>
            {theirs
              ? `It is ${a.ownerName ?? 'one person'}’s own address, so only they can change or remove it.`
              : a.renamable
                ? 'You can rename it until it sends or gets its first email.'
                : 'It has sent or got email, so its name stays. To use a different name, add a new address.'}
          </Hint>
        </div>

        <div className="mt-5">
          <div id={`address-reader-${a.id}`} className="mb-1.5 text-[13px] font-medium">
            Who reads it
          </div>
          {!a.domain ? (
            <p className="text-[13px] text-text-2">
              The team reads your free address, in the Inbox. It can’t be one person’s own.
            </p>
          ) : theirs ? (
            <p className="flex items-center gap-2 text-[13px] text-text-2">
              <Lock className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
              {`Only ${a.ownerName ?? 'one person'} reads it. They can hand it back to the team from here when they’re signed in.`}
            </p>
          ) : (
            <ReaderPicker
              value={reader}
              onPick={setReader}
              canBeMine={a.mine || me ? myUserId : null}
              others={a.mine ? [] : people.filter((p) => p.userId !== myUserId)}
              labelledBy={`address-reader-${a.id}`}
            />
          )}
        </div>

        {mineAfter ? (
          <div className="mt-4 rounded-menu border border-border p-3.5">
            <LetAiRead
              ai={aiTeammate}
              address={short(a)}
              checked={aiReads}
              onChange={setAiReadsPick}
              testId="address-ai-reads"
            />
          </div>
        ) : null}

        {needsTakeover ? (
          <div
            className="mt-4 rounded-menu border border-warning/30 bg-warning-soft p-3.5"
            data-testid="address-takeover"
          >
            <p className="flex items-start gap-2 text-[13.5px] text-warning-text">
              <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
              <span>
                <strong className="font-semibold">{`Customers hear from ${short(a)} today.`}</strong>{' '}
                A private address can’t send for the business. Pick the one that takes over.
              </span>
            </p>
            <div
              role="radiogroup"
              aria-label="The address that takes over"
              className="mt-3 flex flex-col gap-2"
            >
              {candidates.map((x) => (
                <RadioCard
                  key={x.id}
                  selected={takeover === x.id}
                  onSelect={() => setTakeover(x.id)}
                  testId={`takeover-${x.localPart}`}
                  title={<span className="font-mono text-[13px]">{x.address}</span>}
                  description={
                    x.domain ? 'The team reads it.' : 'Your free address. The team reads it.'
                  }
                />
              ))}
            </div>
          </div>
        ) : null}

        {canBeDefault ? (
          <div className="mt-4">
            <Checkbox
              label="Make this the one customers hear from"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
              data-testid="address-make-default"
            />
            {today ? <Hint className="ml-7">{`Today that’s ${today.address}.`}</Hint> : null}
          </div>
        ) : null}

        {becomesPersons ? (
          <WhenYouSave>
            {takes
              ? `When you save, ${short(a)} becomes ${whose} and booking emails go out from ${short(takes)}. Both happen together.`
              : `When you save, ${short(a)} becomes ${whose}: the rest of the team stops seeing its mail.`}{' '}
            {reader === myUserId
              ? 'You can hand it back to the team here any time.'
              : `Only ${firstName(to?.name ?? '')} can hand it back to the team.`}
          </WhenYouSave>
        ) : handsBack ? (
          <WhenYouSave>
            {`When you save, new mail to ${short(a)} goes to the team’s Inbox. The mail you already got on it stays yours alone.`}
          </WhenYouSave>
        ) : null}

        {alert}

        <div className="mt-6 flex items-center gap-2 border-t border-border pt-4">
          {theirs ? null : a.isDefault ? (
            <span className="text-[12.5px] text-text-3">
              It stays while customers hear from it.
            </span>
          ) : lastFree ? (
            <span className="text-[12.5px] text-text-3">
              Your free address stays as the backup.
            </span>
          ) : (
            <Button
              variant="ghost"
              className="-ml-2 text-danger-text"
              onClick={() => setConfirming(true)}
              data-testid="address-remove"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              Remove address
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy === 'save'}
            disabled={theirs || !local || (needsTakeover && !takes)}
            onClick={() => void save()}
            data-testid="address-save"
          >
            Save changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const IDEAS = ['info', 'hello', 'bookings', 'sales', 'office', 'billing'];

/** Add an address on a website name whose records are found: it works right away. */
function AddAddress({
  workspaceId,
  domains,
  addresses,
  people,
  myUserId,
  aiTeammate,
  displayName,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  /** The verified ones. */
  domains: EmailDomainInfo[];
  addresses: EmailAddressInfo[];
  people: Person[];
  myUserId: string;
  aiTeammate: AiReader;
  /** The name customers see, which every address carries. */
  displayName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = people.find((p) => p.userId === myUserId) ?? null;
  const today = addresses.find((x) => x.isDefault) ?? null;
  // The first team address on the business's own name is the one customers hear from, as it always was.
  const firstOwn = !addresses.some((x) => x.isDefault && x.domain);
  const [domainId, setDomainId] = useState(domains[0]!.id);
  const [local, setLocal] = useState('');
  const [picked, setPicked] = useState<Reader | null>(null);
  const [defaultPicked, setDefaultPicked] = useState<boolean | null>(null);
  const [aiReads, setAiReadsPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const domain = domains.find((d) => d.id === domainId) ?? domains[0]!;
  const taken = new Set(
    addresses.filter((x) => x.emailDomainId === domain.id).map((x) => x.localPart),
  );
  const ideas = IDEAS.filter((i) => !taken.has(i)).slice(0, 4);
  // A name that is the person's own starts as theirs; everything else starts as the team's.
  const looksMine = !!me && !!local && local === firstName(me.name).toLowerCase();
  const reader = picked ?? (looksMine ? myUserId : TEAM);
  const isDefault = reader === TEAM && (defaultPicked ?? firstOwn);
  const to = people.find((p) => p.userId === reader) ?? null;

  async function add() {
    if (!local) return;
    setBusy(true);
    setError(null);
    try {
      const made = unwrap(
        await apiBrowser().POST('/v1/commands/email_address.create', {
          body: {
            workspaceId,
            localPart: local,
            emailDomainId: domain.id,
            displayName,
            isDefault,
            ...(reader !== TEAM ? { ownerUserId: reader } : {}),
          },
        }),
      );
      // The address is theirs now, so the switch is theirs to turn on. If that part fails, the address still stands.
      const reads =
        reader === myUserId && aiReads && aiTeammate
          ? await run(() => setAiReads(workspaceId, made.emailAddressId, true))
          : null;
      toast.success(
        isDefault
          ? `Customers now hear from ${made.address}`
          : reader === myUserId && reads
            ? `${made.address} added. Only you see its mail, and ${aiTeammate?.name ?? 'your AI teammate'} drafts answers for you.`
            : reader === myUserId
              ? `${made.address} added. Only you see its mail.`
              : to
                ? `${made.address} added. Only ${firstName(to.name)} sees its mail.`
                : `${made.address} added`,
      );
      onChanged();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent
        title="Add an address"
        description="It works right away. There are no new records to add."
        className="max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto"
      >
        {domains.length > 1 ? (
          <div className="mt-5">
            <Label htmlFor="address-add-domain">Website name</Label>
            <Select
              id="address-add-domain"
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
            >
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.domain}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="mt-5">
          <Label htmlFor="address-add-local">Address</Label>
          <LocalPartInput
            id="address-add-local"
            value={local}
            onChange={setLocal}
            suffix={domain.domain}
            placeholder="office"
            onEnter={() => void add()}
          />
          {ideas.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-text-3">
              <span>Ideas:</span>
              {ideas.map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setLocal(i)}
                  className="rounded-full border border-border px-2 py-0.5 font-mono text-[12px] text-text-2 hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                >
                  {i}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-5">
          <div id="address-add-reader" className="mb-1.5 text-[13px] font-medium">
            Who reads it
          </div>
          <ReaderPicker
            value={reader}
            onPick={setPicked}
            canBeMine={me ? myUserId : null}
            others={people.filter((p) => p.userId !== myUserId)}
            labelledBy="address-add-reader"
          />
          {picked === null && looksMine ? (
            <Hint>{`Picked for you: ${local}@ looks like yours. Pick The team if everyone should read it.`}</Hint>
          ) : null}
        </div>

        {reader === TEAM ? (
          <div className="mt-4">
            <Checkbox
              label="Make this the one customers hear from"
              checked={isDefault}
              onChange={(e) => setDefaultPicked(e.target.checked)}
              data-testid="address-add-default"
            />
            {today ? (
              <Hint className="ml-7">
                {isDefault && !today.domain
                  ? `Today that’s ${today.address}. It stays as the backup in case your own address ever stops working.`
                  : `Today that’s ${today.address}.`}
              </Hint>
            ) : null}
          </div>
        ) : (
          <>
            {reader === myUserId ? (
              <div className="mt-4 rounded-menu border border-border p-3.5">
                <LetAiRead
                  ai={aiTeammate}
                  address={`${local || 'this address'}${local ? '@' : ''}`}
                  checked={aiReads}
                  onChange={setAiReadsPick}
                  testId="address-add-ai-reads"
                />
              </div>
            ) : null}
            <WhenYouSave>
              {reader === myUserId
                ? 'Only you see the mail that comes to it and send from it. You can hand it to the team later.'
                : `Only ${firstName(to?.name ?? '')} sees the mail that comes to it and sends from it. Only they can hand it to the team later.`}
            </WhenYouSave>
          </>
        )}

        {error ? (
          <p className="mt-3 text-[13px] text-danger-text" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!local} onClick={() => void add()}>
            Add address
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The address of someone who has left (M19): new mail to it goes to the team's Inbox meanwhile, and the mail they had
 * stays sealed until an owner decides — the team's, another person's, or removed with its mail.
 */
function LeftBehind({
  workspaceId,
  address: a,
  people,
  onChanged,
}: {
  workspaceId: string;
  address: EmailAddressInfo;
  people: Person[];
  onChanged: () => void;
}) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState<'team' | 'person' | 'remove' | null>(null);
  const others = people.filter((p) => p.userId !== a.ownerUserId);
  async function reassign(kind: 'team' | 'person' | 'remove') {
    if (
      kind === 'remove' &&
      !window.confirm(`Remove ${a.address} and the mail on it? It can’t be brought back.`)
    )
      return;
    const name = others.find((p) => p.userId === to)?.name ?? '';
    setBusy(kind);
    const ok = await run(
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/email_address.reassign', {
            body: {
              workspaceId,
              emailAddressId: a.id,
              to: kind,
              ...(kind === 'person' ? { userId: to } : {}),
            },
          }),
        ),
      kind === 'team'
        ? `${a.address} and its mail are the team’s now`
        : kind === 'person'
          ? `${a.address} and its mail are ${firstName(name)}’s now`
          : `${a.address} is removed, with its mail`,
    );
    setBusy(null);
    if (ok) onChanged();
  }
  return (
    <div className="border-t border-border px-3.5 py-3" data-testid="address-left">
      <p className="text-[13px] text-text-2">
        {`${a.ownerName ?? 'Its person'} no longer works here. New mail to ${a.address} goes to the team’s Inbox, and the mail they had stays sealed until an owner decides what becomes of it.`}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'team'}
          onClick={() => void reassign('team')}
        >
          Give it to the team
        </Button>
        {others.length ? (
          <>
            <Select
              selectSize="sm"
              className="w-[180px]"
              aria-label={`Give ${a.address} to`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="">Or to one person…</option>
              {others.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!to}
              loading={busy === 'person'}
              onClick={() => void reassign('person')}
            >
              Give it to them
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="text-danger-text"
          loading={busy === 'remove'}
          onClick={() => void reassign('remove')}
        >
          Remove it
        </Button>
      </div>
    </div>
  );
}

function CopyGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}
