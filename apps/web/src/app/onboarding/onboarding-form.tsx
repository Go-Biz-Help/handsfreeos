'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { publicEnv } from '@/lib/env';
import { cn } from '@/lib/utils';

export const TIMEZONES = [
  ['America/New_York', 'Eastern (New York)'],
  ['America/Chicago', 'Central (Chicago)'],
  ['America/Denver', 'Mountain (Denver)'],
  ['America/Phoenix', 'Arizona (Phoenix)'],
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
  ['America/Anchorage', 'Alaska'],
  ['Pacific/Honolulu', 'Hawaii'],
] as const;

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState<'home_services' | 'other'>('home_services');
  const [timezone, setTimezone] = useState('America/Chicago');
  const [agency, setAgency] = useState(false);
  const [agencyName, setAgencyName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give your business a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/organization.create', {
          body: {
            businessName: name.trim(),
            organizationName: agency && agencyName.trim() ? agencyName.trim() : undefined,
            timezone,
            industry,
          },
        }),
      );
      router.replace(`/app/w/${out.workspaceId}`);
      router.refresh();
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-[18px]" noValidate>
      <Field
        label="Business name"
        htmlFor="business"
        error={error}
        hint={name.trim() ? `Your workspace will be called ${name.trim()}.` : undefined}
      >
        <Input
          id="business"
          inputSize="lg"
          placeholder="Lone Star HVAC & Roofing"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          invalid={!!error}
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Industry" htmlFor="industry">
          <Select
            id="industry"
            selectSize="lg"
            value={industry}
            onChange={(e) => setIndustry(e.target.value as 'home_services' | 'other')}
          >
            <option value="home_services">Home services</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Time zone" htmlFor="timezone">
          <Select
            id="timezone"
            selectSize="lg"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {TIMEZONES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {publicEnv.agencySignupEnabled ? (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={agency}
            onClick={() => setAgency((v) => !v)}
            className="flex w-full items-start gap-3 rounded-menu border border-border bg-card-2 p-3.5 text-left"
          >
            <span
              className={cn(
                'relative mt-0.5 h-5 w-9 flex-none rounded-full transition-colors',
                agency ? 'bg-accent' : 'bg-border-strong',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]',
                  agency ? 'left-[18px]' : 'left-0.5',
                )}
              />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">I run an agency that manages several businesses</span>
              <span className="text-[13px] text-text-3">
                Each client becomes its own workspace under one organization you control.
              </span>
            </span>
          </button>
          {agency ? (
            <Field
              label="Agency name"
              htmlFor="agency"
              hint={`Shown in the workspace switcher as the organization that owns ${name.trim() || 'your business'}.`}
            >
              <Input
                id="agency"
                inputSize="lg"
                placeholder="Go Biz Help"
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
              />
            </Field>
          ) : null}
        </>
      ) : null}
      <Button type="submit" size="lg" className="mt-1 w-full" loading={busy}>
        Create business
      </Button>
    </form>
  );
}
