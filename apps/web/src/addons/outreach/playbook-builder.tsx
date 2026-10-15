'use client';
/**
 * Social Outreach's playbook builder (docs/outreach.md): a playbook asked a question at a time, each with choices to
 * tap and room for the business's own words, and a conversation script where each answer adds one of the playbook's
 * tags and says what happens next. A new playbook walks every step; one being changed opens on the last, where each
 * part has its own Change. It's checked as it's written by the same rules the server holds (`PlaybookDetails`), so a
 * step with a problem on it doesn't carry on.
 */
import { NICHE_FIT_WORDS, type NicheFitOutput } from '@hfos/core/addons/outreach/niche-fit';
import { FIRST_NAME } from '@hfos/core/addons/outreach/openers';
import type {
  AssistDraft,
  AssistQuestion,
  PlaybookOffer,
} from '@hfos/core/addons/outreach/playbook-assist';
import {
  ANSWER_NEXTS,
  answerNextLabel,
  blankPlaybook,
  nextQuestionId,
  followUpGapsFor,
  PACE_LIMITS,
  paceOf,
  PLAYBOOK_GOAL_KEYS,
  PLAYBOOK_GOALS,
  PLAYBOOK_LIMITS,
  PLAYBOOK_STEP_KEYS,
  PLAYBOOK_STEPS,
  PLAYBOOK_SUGGESTIONS,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
  type PlaybookAnswer,
  type PlaybookGoal,
  type PlaybookQuestion,
  type PlaybookStep,
  type PlaybookTemplateKey,
} from '@hfos/core/addons/outreach/playbooks';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Info,
  MessageCircleQuestion,
  Plus,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Field, FieldError, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Stepper } from '@/components/ui/stepper';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AiHelp } from './ai-help';
import type { Playbook } from './types';

// ---------- the answers ----------

/** The playbook as it's being written: words as typed, so nothing half-written is lost between steps. */
interface Draft {
  name: string;
  goal: PlaybookGoal;
  offer: string;
  link: string;
  niche: string;
  problem: string;
  proof: string[];
  usefulWhat: string;
  usefulLink: string;
  audience: string;
  signs: string[];
  skip: string[];
  area: string;
  platforms: PlaybookDetails['platforms'];
  groupWords: string[];
  steps: PlaybookStep[];
  pace: PlaybookDetails['pace'];
  tone: string;
  samples: string[];
  openerStyles: string[];
  ownOpeners: string[];
  questions: PlaybookQuestion[];
  avoid: string[];
  disclaimer: string;
  tags: string[];
}

const fromDetails = (name: string, d: PlaybookDetails): Draft => ({
  name,
  goal: d.goal,
  offer: d.offer ?? '',
  link: d.link ?? '',
  niche: d.niche ?? '',
  problem: d.problem ?? '',
  proof: d.proof ?? [],
  usefulWhat: d.usefulWhat ?? '',
  usefulLink: d.usefulLink ?? '',
  audience: d.audience ?? '',
  signs: d.signs,
  skip: d.skip,
  area: d.area ?? '',
  platforms: d.platforms,
  groupWords: d.groupWords,
  steps: d.steps,
  pace: d.pace,
  tone: d.tone ?? '',
  samples: d.samples,
  openerStyles: d.openerStyles,
  ownOpeners: d.ownOpeners,
  questions: d.questions,
  avoid: d.avoid,
  disclaimer: d.disclaimer ?? '',
  tags: d.tags,
});

const orNull = (v: string) => v.trim() || null;

/** The lists written a line at a time, in a box with Add. */
const LIST_KEYS = [
  'proof',
  'signs',
  'skip',
  'groupWords',
  'tags',
  'avoid',
  'openerStyles',
] as const;
type ListKey = (typeof LIST_KEYS)[number];
/** The lists of whole messages, each in its own box. */
type MessageKey = 'samples' | 'ownOpeners';
type MultiKey = ListKey | MessageKey;
/** What's typed in a list's box and not added yet. */
type Typing = Partial<Record<ListKey, string>>;

/** The playbook with what's typed in each list's box added, unless it's there already or the list is full. */
const withTyping = (d: Draft, typing: Typing): Draft =>
  LIST_KEYS.reduce((out, k) => {
    const t = typing[k]?.trim();
    const list = out[k];
    return t &&
      list.length < PLAYBOOK_LIMITS[k].most &&
      !list.some((x) => x.toLowerCase() === t.toLowerCase())
      ? { ...out, [k]: [...list, t] }
      : out;
  }, d);

/** What's saved: empty words as none, the steps in the order they're taken, and blank messages left out. */
const toDetails = (d: Draft): PlaybookDetails => ({
  goal: d.goal,
  offer: orNull(d.offer),
  link: orNull(d.link),
  niche: orNull(d.niche),
  problem: orNull(d.problem),
  proof: d.proof,
  usefulWhat: orNull(d.usefulWhat),
  usefulLink: orNull(d.usefulLink),
  audience: orNull(d.audience),
  signs: d.signs,
  skip: d.skip,
  area: orNull(d.area),
  platforms: d.platforms,
  groupWords: d.groupWords,
  steps: PLAYBOOK_STEP_KEYS.filter((s) => d.steps.includes(s)),
  pace: d.pace,
  tone: orNull(d.tone),
  samples: d.samples.map((s) => s.trim()).filter(Boolean),
  openerStyles: d.openerStyles,
  ownOpeners: d.ownOpeners.map((s) => s.trim()).filter(Boolean),
  questions: d.questions,
  avoid: d.avoid,
  disclaimer: orNull(d.disclaimer),
  tags: d.tags,
});

/** "example.com/book" is taken to mean https://example.com/book. */
const withScheme = (v: string) => {
  const t = v.trim();
  return t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[^\s/]+\.[^\s/]+/.test(t) ? `https://${t}` : t;
};

/** "Friendly" and then "No hard sell" make "Friendly, no hard sell". */
const addWords = (text: string, words: string) => {
  const t = text.trim().replace(/[.,;]+$/, '');
  return t ? `${t}, ${words.charAt(0).toLowerCase()}${words.slice(1)}` : words;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What an answer to the question at `at` leads to, in words: "Ask question 4", with the question's words too where
 * there's room. After the last question, carrying on means the questions are done.
 */
function leadsTo(
  next: string,
  at: number,
  questions: readonly PlaybookQuestion[],
  withText = false,
): string {
  if (next === 'continue')
    return at === questions.length - 1 ? 'No more questions' : ANSWER_NEXTS.continue;
  const to = questions.findIndex((q) => q.id === next);
  if (to < 0) return answerNextLabel(next, questions);
  const text = questions[to]!.text.trim();
  return withText && text ? `Ask question ${to + 1}: “${short(text)}”` : `Ask question ${to + 1}`;
}

/**
 * An answer's row: what they say, the tag it adds, what's next, and Take out. On a phone the words and Take out
 * share a line, and each choice has its own.
 */
const ANSWER_ROW =
  'grid grid-cols-[minmax(0,1fr)_32px] items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,185px)_minmax(0,215px)_32px] sm:gap-2';

const short = (text: string, most = 48) =>
  text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text;

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------- the steps ----------

type StepKey =
  | 'goal'
  | 'niche'
  | 'offer'
  | 'who'
  | 'skip'
  | 'where'
  | 'steps'
  | 'tags'
  | 'conversation'
  | 'voice'
  | 'openers'
  | 'review';

interface Step {
  readonly key: StepKey;
  /** The question it asks. */
  readonly title: string;
  /** One line under it: what the answer is for. */
  readonly blurb: string;
  /** Its name on the last step, beside Change. */
  readonly part: string;
  /** The parts of the playbook it writes. A problem in one of them keeps the step from carrying on. */
  readonly fields: readonly (keyof PlaybookDetails)[];
}

const STEPS: readonly Step[] = [
  {
    key: 'goal',
    part: 'Goal',
    title: 'What do you want from Facebook?',
    blurb: 'One thing a playbook. Make another playbook for something else.',
    fields: ['goal'],
  },
  {
    key: 'niche',
    part: 'Niche',
    title: 'Who in your main offer is this for?',
    blurb:
      'One slice of who your main offer is for. A playbook that talks to one kind of person gets more replies.',
    fields: ['niche', 'problem', 'proof'],
  },
  {
    key: 'offer',
    part: 'Offer',
    title: 'What do you offer them?',
    blurb: 'In your own words, and where they book or buy.',
    fields: ['offer', 'link', 'usefulWhat', 'usefulLink'],
  },
  {
    key: 'who',
    part: 'Who',
    title: 'Who are you looking for?',
    blurb: 'The extension and the AI look for these signs on profiles and posts.',
    fields: ['audience', 'signs', 'area'],
  },
  {
    key: 'skip',
    part: 'Leave alone',
    title: 'Who never gets a pitch?',
    blurb: 'The extension and the AI leave people like these alone.',
    fields: ['skip'],
  },
  {
    key: 'where',
    part: 'Where to look',
    title: 'Where do you find them?',
    blurb: 'Words to search for, to find the groups these people are in.',
    fields: ['platforms', 'groupWords'],
  },
  {
    key: 'steps',
    part: 'Steps and pace',
    title: 'What it does, and how fast',
    blurb: 'The steps it takes with each person, in this order.',
    fields: ['steps', 'pace'],
  },
  {
    key: 'tags',
    part: 'Tags',
    title: 'Which of your tags may it use?',
    blurb: 'People are only ever tagged with these. Answers in the conversation add them.',
    fields: ['tags'],
  },
  {
    key: 'conversation',
    part: 'Conversation',
    title: 'The conversation',
    blurb:
      'The questions you work into a chat. Each answer can add a tag, and says what happens next.',
    fields: ['questions'],
  },
  {
    key: 'voice',
    part: 'How you sound',
    title: 'How do you sound?',
    blurb: 'So the drafts sound like you.',
    fields: ['tone', 'samples', 'avoid', 'disclaimer'],
  },
  {
    key: 'openers',
    part: 'Openers',
    title: 'How do you start a chat?',
    blurb: 'First messages take turns with these, so you can see which ones get replies and demos.',
    fields: ['openerStyles', 'ownOpeners'],
  },
  {
    key: 'review',
    part: 'Check it',
    title: 'Check it and save',
    blurb: 'This is what the extension and the AI follow.',
    fields: [],
  },
];
const REVIEW = STEPS.length - 1;

interface Issue {
  /** Where, as dots: `questions.0.answers.1.tag`. */
  readonly path: string;
  readonly message: string;
}

// ---------- the builder ----------

export function PlaybookBuilder({
  workspaceId,
  playbook,
  template,
  businessTags,
  bookingPages,
  brandedOrigin,
  mainOffer,
  doneHref,
}: {
  workspaceId: string;
  /** The playbook to change; null for a new one. */
  playbook: Playbook | null;
  /** Where a new one starts: a template, or null for blank. */
  template: PlaybookTemplateKey | null;
  /** The business's own tags, most used first, to tap in. */
  businessTags: readonly string[];
  /** The business's booking pages, to use as the link. */
  bookingPages: readonly { readonly name: string; readonly path: string }[];
  /** The business's own domain, when one is serving its public pages. */
  brandedOrigin: string | null;
  /** The business's live main offer (core's, docs/main-offer.md), which a playbook narrows; null with none live. */
  mainOffer: PlaybookOffer | null;
  /** Where saving or leaving goes: the Playbooks tab, or the setup it was started from. */
  doneHref?: string;
}) {
  const router = useRouter();
  const origin = usePublicOrigin(brandedOrigin);
  const home = doneHref ?? outreachHref(workspaceId, { view: 'playbooks' });
  const [start] = useState<Draft>(() => {
    if (playbook) return fromDetails(playbook.name, playbook.details as PlaybookDetails);
    const d = template
      ? fromDetails(PLAYBOOK_TEMPLATES[template].name, PLAYBOOK_TEMPLATES[template].details)
      : fromDetails('', blankPlaybook());
    // A new one's offer starts as the main offer's outcome, in a few words, to change if it needs to.
    return d.offer || !mainOffer?.outcome ? d : { ...d, offer: mainOffer.outcome };
  });
  const [draft, setDraft] = useState(start);
  const [at, setAt] = useState(playbook ? REVIEW : 0);
  /** Reached from the last step's Change: carrying on goes back there. */
  const [fromReview, setFromReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** The AI's word on whether the niche fits the main offer, for the niche it read. */
  const [fit, setFit] = useState<{ niche: string; out: NicheFitOutput } | null>(null);
  const [checking, setChecking] = useState(false);
  const offerHref = `/app/w/${workspaceId}/settings/main-offer`;
  /** Typed in a list's box and not added yet: it counts as added, and is added on moving to another step. */
  const [typing, setTyping] = useState<Typing>({});
  const typed = (k: ListKey) => ({
    text: typing[k] ?? '',
    onText: (t: string) => setTyping((x) => ({ ...x, [k]: t })),
  });

  const top = useRef<HTMLDivElement>(null);
  const shown = useRef(at);
  useEffect(() => {
    if (shown.current === at) return;
    shown.current = at;
    top.current?.scrollIntoView({ block: 'start' });
  }, [at]);

  // Closing the tab with changes not saved asks first.
  const dirty = useMemo(
    () =>
      !saved &&
      (JSON.stringify(draft) !== JSON.stringify(start) ||
        Object.values(typing).some((t) => t?.trim())),
    [draft, saved, start, typing],
  );
  useEffect(() => {
    if (!dirty) return;
    const stay = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need a return value to show the "leave site?" prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [dirty]);

  const issues = useMemo<Issue[]>(() => {
    const checked = PlaybookDetails.safeParse(toDetails(withTyping(draft, typing)));
    return checked.success
      ? []
      : checked.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        }));
  }, [draft, typing]);
  const nameIssue = taken ?? (draft.name.trim() ? null : 'Give the playbook a name.');
  const problems = (s: Step) =>
    issues.filter((i) => s.fields.some((f) => i.path === f || i.path.startsWith(`${f}.`)));
  const issueAt = (path: string) => issues.find((i) => i.path === path)?.message;
  /** The first problem in a part, wherever in it: one of a list's lines, or the list. */
  const issueIn = (path: string) =>
    issues.find((i) => i.path === path || i.path.startsWith(`${path}.`))?.message;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  /** Taking a tag out takes it off the answers that added it too. */
  const setTags = (tags: string[]) =>
    setDraft((d) => {
      const kept = new Set(tags.map((t) => t.toLowerCase()));
      return {
        ...d,
        tags,
        questions: d.questions.map((q) => ({
          ...q,
          answers: q.answers.map((a) =>
            a.tag !== null && !kept.has(a.tag.toLowerCase()) ? { ...a, tag: null } : a,
          ),
        })),
      };
    });

  /** The playbook as the AI reads it: as it stands, with what's typed in a list's box added. */
  const assistDraft = useMemo<AssistDraft>(() => {
    const d = withTyping(draft, typing);
    return {
      name: d.name,
      goal: d.goal,
      niche: d.niche,
      problem: d.problem,
      offer: d.offer,
      audience: d.audience,
      area: d.area,
      tone: d.tone,
      disclaimer: d.disclaimer,
      signs: d.signs,
      skip: d.skip,
      groupWords: d.groupWords,
      tags: d.tags,
      samples: d.samples.filter((m) => m.trim()),
      openerStyles: d.openerStyles,
      ownOpeners: d.ownOpeners.filter((m) => m.trim()),
      avoid: d.avoid,
      questions: d.questions.map((q) => ({
        text: q.text,
        answers: q.answers.map((a) => ({ label: a.label })),
      })),
    };
  }, [draft, typing]);
  /** Adds a line the AI suggested to a list, unless it's there already or the list is full. */
  const addLine = (k: MultiKey, line: string): boolean => {
    const list = draft[k].filter((x) => x.trim());
    if (list.some((x) => x.toLowerCase() === line.toLowerCase())) return true;
    if (list.length >= PLAYBOOK_LIMITS[k].most) {
      toast.error(`That’s ${PLAYBOOK_LIMITS[k].most}, the most it takes. Take one out first.`);
      return false;
    }
    if (k === 'tags') setTags([...list, line]);
    else set(k, [...list, line]);
    return true;
  };
  /** Uses the AI's rewrite of a list in place of what's there. */
  const replaceLines = (k: MultiKey, lines: string[]) => {
    if (k === 'tags') setTags(lines);
    else set(k, lines);
    if (k !== 'samples' && k !== 'ownOpeners') setTyping((x) => ({ ...x, [k]: '' }));
  };
  const addQuestion = (q: AssistQuestion) =>
    setDraft((d) =>
      d.questions.length >= PLAYBOOK_LIMITS.questions.most
        ? d
        : {
            ...d,
            questions: [
              ...d.questions,
              {
                id: nextQuestionId(d.questions),
                text: q.text,
                answers: q.answers.map((a) => ({ ...a })),
              },
            ],
          },
    );
  /** AI help for one of the parts. */
  const help = (
    part: 'niche' | 'problem' | 'offer' | 'audience' | 'area' | 'tone' | 'disclaimer',
  ) => (
    <AiHelp
      workspaceId={workspaceId}
      part={part}
      draft={assistDraft}
      written={!!draft[part].trim()}
      onWords={(w) => set(part, w)}
    />
  );
  /** Proof has no AI help: a result is real or it isn't there. */
  const listHelp = (k: Exclude<MultiKey, 'proof'>) => (
    <AiHelp
      workspaceId={workspaceId}
      part={k}
      draft={assistDraft}
      written={assistDraft[k].length > 0}
      onAdd={(line) => addLine(k, line)}
      onReplace={(lines) => replaceLines(k, lines)}
    />
  );

  const go = (to: number, back: boolean) => {
    setDraft((d) => {
      const kept = withTyping(d, typing);
      // A blank playbook gets its goal as a name to start from.
      return to === REVIEW && !kept.name.trim()
        ? { ...kept, name: PLAYBOOK_GOALS[kept.goal] }
        : kept;
    });
    setTyping({});
    setAt(to);
    setFromReview(back && to !== REVIEW);
  };

  const step = STEPS[at]!;
  const stuck = problems(step);

  /** Asks the AI whether the niche is inside the main offer's who. It only says; it never stops the playbook. */
  const checkFit = async () => {
    const niche = draft.niche.trim();
    setChecking(true);
    try {
      const out = await workerPost<NicheFitOutput>(
        '/v1/addons/outreach/actions/outreach.playbook.niche_fit',
        { workspaceId, input: { niche, problem: draft.problem.trim() } },
      );
      setFit({ niche, out });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  const fitShown = fit && fit.niche === draft.niche.trim() ? fit.out : null;

  const save = async () => {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.playbook.save', {
          body: {
            workspaceId,
            ...(playbook ? { playbookId: playbook.id } : { template }),
            name: draft.name.trim(),
            details: toDetails(withTyping(draft, typing)),
          },
        }),
      );
      setSaved(true);
      toast.success(playbook ? `${out.name} is saved.` : `${out.name} is ready.`);
      router.push(home);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'outreach_playbook_name_taken') setTaken(e.message);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  switch (step.key) {
    case 'goal':
      body = (
        <div
          role="radiogroup"
          aria-label="What you want from Facebook"
          className="grid gap-2 sm:grid-cols-2"
        >
          {PLAYBOOK_GOAL_KEYS.map((k) => (
            <RadioCard
              key={k}
              selected={draft.goal === k}
              onSelect={() => set('goal', k)}
              title={PLAYBOOK_GOALS[k]}
              testId={`goal-${k}`}
            />
          ))}
        </div>
      );
      break;
    case 'niche':
      body = (
        <div className="space-y-5">
          {mainOffer ? (
            <div
              className="rounded-card border border-border bg-card-2 p-4 text-[13.5px]"
              data-testid="playbook-main-offer"
            >
              <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-text-3">
                Your main offer
              </h3>
              <p className="mt-1">{mainOffer.line}</p>
              {mainOffer.who ? (
                <p className="mt-1 text-text-2">Who it’s for: {mainOffer.who}</p>
              ) : null}
              <Link
                href={offerHref}
                className="mt-2 inline-block text-[13px] text-accent-text hover:underline"
              >
                Change it in Settings → Main offer
              </Link>
            </div>
          ) : (
            <Callout
              tone="warning"
              data-testid="playbook-no-main-offer"
              action={
                <Link
                  href={offerHref}
                  className={buttonClassName({ variant: 'secondary', size: 'sm' })}
                >
                  Build it
                </Link>
              }
            >
              {NICHE_FIT_WORDS.no_offer}
            </Callout>
          )}
          <div>
            <Field
              label="Niche"
              htmlFor="pb-niche"
              hint="One kind of person, like “Roofers with 2 to 3 crews in Ohio”."
              error={issueAt('niche')}
            >
              <Input
                id="pb-niche"
                value={draft.niche}
                maxLength={PLAYBOOK_LIMITS.niche}
                onChange={(e) => set('niche', e.target.value)}
                data-testid="playbook-niche"
              />
            </Field>
            {mainOffer?.who ? (
              <Picks
                label="From your main offer"
                options={[mainOffer.who]}
                on={(o) => draft.niche === o}
                onPick={(o) => set('niche', o)}
              />
            ) : null}
            {help('niche')}
            {mainOffer && draft.niche.trim() ? (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                loading={checking}
                onClick={() => void checkFit()}
                data-testid="playbook-niche-check"
              >
                Check it fits my main offer
              </Button>
            ) : null}
            {fitShown ? (
              <Callout
                className="mt-3"
                tone={fitShown.fit === 'inside' ? 'info' : 'warning'}
                icon={fitShown.fit === 'inside' ? CheckCircle2 : undefined}
                data-testid="playbook-niche-fit"
                data-fit={fitShown.fit}
              >
                <div>
                  {NICHE_FIT_WORDS[fitShown.fit]}
                  {'why' in fitShown && fitShown.why ? (
                    <div className="mt-1 text-[13px] opacity-90">{fitShown.why}</div>
                  ) : null}
                </div>
              </Callout>
            ) : null}
          </div>
          <div>
            <Field
              label="Their biggest problem"
              htmlFor="pb-problem"
              hint="The one that costs them most, as they’d say it. First messages and your video lead with it."
              error={issueAt('problem')}
            >
              <Textarea
                id="pb-problem"
                rows={2}
                maxLength={PLAYBOOK_LIMITS.problem}
                value={draft.problem}
                onChange={(e) => set('problem', e.target.value)}
                data-testid="playbook-problem"
              />
            </Field>
            {help('problem')}
          </div>
          <ListField
            id="pb-proof"
            {...typed('proof')}
            label="Proof for this niche (optional)"
            hint="Real results only, a line each. The AI never makes one up."
            placeholder="Like “A 3-crew roofer got 14 inspections in 30 days”"
            items={draft.proof}
            onChange={(v) => set('proof', v)}
            suggestions={
              mainOffer?.proof.length
                ? [{ label: 'From your main offer', options: mainOffer.proof }]
                : []
            }
            limits={PLAYBOOK_LIMITS.proof}
            error={issueIn('proof')}
          />
        </div>
      );
      break;
    case 'offer':
      body = (
        <div className="space-y-5">
          <div>
            <Field
              label={W.offerLabel}
              htmlFor="pb-offer"
              hint="In your words, like “A 20-minute demo”."
              error={issueAt('offer')}
            >
              <Input
                id="pb-offer"
                value={draft.offer}
                maxLength={PLAYBOOK_LIMITS.offer}
                onChange={(e) => set('offer', e.target.value)}
                data-testid="playbook-offer"
              />
            </Field>
            {mainOffer?.outcome ? (
              <Picks
                label="From your main offer"
                options={[mainOffer.outcome]}
                on={(o) => draft.offer === o}
                onPick={(o) => set('offer', o)}
              />
            ) : null}
            <Picks
              label="Ideas"
              options={PLAYBOOK_SUGGESTIONS.offers[draft.goal]}
              on={(o) => draft.offer === o}
              onPick={(o) => set('offer', o)}
            />
            {help('offer')}
          </div>
          <div>
            <Field
              label="Where they book or buy (optional)"
              htmlFor="pb-link"
              hint="The link the drafts send when someone’s ready."
              error={issueAt('link')}
            >
              <Input
                id="pb-link"
                value={draft.link}
                placeholder="https://"
                inputMode="url"
                maxLength={PLAYBOOK_LIMITS.link}
                onChange={(e) => set('link', e.target.value)}
                onBlur={() => set('link', withScheme(draft.link))}
                data-testid="playbook-link"
              />
            </Field>
            {origin ? (
              <Picks
                label="Your booking pages"
                options={bookingPages.map((p) => p.name)}
                on={(name) =>
                  draft.link === `${origin}${bookingPages.find((p) => p.name === name)?.path}`
                }
                onPick={(name) => {
                  const page = bookingPages.find((p) => p.name === name);
                  if (page) set('link', `${origin}${page.path}`);
                }}
              />
            ) : null}
          </div>
          <div className="space-y-3">
            <Field
              label="Something useful to send (optional)"
              htmlFor="pb-useful-what"
              hint="A guide, a checklist or a video worth having, for someone who never answered."
              error={issueAt('usefulWhat')}
            >
              <Input
                id="pb-useful-what"
                value={draft.usefulWhat}
                placeholder="Like “A storm-season checklist”"
                maxLength={PLAYBOOK_LIMITS.usefulWhat}
                onChange={(e) => set('usefulWhat', e.target.value)}
                data-testid="playbook-useful-what"
              />
            </Field>
            <Field label="Its link" htmlFor="pb-useful-link" error={issueAt('usefulLink')}>
              <Input
                id="pb-useful-link"
                value={draft.usefulLink}
                placeholder="https://"
                inputMode="url"
                maxLength={PLAYBOOK_LIMITS.usefulLink}
                onChange={(e) => set('usefulLink', e.target.value)}
                onBlur={() => set('usefulLink', withScheme(draft.usefulLink))}
                data-testid="playbook-useful-link"
              />
            </Field>
          </div>
        </div>
      );
      break;
    case 'who':
      body = (
        <div className="space-y-5">
          <Field
            label="Who"
            htmlFor="pb-audience"
            hint="In plain words, like “Owners of small businesses that have customers to follow up with”."
            error={issueAt('audience')}
          >
            <Textarea
              id="pb-audience"
              rows={2}
              maxLength={PLAYBOOK_LIMITS.audience}
              value={draft.audience}
              onChange={(e) => set('audience', e.target.value)}
              data-testid="playbook-audience"
            />
          </Field>
          {help('audience')}
          <ListField
            id="pb-signs"
            {...typed('signs')}
            label="Signs someone fits"
            placeholder="Like “Posts about missed calls”"
            items={draft.signs}
            onChange={(v) => set('signs', v)}
            suggestions={[{ label: 'Ideas', options: PLAYBOOK_SUGGESTIONS.signs }]}
            limits={PLAYBOOK_LIMITS.signs}
            error={issueIn('signs')}
          />
          {listHelp('signs')}
          <Field
            label="Where they are (optional)"
            htmlFor="pb-area"
            hint="Towns or a region, when it matters."
            error={issueAt('area')}
          >
            <Input
              id="pb-area"
              value={draft.area}
              maxLength={PLAYBOOK_LIMITS.area}
              onChange={(e) => set('area', e.target.value)}
            />
          </Field>
          {help('area')}
        </div>
      );
      break;
    case 'skip':
      body = (
        <div>
          <ListField
            id="pb-skip"
            {...typed('skip')}
            label="Leave these alone"
            placeholder="Like “People who sell the same thing”"
            items={draft.skip}
            onChange={(v) => set('skip', v)}
            suggestions={[{ label: 'Ideas', options: PLAYBOOK_SUGGESTIONS.skip }]}
            limits={PLAYBOOK_LIMITS.skip}
            error={issueIn('skip')}
          />
          {listHelp('skip')}
        </div>
      );
      break;
    case 'where':
      body = (
        <div className="space-y-5">
          <Callout tone="neutral" icon={Info}>
            On Facebook for now. LinkedIn and Instagram come later.
          </Callout>
          <ListField
            id="pb-groups"
            {...typed('groupWords')}
            label={W.playbookSections.groupWords}
            hint="Like “small business owners”, or your town’s name with what they do."
            items={draft.groupWords}
            onChange={(v) => set('groupWords', v)}
            limits={PLAYBOOK_LIMITS.groupWords}
            error={issueIn('groupWords') ?? issueIn('platforms')}
          />
          {listHelp('groupWords')}
        </div>
      );
      break;
    case 'steps':
      body = (
        <div className="divide-y divide-border rounded-card border border-border bg-card">
          {PLAYBOOK_STEP_KEYS.map((k) => {
            const on = draft.steps.includes(k);
            return (
              <div key={k} className="p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[14px] font-medium">{PLAYBOOK_STEPS[k].label}</div>
                    <div className="text-[13px] text-text-2">{PLAYBOOK_STEPS[k].hint}</div>
                  </div>
                  <Switch
                    checked={on}
                    onChange={(v) =>
                      set('steps', v ? [...draft.steps, k] : draft.steps.filter((s) => s !== k))
                    }
                    label={PLAYBOOK_STEPS[k].label}
                    testId={`step-${k}`}
                  />
                </div>
                {on && k === 'message' ? (
                  <Pace
                    before="First message"
                    value={draft.pace.messageAfterDays}
                    limits={PACE_LIMITS.messageAfterDays}
                    after={(n) =>
                      n === 0
                        ? 'days after they accept: the same day'
                        : `${n === 1 ? 'day' : 'days'} after they accept`
                    }
                    onChange={(n) => set('pace', { ...draft.pace, messageAfterDays: n })}
                    testId="pace-message"
                  />
                ) : null}
                {on && k === 'follow_up' ? (
                  <Pace
                    before="Send"
                    value={paceOf(draft.pace).followUps}
                    limits={PACE_LIMITS.followUps}
                    after={() => 'follow-ups until they answer, then a check-in each month'}
                    onChange={(n) =>
                      set('pace', { ...draft.pace, followUps: n, followUpGaps: followUpGapsFor(n) })
                    }
                    testId="pace-follow-up"
                  />
                ) : null}
              </div>
            );
          })}
          {(issueIn('steps') ?? issueIn('pace')) ? (
            <div className="p-3.5">
              <FieldError>{issueIn('steps') ?? issueIn('pace')}</FieldError>
            </div>
          ) : null}
        </div>
      );
      break;
    case 'tags':
      body = (
        <div>
          <ListField
            id="pb-tags"
            {...typed('tags')}
            label="Tags it may use"
            hint="Taking one out takes it off the answers that add it."
            placeholder="Like “Wants a demo”"
            items={draft.tags}
            onChange={setTags}
            suggestions={[
              { label: 'Your tags', options: businessTags },
              {
                label: 'Ideas',
                options: PLAYBOOK_SUGGESTIONS.tags.filter(
                  (t) => !businessTags.some((b) => b.toLowerCase() === t.toLowerCase()),
                ),
              },
            ]}
            limits={PLAYBOOK_LIMITS.tags}
            error={issueIn('tags')}
            testId="playbook-tags"
          />
          {listHelp('tags')}
        </div>
      );
      break;
    case 'conversation':
      body = (
        <div>
          <Conversation
            questions={draft.questions}
            tags={draft.tags}
            onChange={(questions) => set('questions', questions)}
            // Tags is the step before, so carrying on from it comes straight back here.
            onAddTags={() =>
              go(
                STEPS.findIndex((s) => s.key === 'tags'),
                false,
              )
            }
            issueAt={issueAt}
          />
          <AiHelp
            workspaceId={workspaceId}
            part="questions"
            draft={assistDraft}
            written={draft.questions.length > 0}
            onQuestion={addQuestion}
            className="mt-4"
          />
        </div>
      );
      break;
    case 'voice':
      body = (
        <div className="space-y-6">
          <div>
            <Field
              label="Your tone"
              htmlFor="pb-tone"
              hint="Tap words to add them, or write it your way."
              error={issueAt('tone')}
            >
              <Textarea
                id="pb-tone"
                rows={2}
                maxLength={PLAYBOOK_LIMITS.tone}
                value={draft.tone}
                onChange={(e) => set('tone', e.target.value)}
              />
            </Field>
            <Picks
              options={PLAYBOOK_SUGGESTIONS.tone.filter(
                (t) => !draft.tone.toLowerCase().includes(t.toLowerCase()),
              )}
              onPick={(t) => set('tone', addWords(draft.tone, t))}
            />
            {help('tone')}
          </div>
          <div>
            <MessageList
              label="A few of your own messages (optional)"
              hint="Paste messages you’ve sent, so drafts sound like you."
              name="message"
              items={draft.samples}
              most={PLAYBOOK_LIMITS.samples.most}
              maxLength={PLAYBOOK_LIMITS.samples.line}
              onChange={(v) => set('samples', v)}
              error={issueIn('samples')}
            />
            {listHelp('samples')}
          </div>
          <ListField
            id="pb-avoid"
            {...typed('avoid')}
            label={W.playbookSections.avoid}
            items={draft.avoid}
            onChange={(v) => set('avoid', v)}
            suggestions={[{ label: 'Ideas', options: PLAYBOOK_SUGGESTIONS.avoid }]}
            limits={PLAYBOOK_LIMITS.avoid}
            error={issueIn('avoid')}
          />
          {listHelp('avoid')}
          <Field
            label="Every message must say (optional)"
            htmlFor="pb-disclaimer"
            hint="Only when your business has to, like a license number."
            error={issueAt('disclaimer')}
          >
            <Input
              id="pb-disclaimer"
              value={draft.disclaimer}
              maxLength={PLAYBOOK_LIMITS.disclaimer}
              onChange={(e) => set('disclaimer', e.target.value)}
            />
          </Field>
          {help('disclaimer')}
        </div>
      );
      break;
    case 'openers':
      body = (
        <div className="space-y-6">
          <div>
            <ListField
              id="pb-opener-styles"
              {...typed('openerStyles')}
              label={W.openerStyles}
              hint="Two or three different ones, so you can see which works. Each is how a first message starts."
              placeholder="Like “Ask about something real on their profile”"
              items={draft.openerStyles}
              onChange={(v) => set('openerStyles', v)}
              suggestions={[{ label: 'Ideas', options: PLAYBOOK_SUGGESTIONS.openerStyles }]}
              limits={PLAYBOOK_LIMITS.openerStyles}
              error={issueIn('openerStyles')}
              testId="playbook-opener-styles"
            />
            {listHelp('openerStyles')}
          </div>
          <div>
            <MessageList
              label="Your own openers (optional)"
              hint={`Sent as you write them. Put ${FIRST_NAME} where their first name goes.`}
              name="opener"
              items={draft.ownOpeners}
              most={PLAYBOOK_LIMITS.ownOpeners.most}
              maxLength={PLAYBOOK_LIMITS.ownOpeners.line}
              onChange={(v) => set('ownOpeners', v)}
              error={issueIn('ownOpeners')}
              placeholder={`Hi ${FIRST_NAME}! …`}
              testId="playbook-own-openers"
            />
            {listHelp('ownOpeners')}
          </div>
          {draft.openerStyles.length + draft.ownOpeners.filter((m) => m.trim()).length === 0 ? (
            <Callout tone="neutral" icon={Info}>
              With none, first messages are written as before, and there’s nothing to compare.
            </Callout>
          ) : null}
        </div>
      );
      break;
    case 'review':
      body = (
        <div className="space-y-5">
          <Field label={W.name} htmlFor="pb-name" hint="Only your team sees it." error={nameIssue}>
            <Input
              id="pb-name"
              value={draft.name}
              maxLength={PLAYBOOK_LIMITS.name}
              onChange={(e) => {
                setTaken(null);
                set('name', e.target.value);
              }}
              data-testid="playbook-name"
            />
          </Field>
          {issues.length ? (
            <Callout tone="danger">
              Some parts need a fix before it’s saved. Press Change beside each one marked in red.
            </Callout>
          ) : null}
          <div className="divide-y divide-border rounded-card border border-border bg-card">
            {STEPS.slice(0, REVIEW).map((s, i) => {
              const wrong = problems(s)[0]?.message;
              return (
                <section
                  key={s.key}
                  className="flex items-start justify-between gap-4 p-4"
                  data-testid={`review-${s.key}`}
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-text-3">
                      {s.part}
                    </h3>
                    <div className="mt-1 text-[14px]">
                      <Summary part={s.key} draft={draft} />
                    </div>
                    {wrong ? (
                      <p className="mt-1.5 text-[13px] text-danger-text" role="alert">
                        {wrong}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="flex-none text-[13px] text-accent-text hover:underline"
                    onClick={() => go(i, true)}
                    aria-label={`Change ${s.part.toLowerCase()}`}
                    data-testid={`review-change-${s.key}`}
                  >
                    Change
                  </button>
                </section>
              );
            })}
          </div>
        </div>
      );
      break;
  }

  return (
    <div ref={top} className="scroll-mt-6" data-testid="playbook-builder">
      <Link
        href={home}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-accent-text hover:underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
        Social Outreach
      </Link>
      <PageHeader
        title={playbook ? `Change ${playbook.name}` : 'New playbook'}
        description="The extension and the AI follow it: who to look for, how to sound, and which of your tags to use."
      />
      <div className="mx-auto max-w-[760px]" data-testid={`playbook-step-${step.key}`}>
        <Progress current={at} total={STEPS.length} />
        <h2 className="text-[19px] font-semibold">{step.title}</h2>
        <p className="mb-5 mt-1 text-[13.5px] text-text-2">{step.blurb}</p>
        {body}
        <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-5">
          {at === 0 ? (
            <Link href={home} className={buttonClassName({ variant: 'secondary' })}>
              Cancel
            </Link>
          ) : (
            <Button variant="secondary" onClick={() => go(at - 1, fromReview)} disabled={busy}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          )}
          {at === REVIEW ? (
            <Button
              onClick={() => void save()}
              loading={busy}
              disabled={issues.length > 0 || nameIssue !== null}
              data-testid="playbook-save"
            >
              {playbook ? 'Save changes' : 'Make the playbook'}
            </Button>
          ) : (
            <Button
              onClick={() => go(fromReview ? REVIEW : at + 1, fromReview)}
              disabled={stuck.length > 0}
              data-testid="playbook-next"
            >
              {fromReview ? 'Back to the summary' : 'Continue'}
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
        {at < REVIEW && stuck.length > 0 ? (
          <p className="mt-2 text-right text-[13px] text-text-3">Fix the above to carry on.</p>
        ) : null}
      </div>
    </div>
  );
}

// ---------- the conversation ----------

function Conversation({
  questions,
  tags,
  onChange,
  onAddTags,
  issueAt,
}: {
  questions: PlaybookQuestion[];
  tags: readonly string[];
  onChange: (questions: PlaybookQuestion[]) => void;
  onAddTags: () => void;
  issueAt: (path: string) => string | undefined;
}) {
  const move = (i: number, by: -1 | 1) => {
    const next = [...questions];
    const [q] = next.splice(i, 1);
    next.splice(i + by, 0, q!);
    onChange(next);
  };
  // Answers that led to a question taken out carry on to the next one instead.
  const remove = (i: number) => {
    const gone = questions[i]!.id;
    onChange(
      questions
        .filter((_, j) => j !== i)
        .map((q) => ({
          ...q,
          answers: q.answers.map((a) => (a.next === gone ? { ...a, next: 'continue' } : a)),
        })),
    );
  };
  return (
    <div className="space-y-4">
      {tags.length === 0 ? (
        <Callout
          tone="info"
          action={
            <Button variant="secondary" size="sm" onClick={onAddTags}>
              Add tags
            </Button>
          }
        >
          There are no tags yet, so answers can’t tag anyone.
        </Callout>
      ) : null}
      {questions.length === 0 ? (
        <Callout tone="neutral" icon={MessageCircleQuestion}>
          No questions yet. Add the first thing you’d ask, like “Do you use a CRM?”.
        </Callout>
      ) : null}
      {questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          question={q}
          at={i}
          questions={questions}
          tags={tags}
          onChange={(changed) => onChange(questions.map((x, j) => (j === i ? changed : x)))}
          onMove={(by) => move(i, by)}
          onRemove={() => remove(i)}
          issueAt={issueAt}
        />
      ))}
      {questions.length < PLAYBOOK_LIMITS.questions.most ? (
        <Button
          variant="secondary"
          onClick={() =>
            onChange([...questions, { id: nextQuestionId(questions), text: '', answers: [] }])
          }
          data-testid="question-add"
        >
          <Plus className="h-4 w-4" />
          {W.addQuestion}
        </Button>
      ) : (
        <p className="text-[13px] text-text-3">
          That’s {PLAYBOOK_LIMITS.questions.most} questions, the most a playbook takes.
        </p>
      )}
    </div>
  );
}

function QuestionCard({
  question: q,
  at,
  questions,
  tags,
  onChange,
  onMove,
  onRemove,
  issueAt,
}: {
  question: PlaybookQuestion;
  at: number;
  questions: readonly PlaybookQuestion[];
  tags: readonly string[];
  onChange: (q: PlaybookQuestion) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  issueAt: (path: string) => string | undefined;
}) {
  const p = `questions.${at}`;
  const n = at + 1;
  const setAnswer = (j: number, a: PlaybookAnswer) =>
    onChange({ ...q, answers: q.answers.map((x, k) => (k === j ? a : x)) });
  const addAnswer = (label: string) =>
    onChange({ ...q, answers: [...q.answers, { label, tag: null, next: 'continue' }] });
  const used = new Set(q.answers.map((a) => a.label.trim().toLowerCase()));
  /** Where an answer can lead: the next question, one further down, the offer, later, or nowhere. */
  const nexts = (current: string): [string, string][] => {
    const list: [string, string][] = [['continue', leadsTo('continue', at, questions)]];
    // The very next question is "Ask the next question" already.
    questions.forEach((x, j) => {
      if (j > at + 1 || (x.id === current && j === at + 1))
        list.push([x.id, leadsTo(x.id, at, questions)]);
    });
    list.push(
      ['offer', ANSWER_NEXTS.offer],
      ['later', ANSWER_NEXTS.later],
      ['stop', ANSWER_NEXTS.stop],
    );
    // One that can't stay (a question above, or gone) still shows, with its problem under it.
    if (!list.some(([v]) => v === current)) list.push([current, leadsTo(current, at, questions)]);
    return list;
  };
  /** The playbook's own spelling of an answer's tag, which is matched whatever its capitals. */
  const tagValue = (tag: string | null) =>
    tag === null ? '' : (tags.find((t) => t.toLowerCase() === tag.toLowerCase()) ?? tag);

  return (
    <div className="rounded-card border border-border bg-card p-4" data-testid={`question-${n}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label htmlFor={`pb-q${n}`} className="mb-0">
          Question {n}
        </Label>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Move question ${n} up`}
            disabled={at === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Move question ${n} down`}
            disabled={at === questions.length - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Take out question ${n}`}
            onClick={onRemove}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <Input
        id={`pb-q${n}`}
        value={q.text}
        maxLength={PLAYBOOK_LIMITS.questions.line}
        placeholder="Like “Do you use a CRM?”"
        invalid={!!issueAt(`${p}.text`)}
        onChange={(e) => onChange({ ...q, text: e.target.value })}
        data-testid={`question-${n}-text`}
      />
      <FieldError>{issueAt(`${p}.text`) ?? issueAt(`${p}.id`)}</FieldError>

      <div className="mt-4 text-[13px] font-medium">Answers people give</div>
      {q.answers.length === 0 ? (
        <Hint className="mt-1">
          None: they answer in their own words, and the chat carries on to the next question.
        </Hint>
      ) : (
        <div className="mt-2 space-y-4 sm:space-y-2">
          <div className={cn(ANSWER_ROW, 'hidden text-[12px] text-text-3 sm:grid')} aria-hidden>
            <span>{W.theySay}</span>
            <span>{W.addsTag}</span>
            <span>{W.leadsTo}</span>
          </div>
          {q.answers.map((a, j) => {
            const wrong =
              issueAt(`${p}.answers.${j}.label`) ??
              issueAt(`${p}.answers.${j}.tag`) ??
              issueAt(`${p}.answers.${j}.next`);
            const tag = tagValue(a.tag);
            return (
              <div key={j} data-testid={`question-${n}-answer-${j + 1}`}>
                <div className={ANSWER_ROW}>
                  <Input
                    aria-label={`Answer ${j + 1} to question ${n}`}
                    value={a.label}
                    maxLength={PLAYBOOK_LIMITS.answers.line}
                    placeholder="What they might say"
                    invalid={!!issueAt(`${p}.answers.${j}.label`)}
                    onChange={(e) => setAnswer(j, { ...a, label: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="justify-self-end sm:order-last"
                    aria-label={`Take out answer ${j + 1} to question ${n}`}
                    onClick={() => onChange({ ...q, answers: q.answers.filter((_, k) => k !== j) })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                  <Select
                    aria-label={`Tag for answer ${j + 1} to question ${n}`}
                    className="col-span-2 sm:col-span-1"
                    value={tag}
                    onChange={(e) => setAnswer(j, { ...a, tag: e.target.value || null })}
                  >
                    <option value="">{W.noTag}</option>
                    {tags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                    {tag && !tags.includes(tag) ? <option value={tag}>{tag}</option> : null}
                  </Select>
                  <Select
                    aria-label={`After answer ${j + 1} to question ${n}`}
                    className="col-span-2 sm:col-span-1"
                    value={a.next}
                    onChange={(e) => setAnswer(j, { ...a, next: e.target.value })}
                  >
                    {nexts(a.next).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
                <FieldError>{wrong}</FieldError>
              </div>
            );
          })}
        </div>
      )}
      <FieldError>{issueAt(`${p}.answers`)}</FieldError>
      {q.answers.length < PLAYBOOK_LIMITS.answers.most ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => addAnswer('')}
            data-testid={`question-${n}-add-answer`}
          >
            <Plus className="h-3.5 w-3.5" />
            {W.addAnswer}
          </Button>
          <Picks
            className="mt-0"
            options={PLAYBOOK_SUGGESTIONS.answers.filter((s) => !used.has(s.toLowerCase()))}
            onPick={addAnswer}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The conversation as it reads: each question, and where each answer leads. */
function Script({ questions }: { questions: readonly PlaybookQuestion[] }) {
  if (!questions.length) return <span className="text-text-3">No questions yet.</span>;
  return (
    <ol className="space-y-2.5">
      {questions.map((q, i) => (
        <li key={q.id}>
          <div className="font-medium">
            {i + 1}. {q.text.trim() || 'A question with no words yet'}
          </div>
          {q.answers.length ? (
            <ul className="mt-1 space-y-1 pl-4 text-[13px] text-text-2">
              {q.answers.map((a, j) => (
                <li key={j}>
                  “{a.label.trim() || '…'}”
                  {a.tag ? (
                    <>
                      {' '}
                      adds <Badge variant="accent">{a.tag}</Badge>
                    </>
                  ) : null}
                  , then {lower(leadsTo(a.next, i, questions, true))}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 pl-4 text-[13px] text-text-3">They answer in their own words.</p>
          )}
        </li>
      ))}
    </ol>
  );
}

// ---------- the summary ----------

const Missing = ({ children }: { children: ReactNode }) => (
  <span className="text-text-3">{children}</span>
);

function Summary({ part, draft: d }: { part: StepKey; draft: Draft }): ReactNode {
  const listed = (items: readonly string[], none: string) =>
    items.length ? items.join(' · ') : <Missing>{none}</Missing>;
  switch (part) {
    case 'goal':
      return PLAYBOOK_GOALS[d.goal];
    case 'niche':
      return (
        <>
          {d.niche.trim() || <Missing>No niche yet</Missing>}
          {d.problem.trim() ? (
            <div className="text-[13px] text-text-2">Their problem: {d.problem.trim()}</div>
          ) : null}
          {d.proof.length ? (
            <div className="text-[13px] text-text-2">
              {plural(d.proof.length, 'result')} as proof
            </div>
          ) : null}
        </>
      );
    case 'offer':
      return (
        <>
          {d.offer.trim() || <Missing>No offer written yet</Missing>}
          {d.link.trim() ? (
            <div className="truncate text-[13px] text-text-2">{d.link.trim()}</div>
          ) : null}
          {d.usefulWhat.trim() ? (
            <div className="text-[13px] text-text-2">Useful to send: {d.usefulWhat.trim()}</div>
          ) : null}
        </>
      );
    case 'who':
      return (
        <>
          {d.audience.trim() || <Missing>Nobody described yet</Missing>}
          {d.signs.length ? (
            <div className="text-[13px] text-text-2">Signs: {d.signs.join(' · ')}</div>
          ) : null}
          {d.area.trim() ? <div className="text-[13px] text-text-2">In {d.area.trim()}</div> : null}
        </>
      );
    case 'skip':
      return listed(d.skip, 'Nobody yet');
    case 'where':
      return (
        <>
          Facebook
          {d.groupWords.length ? (
            <div className="text-[13px] text-text-2">Groups about {d.groupWords.join(' · ')}</div>
          ) : null}
        </>
      );
    case 'steps': {
      const steps = PLAYBOOK_STEP_KEYS.filter((s) => d.steps.includes(s));
      if (!steps.length) return <Missing>No steps picked</Missing>;
      const pace = W.pace(
        steps.includes('message') ? d.pace.messageAfterDays : null,
        steps.includes('follow_up') ? paceOf(d.pace).followUps : null,
      );
      return (
        <>
          {steps.map((s) => PLAYBOOK_STEPS[s].label).join(' → ')}
          {pace ? <div className="text-[13px] text-text-2">{pace}</div> : null}
        </>
      );
    }
    case 'tags':
      return d.tags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {d.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      ) : (
        <Missing>No tags, so nobody gets tagged</Missing>
      );
    case 'conversation':
      return <Script questions={d.questions} />;
    case 'voice': {
      const samples = d.samples.filter((s) => s.trim()).length;
      return (
        <>
          {d.tone.trim() || <Missing>No tone written yet</Missing>}
          <div className="text-[13px] text-text-2">
            {samples
              ? `${plural(samples, 'message')} of yours to sound like`
              : 'None of your messages yet'}
            {d.avoid.length ? `. Never says ${d.avoid.join(', ')}` : ''}
            {d.disclaimer.trim() ? `. Always says “${short(d.disclaimer.trim(), 80)}”` : ''}
          </div>
        </>
      );
    }
    case 'openers': {
      const own = d.ownOpeners.filter((s) => s.trim());
      if (!d.openerStyles.length && !own.length)
        return <Missing>None, so first messages aren’t compared</Missing>;
      return (
        <>
          {d.openerStyles.length ? (
            <ul className="space-y-0.5">
              {d.openerStyles.map((o) => (
                <li key={o}>{short(o, 90)}</li>
              ))}
            </ul>
          ) : null}
          {own.length ? (
            <div className="text-[13px] text-text-2">
              {plural(own.length, 'opener')} of your own:{' '}
              {own.map((o) => `“${short(o.trim(), 40)}”`).join(' · ')}
            </div>
          ) : null}
        </>
      );
    }
    case 'review':
      return null;
  }
}

// ---------- small pieces ----------

function Progress({ current, total }: { current: number; total: number }) {
  const done = ((current + 1) / total) * 100;
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between text-[13px] text-text-2">
        <span>
          Step {current + 1} of {total}
        </span>
        <span>{Math.round(done)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-card-2">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${done}%` }}
        />
      </div>
    </div>
  );
}

/** A number of days, with what it means beside it. */
function Pace({
  before,
  after,
  value,
  limits,
  onChange,
  testId,
}: {
  before: string;
  after: (n: number) => string;
  value: number;
  limits: { readonly min: number; readonly max: number };
  onChange: (n: number) => void;
  testId: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
      <span>{before}</span>
      <Stepper
        value={value}
        onChange={onChange}
        min={limits.min}
        max={limits.max}
        label={`${before}, in days`}
        testId={testId}
      />
      <span>{after(value)}</span>
    </div>
  );
}

/** Words to tap instead of type. */
function Picks({
  label,
  options,
  on,
  onPick,
  className,
}: {
  label?: string;
  options: readonly string[];
  /** Which one is in use, for choices that replace what's there. */
  on?: (option: string) => boolean;
  onPick: (option: string) => void;
  className?: string;
}) {
  if (!options.length) return null;
  return (
    <div className={cn('mt-2 flex flex-wrap items-center gap-1.5', className)}>
      {label ? <span className="mr-0.5 text-[12.5px] text-text-3">{label}</span> : null}
      {options.map((o) => {
        const pressed = on?.(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on ? pressed : undefined}
            onClick={() => onPick(o)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12.5px]',
              pressed
                ? 'border-accent-soft bg-accent-soft text-accent-text'
                : 'border-dashed border-border-strong text-text-2 hover:bg-card-2 hover:text-text',
            )}
          >
            {on ? null : <Plus className="h-3 w-3" aria-hidden />}
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Whole messages, each in its own box, with Add. */
function MessageList({
  label,
  hint,
  name,
  items,
  most,
  maxLength,
  onChange,
  error,
  placeholder,
  testId,
}: {
  label: string;
  hint: string;
  /** What one is called: "message", "opener". */
  name: string;
  items: string[];
  most: number;
  maxLength: number;
  onChange: (items: string[]) => void;
  error?: string;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <Label>{label}</Label>
      <p className="-mt-0.5 mb-2 text-[12.5px] text-text-3">{hint}</p>
      <div className="space-y-2">
        {items.map((s, i) => (
          <div key={i} className="flex items-start gap-2">
            <Textarea
              aria-label={`Your ${name} ${i + 1}`}
              rows={3}
              maxLength={maxLength}
              value={s}
              placeholder={placeholder}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Take out ${name} ${i + 1}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      {items.length < most ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => onChange([...items, ''])}
        >
          <Plus className="h-3.5 w-3.5" />
          Add {name === 'opener' ? 'an opener' : `a ${name}`}
        </Button>
      ) : null}
      <FieldError>{error}</FieldError>
    </div>
  );
}

/** A list of short lines: each a chip to take out, a box to add one, and ideas to tap. */
function ListField({
  id,
  label,
  hint,
  placeholder,
  items,
  onChange,
  suggestions = [],
  limits: { line: maxLength, most: max },
  text,
  onText,
  error,
  testId,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  items: string[];
  onChange: (items: string[]) => void;
  suggestions?: readonly { readonly label: string; readonly options: readonly string[] }[];
  /** The most characters a line takes, and how many lines. */
  limits: { readonly line: number; readonly most: number };
  /** What's typed in its box and not added yet, which the builder keeps: it counts as added. */
  text: string;
  onText: (text: string) => void;
  error?: string;
  testId?: string;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const has = (v: string) => items.some((x) => x.toLowerCase() === v.toLowerCase());
  const full = items.length >= max;
  const add = (v: string) => {
    const t = v.trim();
    if (!t) return;
    if (has(t)) return setSaid(`“${t}” is there already.`);
    if (full) return setSaid(`That’s ${max}, the most it takes.`);
    onChange([...items, t]);
    onText('');
    setSaid(null);
  };
  return (
    <div data-testid={testId}>
      <Label htmlFor={id}>{label}</Label>
      {items.length ? (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <li
              key={`${i}-${item}`}
              className="inline-flex min-h-7 items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-[13px] text-accent-text"
            >
              {item}
              <button
                type="button"
                aria-label={`Take out “${item}”`}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full hover:bg-card"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={id}
          value={full ? '' : text}
          maxLength={maxLength}
          disabled={full}
          placeholder={full ? `That’s ${max}, the most it takes.` : placeholder}
          onChange={(e) => {
            onText(e.target.value);
            setSaid(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            }
          }}
        />
        <Button variant="secondary" onClick={() => add(text)} disabled={full || !text.trim()}>
          Add
        </Button>
      </div>
      {said || error ? <FieldError>{said ?? error}</FieldError> : hint ? <Hint>{hint}</Hint> : null}
      {full
        ? null
        : suggestions.map((g) => (
            <Picks
              key={g.label}
              label={g.label}
              options={g.options.filter((o) => !has(o))}
              onPick={add}
            />
          ))}
    </div>
  );
}
