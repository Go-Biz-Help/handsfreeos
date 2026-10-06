'use client';
/**
 * Quick setup's question screens, 1 to 11 (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4). Each only shows
 * and changes answers; the frame around them (components/ai-setup/quick-setup.tsx) checks, keeps and saves them.
 */
import {
  AI_SETUP_ANSWER_WHEN_LABELS,
  AI_SETUP_CHAT_LABELS,
  AI_SETUP_DISCLOSURE_LABELS,
  AI_SETUP_FIELD_WORDS as W,
  AI_SETUP_JOB_LABELS,
  AI_SETUP_PRICE_LABELS,
  AI_SETUP_TONE_LABELS,
  AI_SETUP_TONE_TEXTS,
  aiSetupProblemAt,
  firstTextPreview,
  HOURS_MODES,
  quickFactsFor,
  SETUP_JOBS,
  SETUP_TONES,
  setupFor,
  toneOfProfile,
  withAiName,
  type AiSetupAnswers,
  type AiSetupBusinessDraft,
  type AiSetupFinding,
  type AiSetupProblems,
  type AiSetupState,
  type AiSetupStep,
  type AiSetupTone,
} from '@hfos/core';
import { AlertTriangle, Check, FileUp, Info, Loader2, Smartphone } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Callout, Note } from '@/components/ai-team/parts';
import { WeeklyHoursEditor } from '@/components/calendars/weekly-hours';
import { PhoneAppDialog } from '@/components/home/phone-app-dialog';
import { IndustryPicker } from '@/components/settings/industry-picker';
import { MyCellSection } from '@/components/settings/my-cell-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldError, Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AiSetupData } from '@/lib/ai-setup/data';
import { errorMessage } from '@/lib/api/client';
import { DOCUMENT_ACCEPT, uploadKnowledgeDocument } from '@/lib/knowledge/upload';
import {
  Option,
  Pills,
  QualifyField,
  ServicesField,
  Tick,
  TopQuestionsField,
  WebsiteField,
  YesNo,
} from './fields';

export interface ScreenProps {
  readonly step: Exclude<AiSetupStep, 'try'>;
  readonly state: AiSetupState;
  readonly answers: AiSetupAnswers;
  readonly set: <K extends keyof AiSetupAnswers>(key: K, value: AiSetupAnswers[K]) => void;
  readonly problems: AiSetupProblems;
  readonly business: AiSetupBusinessDraft;
  readonly setBusiness: (patch: Partial<AiSetupBusinessDraft>) => void;
  readonly findings: readonly AiSetupFinding[];
  readonly data: AiSetupData;
}

export function AiSetupScreen(props: ScreenProps) {
  switch (props.step) {
    case 'business':
      return <BusinessScreen {...props} />;
    case 'jobs':
      return <JobsScreen {...props} />;
    case 'about':
      return <AboutScreen {...props} />;
    case 'hours':
      return <HoursScreen {...props} />;
    case 'facts':
      return <FactsScreen {...props} />;
    case 'meet':
      return <MeetScreen {...props} />;
    case 'voice':
      return <VoiceScreen {...props} />;
    case 'learned':
      return <LearnedScreen {...props} />;
    case 'qualify':
      return (
        <QualifyField
          questions={props.answers.questions}
          industry={props.state.industry}
          onChange={(next) => props.set('questions', next)}
          problems={props.problems}
        />
      );
    case 'loop':
      return <LoopScreen {...props} />;
    case 'chat':
      return <ChatScreen {...props} />;
  }
}

/** The teammate's name, for the words. */
const nameOf = (answers: AiSetupAnswers) => answers.name.trim() || 'Ava';

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {children}
    </div>
  );
}

function BusinessScreen({ answers, business, setBusiness, problems }: ScreenProps) {
  const name = nameOf(answers);
  return (
    <>
      <Field
        label={W.businessName}
        htmlFor="ai-setup-business-name"
        error={problems['business.name']}
      >
        <Input
          id="ai-setup-business-name"
          inputSize="lg"
          value={business.name}
          maxLength={120}
          invalid={!!problems['business.name']}
          onChange={(e) => setBusiness({ name: e.target.value })}
          data-testid="ai-setup-business-name"
        />
      </Field>
      <div>
        <Label htmlFor="ai-setup-kind">{W.kind}</Label>
        <IndustryPicker
          id="ai-setup-kind"
          inputSize="lg"
          value={business.industry}
          onChange={(industry) => setBusiness({ industry })}
        />
        {problems['business.industry'] ? (
          <FieldError>{problems['business.industry']}</FieldError>
        ) : (
          <Hint>{W.kindHint}</Hint>
        )}
      </div>
      <WebsiteField
        value={business.site}
        noSite={business.noSite}
        onChange={(site) => setBusiness({ site })}
        onNoSite={(noSite) => setBusiness({ noSite })}
        hint={withAiName(business.noSite ? W.noWebsiteHint : W.websiteHint, name)}
        error={problems['business.website']}
      />
    </>
  );
}

function JobsScreen({ answers, set, problems }: ScreenProps) {
  const toggle = (job: (typeof SETUP_JOBS)[number]) => {
    const on = new Set(answers.jobs);
    if (on.has(job)) on.delete(job);
    else on.add(job);
    set(
      'jobs',
      SETUP_JOBS.filter((j) => on.has(j)),
    );
  };
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Jobs">
      {SETUP_JOBS.map((job) => (
        <Tick
          key={job}
          on={answers.jobs.includes(job)}
          onToggle={() => toggle(job)}
          title={AI_SETUP_JOB_LABELS[job]}
          testId={`ai-setup-job-${job}`}
        />
      ))}
      <FieldError>{aiSetupProblemAt(problems, 'jobs')}</FieldError>
    </div>
  );
}

/** While Ava reads the website for these screens. */
function Reading({ state, answers }: Pick<ScreenProps, 'state' | 'answers'>) {
  if (!state.reading) return null;
  return (
    <div
      className="flex items-center gap-2.5 rounded-menu bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-text"
      data-testid="ai-setup-reading"
    >
      <Loader2 className="h-4 w-4 flex-none animate-spin" strokeWidth={2} />
      {withAiName(W.reading, nameOf(answers))}
    </div>
  );
}

function AboutScreen(props: ScreenProps) {
  const { state, answers, set, problems } = props;
  const { area } = setupFor(state.industry);
  return (
    <>
      <Reading state={state} answers={answers} />
      <Field label={W.description} htmlFor="ai-setup-description" error={problems['description']}>
        <Textarea
          id="ai-setup-description"
          value={answers.description}
          maxLength={2000}
          invalid={!!problems['description']}
          onChange={(e) => set('description', e.target.value)}
          data-testid="ai-setup-description"
        />
      </Field>
      <ServicesField
        services={answers.services}
        onChange={(next) => set('services', next)}
        problems={problems}
      />
      <Field label={area.question} htmlFor="ai-setup-area" error={problems['area']}>
        <Input
          id="ai-setup-area"
          value={answers.area}
          maxLength={500}
          placeholder={area.example}
          invalid={!!problems['area']}
          onChange={(e) => set('area', e.target.value)}
          data-testid="ai-setup-area"
        />
      </Field>
    </>
  );
}

function HoursScreen({ state, answers, set, problems }: ScreenProps) {
  const name = nameOf(answers);
  return (
    <>
      <Reading state={state} answers={answers} />
      <div>
        <Label>{W.openHours}</Label>
        <WeeklyHoursEditor
          value={answers.openHours}
          onChange={(next) => set('openHours', next)}
          idPrefix="ai-setup-open"
        />
        <FieldError>{aiSetupProblemAt(problems, 'openHours')}</FieldError>
      </div>
      <div>
        <Label>{withAiName(W.answerWhen, name)}</Label>
        <Group label={withAiName(W.answerWhen, name)}>
          {HOURS_MODES.map((mode) => (
            <Option
              key={mode}
              on={answers.answerWhen === mode}
              onSelect={() => set('answerWhen', mode)}
              title={AI_SETUP_ANSWER_WHEN_LABELS[mode]}
              testId={`ai-setup-answer-${mode}`}
            />
          ))}
        </Group>
      </div>
      {answers.answerWhen === 'custom' ? (
        <div>
          <Label>{withAiName(W.customHours, name)}</Label>
          <WeeklyHoursEditor
            value={answers.customHours}
            onChange={(next) => set('customHours', next)}
            idPrefix="ai-setup-custom"
          />
          <FieldError>{aiSetupProblemAt(problems, 'customHours')}</FieldError>
        </div>
      ) : null}
    </>
  );
}

function FactsScreen({ state, answers, set }: ScreenProps) {
  const facts = quickFactsFor(state.industry);
  /** What the website says, shown while the answer is still the website's. */
  const site = state.found?.facts ?? {};
  return (
    <div data-testid="ai-setup-facts">
      <Reading state={state} answers={answers} />
      {facts.map((f) => (
        <YesNo
          key={f.key}
          question={f.question}
          value={answers.facts[f.key]}
          onChange={(v) => {
            const next = { ...answers.facts };
            if (v) next[f.key] = v;
            else delete next[f.key];
            set('facts', next);
          }}
          testId={`ai-setup-fact-${f.key}`}
          note={site[f.key] && site[f.key] === answers.facts[f.key] ? W.fromWebsite : null}
        />
      ))}
    </div>
  );
}

function MeetScreen({ state, answers, set, problems }: ScreenProps) {
  const name = nameOf(answers);
  return (
    <>
      <Field label={W.name} htmlFor="ai-setup-name" error={problems['name']}>
        <Input
          id="ai-setup-name"
          inputSize="lg"
          value={answers.name}
          maxLength={40}
          invalid={!!problems['name']}
          onChange={(e) => set('name', e.target.value)}
          data-testid="ai-setup-name"
        />
      </Field>
      <div>
        <Label>{withAiName(W.disclosure, name)}</Label>
        <Group label={withAiName(W.disclosure, name)}>
          <Option
            on={answers.disclosure === 'first_message'}
            onSelect={() => set('disclosure', 'first_message')}
            title={AI_SETUP_DISCLOSURE_LABELS.first_message}
            badge={
              <Badge variant="ok" className="h-5 text-[11.5px]">
                {W.disclosureRecommended}
              </Badge>
            }
            description={`“${firstTextPreview(name, 'first_message', state.businessName)}”`}
            testId="ai-setup-disclosure-first_message"
          />
          <Option
            on={answers.disclosure === 'when_asked'}
            onSelect={() => set('disclosure', 'when_asked')}
            title={AI_SETUP_DISCLOSURE_LABELS.when_asked}
            description={W.disclosureWhenAsked}
            testId="ai-setup-disclosure-when_asked"
          />
        </Group>
        {answers.disclosure === 'when_asked' ? (
          <Callout tone="warning" icon={AlertTriangle} className="mt-3">
            {W.disclosureCalifornia}
          </Callout>
        ) : null}
      </div>
    </>
  );
}

function VoiceScreen({ state, answers, set }: ScreenProps) {
  const name = nameOf(answers);
  // "Keep what I wrote" only when a person wrote their own tone in Knowledge.
  const own = toneOfProfile(state.profile.tone, state.kind) === 'keep';
  const tones: AiSetupTone[] = [...SETUP_TONES, ...(own ? (['keep'] as const) : [])];
  return (
    <>
      <div>
        <Label>{withAiName(W.tone, name)}</Label>
        <Group label={withAiName(W.tone, name)}>
          {tones.map((tone) => (
            <Option
              key={tone}
              on={answers.tone === tone}
              onSelect={() => set('tone', tone)}
              title={AI_SETUP_TONE_LABELS[tone]}
              description={
                tone === 'keep'
                  ? `“${state.profile.tone.trim().slice(0, 140)}” ${W.keepTone}`
                  : AI_SETUP_TONE_TEXTS[tone]
              }
              testId={`ai-setup-tone-${tone}`}
            />
          ))}
        </Group>
      </div>
      <div>
        <Pills
          name="prices"
          legend={withAiName(W.prices, name)}
          options={['no', 'yes'] as const}
          labels={AI_SETUP_PRICE_LABELS}
          value={answers.allowPrices ? 'yes' : 'no'}
          onChange={(v) => set('allowPrices', v === 'yes')}
        />
        <Hint>{W.pricesHint}</Hint>
      </div>
    </>
  );
}

function LearnedScreen({ state, answers, set, problems, findings, data }: ScreenProps) {
  const name = nameOf(answers);
  const dropped = new Set(answers.dropFindings);
  const toggle = (id: string) =>
    set(
      'dropFindings',
      dropped.has(id)
        ? answers.dropFindings.filter((x) => x !== id)
        : [...answers.dropFindings, id],
    );
  const scan = state.scan.state;
  return (
    <>
      {state.website ? (
        <section className="flex flex-col gap-2" data-testid="ai-setup-findings">
          {findings.length ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium">
                  {W.findings} · {findings.length}
                </span>
                {dropped.size ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => set('dropFindings', [])}
                    data-testid="ai-setup-keep-all"
                  >
                    {W.keepAll}
                  </Button>
                ) : null}
              </div>
              <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                {findings.map((f) => (
                  <Tick
                    key={f.id}
                    on={!dropped.has(f.id)}
                    onToggle={() => toggle(f.id)}
                    title={f.title}
                    description={f.body}
                    testId={`ai-setup-finding-${f.id}`}
                  />
                ))}
              </div>
            </>
          ) : null}
          {scan === 'running' ? (
            <Note icon={Loader2}>{withAiName(W.findingsWaiting, name)}</Note>
          ) : scan === 'failed' ? (
            <Note>{withAiName(W.findingsFailed, name)}</Note>
          ) : !findings.length ? (
            <Note>{withAiName(W.findingsNone, name)}</Note>
          ) : null}
        </section>
      ) : (
        <p className="text-text-2">{W.learnedNoWebsite}</p>
      )}
      <TopQuestionsField
        value={answers.topQuestions}
        onChange={(next) => set('topQuestions', next)}
        problems={problems}
      />
      <PdfUpload workspaceId={data.workspaceId} />
    </>
  );
}

/** "Add a PDF": it goes into Knowledge straight away, as a draft for the owner to check. */
function PdfUpload({ workspaceId }: { workspaceId: string }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          loading={busy}
          onClick={() => input.current?.click()}
          data-testid="ai-setup-pdf"
        >
          <FileUp className="h-4 w-4" strokeWidth={1.75} />
          {W.pdf}
        </Button>
        <span className="text-[12.5px] text-text-3">{W.pdfHint}</span>
      </div>
      <input
        ref={input}
        type="file"
        accept={DOCUMENT_ACCEPT}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            await uploadKnowledgeDocument(workspaceId, file);
            setAdded((a) => [...a, file.name]);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      {added.map((file) => (
        <p key={file} className="mt-2 flex items-center gap-2 text-[13px] text-success-text">
          <Check className="h-4 w-4 flex-none" strokeWidth={2} />
          {W.pdfAdded(file)}
        </p>
      ))}
      <FieldError>{error}</FieldError>
    </div>
  );
}

function LoopScreen({ state, answers, data }: ScreenProps) {
  const [app, setApp] = useState(false);
  const name = nameOf(answers);
  return (
    <>
      <section className="flex flex-col gap-2 rounded-menu border border-border p-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <Smartphone className="h-4 w-4" strokeWidth={1.75} />
          {W.appTitle}
        </h3>
        {data.appOnPhone ? (
          <p
            className="flex items-center gap-2 text-[13.5px] text-success-text"
            data-testid="ai-setup-app-on"
          >
            <Check className="h-4 w-4 flex-none" strokeWidth={2} />
            {W.appOn}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-[13.5px] text-text-2">{W.appWhy}</span>
            <Button variant="secondary" onClick={() => setApp(true)} data-testid="ai-setup-app">
              {W.appTitle}
            </Button>
          </div>
        )}
      </section>
      <section className="rounded-menu border border-border p-4" data-testid="ai-setup-cell">
        {data.businessNumber ? (
          <MyCellSection
            workspaceId={data.workspaceId}
            businessName={state.businessName}
            businessNumber={data.businessNumber}
            initial={data.cell}
          />
        ) : (
          <>
            <h3 className="font-semibold">{W.cellTitle}</h3>
            <p className="mt-1 text-[13.5px] text-text-2">{W.cellNoNumber}</p>
          </>
        )}
      </section>
      <Note icon={Info}>{withAiName(W.emailOff, name)}</Note>
      <PhoneAppDialog open={app} onOpenChange={setApp} notifications />
    </>
  );
}

function ChatScreen({ answers, set }: ScreenProps) {
  return (
    <Group label="Website chat">
      <Option
        on={answers.chat}
        onSelect={() => set('chat', true)}
        title={AI_SETUP_CHAT_LABELS.yes}
        testId="ai-setup-chat-yes"
      />
      <Option
        on={!answers.chat}
        onSelect={() => set('chat', false)}
        title={AI_SETUP_CHAT_LABELS.no}
        testId="ai-setup-chat-no"
      />
    </Group>
  );
}
