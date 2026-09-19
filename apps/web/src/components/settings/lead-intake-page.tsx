'use client';
/**
 * Settings → Lead intake (M14). Two cards: the three channels a stranger reaches the business on, each a
 * row that saves the moment it is flipped; and the ways a lead arrives from somewhere else — a form on the
 * business's own website, and the apps connected to it, each with a key of its own.
 *
 * A form's key is public and can be read back at any time; an app's secret key is shown once when it is made
 * or replaced, and after that only its last four characters.
 */
import {
  Boxes,
  Globe,
  KeyRound,
  MailIcon,
  MessageSquare,
  PhoneMissed,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { publicEnv } from '@/lib/env';
import { cn, relativeTime } from '@/lib/utils';
import { SetRow } from './set-row';

export type IntakeChannel = 'text' | 'call' | 'email';
export type IntakeKind = IntakeChannel | 'website_form' | 'api';

export interface IntakeSourceRow {
  readonly kind: IntakeKind;
  readonly sourceId: string | null;
  readonly name: string;
  readonly active: boolean;
  readonly createLead: boolean;
  readonly pipelineId: string | null;
  readonly stageId: string | null;
  readonly dailyCap: number;
  readonly todayCount: number;
  readonly lastIntakeAt: string | null;
  readonly publicKey: string | null;
  readonly secretHint: string | null;
  readonly allowedOrigins: readonly string[];
  readonly redirectUrl: string | null;
  readonly lastUsedAt: string | null;
}

/** What this screen may change about a source; everything else on a row is read back, never sent. */
export interface SourcePatch {
  readonly name?: string;
  readonly active?: boolean;
  readonly createLead?: boolean;
  readonly pipelineId?: string | null;
  readonly stageId?: string | null;
  readonly dailyCap?: number;
}

export interface IntakePipeline {
  readonly id: string;
  readonly name: string;
  readonly stages: readonly { readonly id: string; readonly name: string; readonly kind: string }[];
}

const CHANNELS: Record<
  IntakeChannel,
  { title: string; description: string; icon: typeof MessageSquare }
> = {
  text: {
    title: 'Someone texts your number',
    description:
      'A number you don’t have writes in. A STOP or a HELP is an instruction, not a lead, and your own numbers never count.',
    icon: MessageSquare,
  },
  call: {
    title: 'Someone calls and doesn’t get through',
    description:
      'A missed call or a voicemail from a number you don’t have. A call you answered is yours to file.',
    icon: PhoneMissed,
  },
  email: {
    title: 'Someone emails your business address',
    description:
      'A sender you don’t have writes in. Bounces, out-of-office replies and newsletters are left out of it.',
    icon: MailIcon,
  },
};

const isChannel = (kind: IntakeKind): kind is IntakeChannel =>
  kind === 'text' || kind === 'call' || kind === 'email';

/** Where a form posts, and where an app sends. */
const formUrl = (key: string) => `${publicEnv.workerUrl}/intake/f/${key}`;
const apiUrl = () => `${publicEnv.workerUrl}/v1/intake`;

const snippetFor = (key: string, redirect: string | null) =>
  `<form action="${formUrl(key)}" method="POST">
  <input name="name" placeholder="Your name" required />
  <input name="phone" type="tel" placeholder="Phone" />
  <input name="email" type="email" placeholder="Email" />
  <textarea name="message" placeholder="What do you need?"></textarea>
  <!-- Robots fill this in; people never see it. -->
  <input name="website" tabindex="-1" autocomplete="off" style="display:none" />
  <button type="submit">Send</button>
</form>${redirect ? `\n<!-- Afterwards they land on ${redirect} -->` : ''}`;

const curlFor = () =>
  `curl -X POST ${apiUrl()} \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Dana Reyes","phone":"512-555-0134","email":"dana@example.com","message":"Need a quote"}'`;

export function LeadIntakeSettings({
  workspaceId,
  sources,
  pipelines,
}: {
  workspaceId: string;
  sources: readonly IntakeSourceRow[];
  pipelines: readonly IntakePipeline[];
}) {
  const [rows, setRows] = useState<readonly IntakeSourceRow[]>(sources);
  /** A key just made or replaced: the only time a secret is ever shown. */
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const [adding, setAdding] = useState<'website_form' | 'api' | null>(null);
  const saving = useRef(false);

  const channels = rows.filter((r) => isChannel(r.kind));
  const keyed = rows.filter((r) => !isChannel(r.kind));

  async function save(row: IntakeSourceRow, patch: SourcePatch, done?: string) {
    const before = rows;
    setRows((r) =>
      r.map((s) => (s.kind === row.kind && s.sourceId === row.sourceId ? { ...s, ...patch } : s)),
    );
    if (saving.current) return;
    saving.current = true;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/intake_source.update', {
          body: {
            workspaceId,
            ...(row.sourceId ? { sourceId: row.sourceId } : { kind: row.kind as IntakeChannel }),
            ...patch,
          },
        }),
      );
      if (done) toast.success(done);
    } catch (e) {
      setRows(before);
      toast.error(errorMessage(e));
    } finally {
      saving.current = false;
    }
  }

  async function reload() {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/intake.list', { body: { workspaceId } }),
      );
      setRows(out.sources as IntakeSourceRow[]);
    } catch {
      /* The screen still shows what it has; the next change will say if something is wrong. */
    }
  }

  async function rotate(row: IntakeSourceRow) {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/intake_source.rotate_key', {
          body: { workspaceId, sourceId: row.sourceId! },
        }),
      );
      if (out.secret) setFresh({ name: row.name, secret: out.secret });
      else toast.success('New key. Paste it into your form.');
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function archive(row: IntakeSourceRow) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/intake_source.archive', {
          body: { workspaceId, sourceId: row.sourceId! },
        }),
      );
      setRows((r) => r.filter((s) => s.sourceId !== row.sourceId));
      toast.success(`${row.name} is retired.`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="px-4 py-1">
        {channels.map((s, i) => {
          const channel = CHANNELS[s.kind as IntakeChannel];
          const Icon = channel.icon;
          return (
            <div key={s.kind} className={cn(i > 0 && 'border-t border-border')}>
              <SetRow
                first
                center
                title={
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden className="size-4 text-text-3" />
                    {channel.title}
                  </span>
                }
                description={channel.description}
              >
                <Switch
                  checked={s.active}
                  label={channel.title}
                  testId={`intake-${s.kind}`}
                  onChange={(active) =>
                    void save(
                      s,
                      { active },
                      active ? 'New leads will come in here.' : 'Left as a conversation only.',
                    )
                  }
                />
              </SetRow>
              {s.active ? <SourceSettings row={s} pipelines={pipelines} onSave={save} /> : null}
            </div>
          );
        })}
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">Forms and connected apps</h2>
          <p className="mt-1 max-w-[560px] text-xs text-text-3">
            A form already on your website can post straight in, and a service like Zapier can send
            leads over. Both land here, under the same limits and pipelines as everything else.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setAdding('website_form')}>
            <Plus aria-hidden className="size-4" /> Website form
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAdding('api')}>
            <Plus aria-hidden className="size-4" /> Connect an app
          </Button>
        </div>
      </div>

      {keyed.length === 0 ? (
        <Card className="px-4 py-6 text-center text-sm text-text-3">
          Nothing connected yet. A website form takes about a minute.
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {keyed.map((s) => (
            <Card key={s.sourceId} className="px-4 py-1">
              <SetRow
                first
                center
                title={
                  <span className="flex items-center gap-2">
                    {s.kind === 'website_form' ? (
                      <Globe aria-hidden className="size-4 text-text-3" />
                    ) : (
                      <Boxes aria-hidden className="size-4 text-text-3" />
                    )}
                    {s.name}
                    {s.publicKey === null && s.kind === 'website_form' ? (
                      <Badge variant="gray">Forms you build here</Badge>
                    ) : null}
                  </span>
                }
                description={
                  s.kind === 'website_form'
                    ? s.publicKey
                      ? `Posts from ${s.allowedOrigins.join(', ') || 'no site yet'}`
                      : 'Where the leads from your own forms land.'
                    : `Secret key ending ${s.secretHint ?? '••••'}${
                        s.lastUsedAt
                          ? ` · last used ${relativeTime(s.lastUsedAt)}`
                          : ' · never used'
                      }`
                }
              >
                <div className="flex items-center gap-2">
                  {s.sourceId && s.publicKey !== null ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void rotate(s)}
                      title="Replace the key"
                    >
                      <RefreshCw aria-hidden className="size-4" />
                    </Button>
                  ) : null}
                  {s.sourceId && (s.publicKey || s.secretHint) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void archive(s)}
                      title="Retire it"
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  ) : null}
                  <Switch
                    checked={s.active}
                    label={s.name}
                    onChange={(active) =>
                      void save(s, { active }, active ? 'On.' : 'Nothing more arrives through it.')
                    }
                  />
                </div>
              </SetRow>
              {s.active ? (
                <>
                  <SourceSettings row={s} pipelines={pipelines} onSave={save} />
                  {s.publicKey ? (
                    <div className="border-t border-border py-3.5">
                      <Label>Paste this into your website</Label>
                      <Hint>
                        Anything else the form asks is kept with the lead. The hidden box catches
                        robots.
                      </Hint>
                      <pre className="mt-2 max-h-56 overflow-auto rounded-control bg-card-2 p-3 text-[11px] leading-relaxed">
                        {snippetFor(s.publicKey, s.redirectUrl)}
                      </pre>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-2"
                        onClick={() =>
                          void copyText(snippetFor(s.publicKey!, s.redirectUrl), 'Snippet copied.')
                        }
                      >
                        Copy the snippet
                      </Button>
                    </div>
                  ) : null}
                  {s.kind === 'api' ? (
                    <div className="border-t border-border py-3.5">
                      <Label>How an app sends one</Label>
                      <pre className="mt-2 max-h-56 overflow-auto rounded-control bg-card-2 p-3 text-[11px] leading-relaxed">
                        {curlFor()}
                      </pre>
                      <Hint>
                        Send the same request twice and only one lead opens. Pass your own{' '}
                        <code>dedupeKey</code> to decide what counts as the same one.
                      </Hint>
                    </div>
                  ) : null}
                </>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <p className="max-w-[640px] text-xs text-text-3">
        Someone who hasn’t said their name yet is filed under their number or address, and your AI
        teammate writes their real name over it the moment they give it. Someone already in your
        customers is linked to their record instead, and no second lead opens.
      </p>

      <AddSourceDialog
        workspaceId={workspaceId}
        kind={adding}
        onClose={() => setAdding(null)}
        onMade={async (made) => {
          setAdding(null);
          if (made.secret) setFresh({ name: made.name, secret: made.secret });
          await reload();
        }}
      />
      <FreshKeyDialog fresh={fresh} onClose={() => setFresh(null)} />
    </div>
  );
}

/** The settings every source shares: the lead it opens, where it lands, and the most a day. */
function SourceSettings({
  row,
  pipelines,
  onSave,
}: {
  row: IntakeSourceRow;
  pipelines: readonly IntakePipeline[];
  onSave: (row: IntakeSourceRow, patch: SourcePatch, done?: string) => Promise<void>;
}) {
  const pipeline = pipelines.find((p) => p.id === row.pipelineId) ?? null;
  return (
    <div className="flex flex-col gap-3 pb-4 pl-6">
      <label className="flex items-center gap-2 text-[13px]">
        <Switch
          checked={row.createLead}
          label="Open a lead"
          onChange={(createLead) =>
            void onSave(
              row,
              { createLead },
              createLead ? 'A lead opens too.' : 'The customer is made; no lead.',
            )
          }
        />
        Open a lead as well as the customer
      </label>
      {row.createLead ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-2">
          <span>Leads land in</span>
          <Select
            selectSize="sm"
            className="w-auto"
            aria-label={`Pipeline for ${row.name}`}
            value={row.pipelineId ?? ''}
            onChange={(e) =>
              void onSave(row, { pipelineId: e.target.value || null, stageId: null }, 'Saved.')
            }
          >
            <option value="">Your first pipeline</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {pipeline ? (
            <Select
              selectSize="sm"
              className="w-auto"
              aria-label={`Stage for ${row.name}`}
              value={row.stageId ?? ''}
              onChange={(e) => void onSave(row, { stageId: e.target.value || null }, 'Saved.')}
            >
              <option value="">Its first open stage</option>
              {pipeline.stages
                .filter((st) => st.kind === 'open')
                .map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
            </Select>
          ) : null}
          <span>, filed under</span>
          <NameField value={row.name} onSave={(name) => void onSave(row, { name }, 'Saved.')} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-2">
        <span>At most</span>
        <Input
          inputSize="sm"
          type="number"
          min={1}
          max={1000}
          className="w-20"
          aria-label={`Daily limit for ${row.name}`}
          defaultValue={row.dailyCap}
          onBlur={(e) => {
            const dailyCap = Math.max(1, Math.min(1000, Number(e.target.value) || 1));
            e.target.value = String(dailyCap);
            if (dailyCap !== row.dailyCap) void onSave(row, { dailyCap }, 'Saved.');
          }}
        />
        <span>a day.</span>
        <span className="text-text-3">
          {row.todayCount} so far today
          {row.lastIntakeAt ? ` · last ${relativeTime(row.lastIntakeAt)}` : ''}
        </span>
      </div>
    </div>
  );
}

/** Adding a website form or an app: a name, and — for a form — the sites it may be posted from. */
function AddSourceDialog({
  workspaceId,
  kind,
  onClose,
  onMade,
}: {
  workspaceId: string;
  kind: 'website_form' | 'api' | null;
  onClose: () => void;
  onMade: (made: { name: string; secret: string | null }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const form = kind === 'website_form';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!kind) return;
    const data = new FormData(e.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const sites = String(data.get('sites') ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const redirectUrl = String(data.get('redirectUrl') ?? '').trim();
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/intake_source.create', {
          body: {
            workspaceId,
            kind,
            name,
            ...(form ? { allowedOrigins: sites, redirectUrl: redirectUrl || null } : {}),
          },
        }),
      );
      toast.success(form ? 'Your form is ready to paste in.' : `${name} is connected.`);
      await onMade({ name, secret: out.secret });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        title={form ? 'Add a website form' : 'Connect an app'}
        description={
          form
            ? 'Your form posts straight in. It works on the sites you list here and nowhere else.'
            : 'Zapier, a lead-ad forwarder, or your own code. You get a secret key, shown once.'
        }
      >
        <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-4">
          <div>
            <Label htmlFor="intake-name">What to call it</Label>
            <Input
              id="intake-name"
              name="name"
              required
              maxLength={60}
              defaultValue={form ? 'Website form' : 'Zapier'}
            />
            <Hint>Its leads are filed under this, so you can tell where they came from.</Hint>
          </div>
          {form ? (
            <>
              <div>
                <Label htmlFor="intake-sites">The sites it may be posted from</Label>
                <Textarea
                  id="intake-sites"
                  name="sites"
                  rows={2}
                  placeholder="https://lonestarhvac.com"
                />
                <Hint>One a line. The www version is added for you.</Hint>
              </div>
              <div>
                <Label htmlFor="intake-redirect">Where to send them afterwards (optional)</Label>
                <Input
                  id="intake-redirect"
                  name="redirectUrl"
                  type="url"
                  placeholder="https://lonestarhvac.com/thank-you"
                />
              </div>
            </>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {form ? 'Make the form' : 'Make the key'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A secret key, the once it is ever shown. */
function FreshKeyDialog({
  fresh,
  onClose,
}: {
  fresh: { name: string; secret: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={fresh !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        title={`${fresh?.name ?? 'Your app'}’s key`}
        description="Copy it now. It is never shown again — if it is lost, make a new one."
      >
        <pre className="mt-3 overflow-auto rounded-control bg-card-2 p-3 text-[12px]">
          {fresh?.secret}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => void copyText(fresh?.secret ?? '', 'Key copied.')}
          >
            <KeyRound aria-hidden className="size-4" /> Copy
          </Button>
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The source's name, saved when you leave the box. */
function NameField({ value, onSave }: { value: string; onSave: (next: string) => void }) {
  return (
    <Input
      inputSize="sm"
      className="w-40"
      aria-label="What its leads are filed under"
      defaultValue={value}
      maxLength={60}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (!next) {
          e.target.value = value;
          return;
        }
        if (next !== value) onSave(next);
      }}
    />
  );
}
