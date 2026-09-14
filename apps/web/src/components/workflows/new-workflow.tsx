'use client';
import {
  describeStep,
  describeTrigger,
  recipeDefinition,
  resolvePlaceholders,
  suggestMapping,
  TRIGGER_EVENTS,
  WORKFLOW_RECIPES,
  type RecipeKey,
  type WorkflowCatalogs,
  type WorkflowRecipe,
} from '@hfos/core';
import { Building2, ChevronRight, Info, Plus, WandSparkles, Zap } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowCatalogsOut, WorkflowCreateBody, WorkflowSummary } from '@/lib/api/types';
import { refOptions } from '@/lib/workflows/fields';
import { cn } from '@/lib/utils';
import { KindTile, recipeIcon } from './chips';

type Category = 'Leads' | 'Appointments' | 'Sales';

/** The design's card copy for each recipe. */
const RECIPE_META: Record<RecipeKey, { category: Category; short: string; note: string }> = {
  speed_to_lead: {
    category: 'Leads',
    short: 'Text new leads within a minute.',
    note: 'Stops as soon as they reply or book.',
  },
  missed_call_text_back: {
    category: 'Leads',
    short: 'Text back, then AI sorts the reply.',
    note: 'The AI sorts each reply into a path: emergency, book, question or other.',
  },
  appointment_follow_up_review: {
    category: 'Appointments',
    short: 'Say thanks, then ask for a review.',
    note: 'Happy customers get the review link. An AI reply to an unhappy one waits for an approval.',
  },
  no_show_rebook: {
    category: 'Appointments',
    short: 'Text the booking link after a no-show.',
    note: 'Workflows can’t book for customers yet, so it sends the link.',
  },
  estimate_follow_up: {
    category: 'Sales',
    short: 'A text, an email, then a task.',
    note: 'Stops when the lead is won or lost, or they reply.',
  },
};

type BlankKind = 'event' | 'schedule' | 'date' | 'webhook' | 'manual';
const BLANK: {
  kind: BlankKind;
  title: string;
  detail: string;
  trigger: WorkflowCreateBody['trigger'];
}[] = [
  {
    kind: 'event',
    title: 'An event happens',
    detail: 'A new lead, a missed call, a booking',
    trigger: { kind: 'event', event: 'lead.created' },
  },
  {
    kind: 'schedule',
    title: 'On a schedule',
    detail: 'Every week or month, in your time zone',
    trigger: { kind: 'schedule', cadence: { every: 'weekly', days: [1], at: '09:00' } },
  },
  {
    kind: 'date',
    title: 'On a date',
    detail: 'Like 2 hours after an appointment ends',
    trigger: {
      kind: 'date',
      anchor: 'appointment.ends_at',
      offset: { amount: 2, unit: 'hours', direction: 'after' },
    },
  },
  {
    kind: 'webhook',
    title: 'Another app sends it',
    detail: 'A web address other tools can call',
    trigger: { kind: 'webhook' },
  },
  {
    kind: 'manual',
    title: 'Started by hand',
    detail: 'From a customer page or the Assistant',
    trigger: { kind: 'manual' },
  },
];

type Pick =
  { kind: 'recipe'; key: RecipeKey } | { kind: 'template'; id: string } | { kind: 'blank' };

const recipeTrigger = (r: WorkflowRecipe) => {
  const t = r.definition.trigger;
  return t.kind === 'event' ? TRIGGER_EVENTS[t.event].label : 'By hand';
};

/** "How do you want to start?": a recipe, a Go Biz Help template, Describe it (soon) or blank. */
export function NewWorkflow({
  workspaceId,
  businessName,
  catalogs: catalogsOut,
  templates,
  initialRecipe,
}: {
  workspaceId: string;
  businessName: string;
  catalogs: WorkflowCatalogsOut;
  /** Go Biz Help templates installed here as drafts. */
  templates: WorkflowSummary[];
  initialRecipe: RecipeKey | null;
}) {
  const router = useRouter();
  const catalogs = catalogsOut as WorkflowCatalogs;
  const [category, setCategory] = useState<'all' | Category>('all');
  const [pick, setPick] = useState<Pick>({
    kind: 'recipe',
    key: initialRecipe ?? 'speed_to_lead',
  });
  const [name, setName] = useState(
    WORKFLOW_RECIPES.find((r) => r.key === (initialRecipe ?? 'speed_to_lead'))!.name,
  );
  const [named, setNamed] = useState(false);
  const [mappings, setMappings] = useState<Record<string, Record<string, string | null>>>({});
  const [blank, setBlank] = useState<BlankKind>('event');
  const [busy, setBusy] = useState(false);

  const choose = (next: Pick, title: string) => {
    setPick(next);
    if (!named) setName(title);
  };

  const recipe = pick.kind === 'recipe' ? WORKFLOW_RECIPES.find((r) => r.key === pick.key)! : null;
  const template = pick.kind === 'template' ? templates.find((t) => t.id === pick.id) : null;
  const mapping = useMemo(() => {
    if (!recipe) return {};
    return mappings[recipe.key] ?? suggestMapping(recipe.placeholders, catalogs);
  }, [recipe, mappings, catalogs]);
  const preview = useMemo(() => {
    if (!recipe) return null;
    const def = resolvePlaceholders(recipeDefinition(recipe.key), mapping);
    return {
      trigger: describeTrigger(def.trigger, catalogs),
      steps: def.steps.map((s) => describeStep(s, catalogs, def)),
    };
  }, [recipe, mapping, catalogs]);

  async function create() {
    if (!name.trim()) return toast.error('Name the workflow.');
    setBusy(true);
    try {
      const body: WorkflowCreateBody =
        pick.kind === 'recipe'
          ? {
              workspaceId,
              name: name.trim(),
              from: 'recipe',
              recipeKey: pick.key,
              ...(recipe!.placeholders.length ? { mapping } : {}),
            }
          : {
              workspaceId,
              name: name.trim(),
              from: 'blank',
              trigger: BLANK.find((b) => b.kind === blank)!.trigger,
            };
      const out = unwrap(await apiBrowser().POST('/v1/commands/workflow.create', { body }));
      const missing = out.placeholders.length;
      toast.success(
        `Created the draft “${name.trim()}”.${missing ? ' Checks will ask for the missing detail.' : ''}`,
      );
      router.push(`/app/w/${workspaceId}/workflows/${out.workflowId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  const recipes = WORKFLOW_RECIPES.filter(
    (r) => category === 'all' || RECIPE_META[r.key].category === category,
  );
  const base = `/app/w/${workspaceId}/workflows`;

  return (
    <div data-testid="workflow-new-page">
      <div className="mb-2 flex items-center gap-1 text-xs text-text-3">
        <Link href={base} className="text-accent-text hover:underline">
          Workflows
        </Link>
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span>New workflow</span>
      </div>
      <h1 className="mb-3.5 text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
        New workflow
      </h1>
      <Card className="px-4 py-5 md:px-[22px]">
        <h2 className="text-lg font-semibold tracking-tight">How do you want to start?</h2>
        <p className="mb-3.5 mt-1 flex items-center gap-1.5 text-[13px] text-text-2">
          <Info className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
          Every choice makes a draft. Nothing runs until you test it and publish.
        </p>
        <div className="grid grid-cols-1 gap-[22px] lg:grid-cols-[minmax(0,1fr)_312px]">
          <div className="flex min-w-0 flex-col gap-2.5" role="radiogroup" aria-label="Start from">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionLabel>Recipes</SectionLabel>
              <Segmented
                ariaLabel="Recipe category"
                value={category}
                onChange={setCategory}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'Leads', label: 'Leads' },
                  { value: 'Appointments', label: 'Appointments' },
                  { value: 'Sales', label: 'Sales' },
                ]}
              />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {recipes.map((r) => (
                <PickCard
                  key={r.key}
                  selected={pick.kind === 'recipe' && pick.key === r.key}
                  onSelect={() => choose({ kind: 'recipe', key: r.key }, r.name)}
                  icon={<KindTile tone="act" icon={recipeIcon(r.key)} />}
                  title={r.name}
                  testId={`recipe-${r.key}`}
                  footer={
                    <span>
                      <span className="font-medium text-text-2">{RECIPE_META[r.key].category}</span>
                      {' · '}
                      {recipeTrigger(r)}
                    </span>
                  }
                >
                  {RECIPE_META[r.key].short}
                </PickCard>
              ))}
            </div>

            {templates.length ? (
              <>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <SectionLabel>From Go Biz Help</SectionLabel>
                  <span className="text-xs text-text-3">Installed here as drafts</span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {templates.map((t) => (
                    <PickCard
                      key={t.id}
                      selected={pick.kind === 'template' && pick.id === t.id}
                      onSelect={() => choose({ kind: 'template', id: t.id }, t.name)}
                      icon={<KindTile tone="act" icon={Building2} />}
                      title={t.name}
                      testId={`template-${t.id}`}
                      footer={
                        <span className="flex w-full items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{t.trigger.summary}</span>
                          {t.source.template?.installedVersion ? (
                            <Badge variant="gray" className="h-5 text-[11.5px]">
                              v{t.source.template.installedVersion}
                            </Badge>
                          ) : null}
                        </span>
                      }
                    >
                      {t.description ?? t.source.template?.name ?? 'A Go Biz Help template'}
                    </PickCard>
                  ))}
                </div>
              </>
            ) : null}

            <SectionLabel className="mt-1.5">Or</SectionLabel>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <PickCard
                selected={false}
                disabled
                title="Describe it"
                icon={<KindTile tone="ai" icon={WandSparkles} />}
                badge={
                  <Badge variant="gray" className="h-5 text-[11.5px]">
                    Soon
                  </Badge>
                }
                hint="Coming with the AI builder"
                small
                testId="start-describe"
              >
                Say it in a sentence. AI drafts it.
              </PickCard>
              <PickCard
                selected={pick.kind === 'blank'}
                onSelect={() => choose({ kind: 'blank' }, 'New workflow')}
                title="Start blank"
                icon={<KindTile tone="wait" icon={Plus} />}
                dashed
                small
                testId="start-blank"
              >
                Pick what starts it, then add steps.
              </PickCard>
            </div>
          </div>

          <aside
            className="flex flex-col gap-3 rounded-card border border-border bg-card-2 px-4 py-3.5"
            data-testid="new-preview"
          >
            {recipe && preview ? (
              <>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-text-3">
                    Recipe · {RECIPE_META[recipe.key].category}
                  </span>
                  <h2 className="text-lg font-semibold tracking-tight">{recipe.name}</h2>
                </div>
                <div className="flex items-start gap-1.5 text-[13px]">
                  <Zap className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={1.75} />
                  <span>{preview.trigger}</span>
                </div>
                <ol className="flex flex-col gap-[7px] rounded-[10px] border border-border bg-card px-3 py-2.5">
                  {preview.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-[13px]">
                      <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-card-2 text-[11px] font-semibold text-text-2">
                        {i + 1}
                      </span>
                      <span className="min-w-0">{s}</span>
                    </li>
                  ))}
                </ol>
                <SectionLabel>Fill in for {businessName}</SectionLabel>
                {recipe.placeholders.length ? (
                  <div className="flex flex-col gap-2" data-testid="placeholder-mapper">
                    {recipe.placeholders.map((ph) => {
                      const options = refOptions(ph.kind, catalogs);
                      const value = mapping[ph.key] ?? '';
                      return (
                        <label key={ph.key} className="flex items-center gap-2 text-[13px]">
                          <span className="min-w-0 flex-1">{ph.label}</span>
                          <Select
                            selectSize="sm"
                            className={cn('w-[160px]', !value && 'border-danger')}
                            aria-label={ph.label}
                            value={value}
                            onChange={(e) =>
                              setMappings({
                                ...mappings,
                                [recipe.key]: { ...mapping, [ph.key]: e.target.value || null },
                              })
                            }
                          >
                            <option value="">Pick later</option>
                            {options.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                      );
                    })}
                    {recipe.placeholders.some((p) => !mapping[p.key]) ? (
                      <Hint className="mt-0">
                        Anything left to pick shows in Checks, and blocks publishing until it’s set.
                      </Hint>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[13px] text-text-3">Nothing to fill in.</p>
                )}
              </>
            ) : null}

            {template ? (
              <>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-text-3">
                    Go Biz Help template
                    {template.source.template?.installedVersion
                      ? ` · version ${template.source.template.installedVersion}`
                      : ''}
                  </span>
                  <h2 className="text-lg font-semibold tracking-tight">{template.name}</h2>
                </div>
                <div className="flex items-start gap-1.5 text-[13px]">
                  <Zap className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={1.75} />
                  <span>{template.trigger.summary}</span>
                </div>
                <p className="text-[13px] text-text-2">
                  Go Biz Help installed this as a draft here. Open it to check the details, test it
                  and publish it.
                </p>
              </>
            ) : null}

            {pick.kind === 'blank' ? (
              <>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-text-3">Start from nothing</span>
                  <h2 className="text-lg font-semibold tracking-tight">What starts it?</h2>
                </div>
                <div
                  className="flex flex-col gap-1.5"
                  role="radiogroup"
                  aria-label="What starts it"
                >
                  {BLANK.map((b) => (
                    <button
                      key={b.kind}
                      type="button"
                      role="radio"
                      aria-checked={blank === b.kind}
                      onClick={() => setBlank(b.kind)}
                      data-testid={`blank-${b.kind}`}
                      className={cn(
                        'flex items-start gap-2.5 rounded-[9px] border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                        blank === b.kind
                          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
                          : 'border-border-strong bg-card hover:bg-card-2',
                      )}
                    >
                      <RadioDot on={blank === b.kind} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-[13px] font-medium">{b.title}</span>
                        <span className="text-xs text-text-2">{b.detail}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {pick.kind !== 'template' ? (
              <div>
                <Label htmlFor="workflow-name">Name</Label>
                <Input
                  id="workflow-name"
                  inputSize="sm"
                  aria-label="Workflow name"
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNamed(true);
                  }}
                />
                {recipe ? <Hint>{RECIPE_META[recipe.key].note}</Hint> : null}
              </div>
            ) : null}
            <div className="flex-1" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => router.push(base)}>
                Cancel
              </Button>
              {template ? (
                <Button
                  onClick={() => router.push(`${base}/${template.id}`)}
                  data-testid="open-template"
                >
                  Open the draft
                </Button>
              ) : (
                <Button
                  loading={busy}
                  disabled={!name.trim()}
                  onClick={() => void create()}
                  data-testid="workflow-create"
                >
                  {pick.kind === 'blank' ? 'Create blank draft' : 'Create draft'}
                </Button>
              )}
            </div>
          </aside>
        </div>
      </Card>
    </div>
  );
}

function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
        on ? 'border-accent' : 'border-border-strong',
      )}
    >
      {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
    </span>
  );
}

/** A pick-one card: icon, title, dot; a line of description; a footer. */
function PickCard({
  selected,
  onSelect,
  icon,
  title,
  children,
  footer,
  badge,
  disabled,
  dashed,
  small,
  hint,
  testId,
}: {
  selected: boolean;
  onSelect?: () => void;
  icon: ReactNode;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  dashed?: boolean;
  small?: boolean;
  hint?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      title={hint}
      data-testid={testId}
      onClick={() => {
        if (!disabled) onSelect?.();
      }}
      className={cn(
        'flex flex-col gap-1.5 rounded-menu border px-[13px] py-[11px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        small ? 'min-h-[70px]' : 'min-h-[92px]',
        dashed && !selected && 'border-dashed',
        selected
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
          : 'border-border-strong bg-card hover:bg-card-2',
        disabled && 'cursor-not-allowed opacity-70 hover:bg-card',
      )}
    >
      <span className="flex w-full items-center gap-2.5">
        {icon}
        <span className="min-w-0 flex-1 text-sm font-semibold">{title}</span>
        {badge}
        {disabled ? null : <RadioDot on={selected} />}
      </span>
      <span className="text-xs text-text-2">{children}</span>
      {footer ? (
        <span className="mt-auto flex w-full items-center text-xs text-text-3">{footer}</span>
      ) : null}
    </button>
  );
}
