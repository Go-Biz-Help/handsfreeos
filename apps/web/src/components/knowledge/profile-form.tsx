'use client';
import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/errors';
import { fieldErrors } from '@/lib/api/field-errors';
import type { KnowledgeProfileGet, KnowledgeProfileValue } from '@/lib/api/types';
import { saveProfile } from '@/lib/knowledge/actions';
import { formatDate } from '@/lib/format';
import { ChipInput } from './chip-input';

type Service = KnowledgeProfileValue['services'][number];

/** The business profile: what you do, services, where and when, policies, tone of voice and prices. */
export function ProfileForm({
  workspaceId,
  canManage,
  profile,
}: {
  workspaceId: string;
  canManage: boolean;
  profile: KnowledgeProfileGet;
}) {
  const router = useRouter();
  const base = `/app/w/${workspaceId}/knowledge`;
  const [p, setP] = useState<KnowledgeProfileValue>(profile.profile);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ro = !canManage;
  const set = <K extends keyof KnowledgeProfileValue>(key: K, value: KnowledgeProfileValue[K]) =>
    setP((cur) => ({ ...cur, [key]: value }));
  const setService = (i: number, patch: Partial<Service>) =>
    set(
      'services',
      p.services.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (ro) return;
    const services = p.services
      .map((s) => ({
        ...s,
        name: s.name.trim(),
        description: s.description.trim(),
        price: s.price?.trim() || null,
      }))
      .filter((s) => s.name || s.description || s.price);
    if (services.some((s) => !s.name)) return setErrors({ name: 'Name each service.' });
    setBusy(true);
    setErrors({});
    try {
      const saved = await saveProfile(workspaceId, { ...p, services });
      toast.success(saved.updated.length ? 'Profile saved.' : 'Nothing changed.');
      router.push(base);
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) {
        setErrors(fe);
        toast.error('Check the highlighted fields.');
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex max-w-[760px] flex-col gap-4"
      data-testid="profile-form"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-[-0.005em]">Business profile</h2>
        {profile.updatedAt ? (
          <span className="text-xs text-text-3">
            Updated {formatDate(profile.updatedAt)}
            {profile.updatedBy ? ` by ${profile.updatedBy.fullName}` : ''}
          </span>
        ) : null}
      </div>
      {ro ? (
        <p className="rounded-[10px] bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2">
          Only owners and admins can change the profile.
        </p>
      ) : null}

      <Section title="What you do" id="description">
        <Field
          label="Describe the business"
          htmlFor="kp-description"
          hint="A sentence or two, as you’d tell a new customer."
          error={errors.description}
        >
          <Textarea
            id="kp-description"
            value={p.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={2000}
            disabled={ro}
            placeholder="Heating, cooling and roofing for homes and small businesses."
            invalid={!!errors.description}
          />
        </Field>
      </Section>

      <Section
        title="Services"
        id="services"
        description="What you offer. Prices are only used when AI may quote prices."
      >
        <div className="flex flex-col gap-2.5" data-testid="services">
          {p.services.map((s, i) => (
            <div
              key={i}
              className="grid gap-2 rounded-[10px] border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_140px_auto] sm:items-end"
            >
              <div>
                <Label htmlFor={`kp-service-${i}`}>Service</Label>
                <Input
                  id={`kp-service-${i}`}
                  value={s.name}
                  onChange={(e) => setService(i, { name: e.target.value })}
                  maxLength={120}
                  disabled={ro}
                  placeholder="AC tune-up"
                  invalid={!!errors.name && !s.name.trim()}
                />
              </div>
              <div>
                <Label htmlFor={`kp-service-about-${i}`}>About it</Label>
                <Input
                  id={`kp-service-about-${i}`}
                  value={s.description}
                  onChange={(e) => setService(i, { description: e.target.value })}
                  maxLength={500}
                  disabled={ro}
                  placeholder="Cleaning, checks and a report"
                />
              </div>
              <div>
                <Label htmlFor={`kp-service-price-${i}`}>Price</Label>
                <Input
                  id={`kp-service-price-${i}`}
                  value={s.price ?? ''}
                  onChange={(e) => setService(i, { price: e.target.value })}
                  maxLength={120}
                  disabled={ro}
                  placeholder="$89"
                />
              </div>
              {ro ? null : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${s.name || 'this service'}`}
                  onClick={() =>
                    set(
                      'services',
                      p.services.filter((_, j) => j !== i),
                    )
                  }
                  className="justify-self-end"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              )}
            </div>
          ))}
          {errors.name ? <p className="text-[12.5px] text-danger-text">{errors.name}</p> : null}
          {p.services.length === 0 && ro ? (
            <p className="text-[13px] text-text-2">No services yet.</p>
          ) : null}
          {ro || p.services.length >= 50 ? null : (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              data-testid="service-add"
              onClick={() =>
                set('services', [...p.services, { name: '', description: '', price: null }])
              }
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Add a service
            </Button>
          )}
        </div>
      </Section>

      <Section title="Where and when" id="serviceArea">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Service area" htmlFor="kp-area" error={errors.serviceArea}>
            <Textarea
              id="kp-area"
              value={p.serviceArea}
              onChange={(e) => set('serviceArea', e.target.value)}
              maxLength={500}
              disabled={ro}
              className="min-h-[72px]"
              placeholder="Houston inside the Beltway, Katy and Bellaire"
            />
          </Field>
          <div id="hours" className="scroll-mt-24">
            <Field label="Hours" htmlFor="kp-hours" error={errors.hours}>
              <Textarea
                id="kp-hours"
                value={p.hours}
                onChange={(e) => set('hours', e.target.value)}
                maxLength={500}
                disabled={ro}
                className="min-h-[72px]"
                placeholder="Mon–Fri 7 AM–6 PM, Sat 8 AM–1 PM. Emergencies 24/7."
              />
            </Field>
          </div>
        </div>
      </Section>

      <Section title="Policies" id="policies">
        <Field
          label="Policies customers ask about"
          htmlFor="kp-policies"
          hint="Cancellations, warranties, payment, service fees."
          error={errors.policies}
        >
          <Textarea
            id="kp-policies"
            value={p.policies}
            onChange={(e) => set('policies', e.target.value)}
            maxLength={3000}
            disabled={ro}
            placeholder="Cancel up to 24 hours ahead at no charge. Repairs carry a 90-day warranty."
          />
        </Field>
      </Section>

      <Section
        title="Tone of voice"
        id="tone"
        description="Every AI-written text and email uses this voice."
      >
        <div className="flex flex-col gap-4">
          <Field label="How messages should sound" htmlFor="kp-tone" error={errors.tone}>
            <Input
              id="kp-tone"
              value={p.tone}
              onChange={(e) => set('tone', e.target.value)}
              maxLength={300}
              disabled={ro}
              placeholder="Friendly, plain and neighborly"
            />
          </Field>
          <div>
            <Label htmlFor="kp-use">Words to use</Label>
            <ChipInput
              id="kp-use"
              value={p.wordsToUse}
              onChange={(v) => set('wordsToUse', v)}
              max={30}
              maxLength={60}
              disabled={ro}
              testId="words-use"
            />
          </div>
          <div>
            <Label htmlFor="kp-avoid">Words to avoid</Label>
            <ChipInput
              id="kp-avoid"
              value={p.wordsToAvoid}
              onChange={(v) => set('wordsToAvoid', v)}
              max={30}
              maxLength={60}
              danger
              disabled={ro}
              testId="words-avoid"
            />
          </div>
          <div id="signature" className="scroll-mt-24">
            <Field
              label="Sign messages as"
              htmlFor="kp-signature"
              hint="How texts and emails end."
              error={errors.signature}
            >
              <Input
                id="kp-signature"
                value={p.signature}
                onChange={(e) => set('signature', e.target.value)}
                maxLength={200}
                disabled={ro}
                placeholder="– Dale at Lone Star HVAC"
              />
            </Field>
          </div>
        </div>
      </Section>

      <Section title="Prices" id="prices">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">AI may quote prices</div>
            <Hint className="mt-0.5">
              Off by default. When it’s off, AI steps and the Assistant never quote a price; they
              say your team will confirm it. When it’s on, they quote only prices written in your
              services or published items, word for word, and never estimate or discount.
            </Hint>
          </div>
          <Switch
            checked={p.allowPrices}
            onChange={(v) => set('allowPrices', v)}
            label="AI may quote prices"
            disabled={ro}
            testId="profile-prices"
          />
        </div>
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <ButtonLink href={base} variant="ghost">
          {ro ? 'Back' : 'Cancel'}
        </ButtonLink>
        {ro ? null : (
          <Button type="submit" loading={busy} data-testid="profile-save">
            Save profile
          </Button>
        )}
      </div>
      <p className="text-xs text-text-3">
        Facts that change often, like specials, fit better as{' '}
        <Link href={`${base}/items`} className="font-medium text-accent-text hover:underline">
          knowledge items
        </Link>
        .
      </p>
    </form>
  );
}

function Section({
  title,
  id,
  description,
  children,
}: {
  title: string;
  id: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-24 px-[18px] py-4">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {description ? <p className="mt-0.5 text-[13px] text-text-2">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </Card>
  );
}
