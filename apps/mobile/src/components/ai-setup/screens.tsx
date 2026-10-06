import {
  AI_SETUP_ANSWER_WHEN_LABELS,
  AI_SETUP_CHAT_LABELS,
  AI_SETUP_DISCLOSURE_LABELS,
  AI_SETUP_FIELD_WORDS as W,
  AI_SETUP_JOB_LABELS,
  AI_SETUP_PRICE_LABELS,
  AI_SETUP_TEMPLATE_WORDS,
  AI_SETUP_TONE_LABELS,
  AI_SETUP_TONE_TEXTS,
  aiSetupProblemAt,
  firstTextPreview,
  HOURS_MODES,
  quickFactsFor,
  SETUP_JOBS,
  SETUP_KIND_LABELS,
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
  type AiSetupTemplateOption,
  type AiSetupTone,
} from '@hfos/core';
import * as Linking from 'expo-linking';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AI_SETUP_PHONE_WORDS as P } from '@/ai-setup/words';
import { Bell, FileText, Info, TriangleAlert } from '@/components/icons';
import { MyCellCard } from '@/components/inbox/my-cell-card';
import { useBusiness } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useBusinessNumber } from '@/inbox/cell';
import { cn } from '@/lib/utils';
import { pushRegistration } from '@/push/device';
import { usePushRegistration } from '@/push/hooks';
import { useColors } from '@/theme';

import {
  Field,
  KindField,
  Option,
  Pills,
  QualifyField,
  ServicesField,
  TextArea,
  Tick,
  TopQuestionsField,
  WebsiteField,
  YesNo,
} from './fields';
import { HoursField } from './hours';

/**
 * Quick setup's question screens on the phone, 1 to 11 (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8),
 * as the web's components/ai-setup/screens.tsx: each only shows and changes answers, and the frame around them
 * (./quick-setup.tsx) checks, keeps and saves them. Where a phone does something its own way, it says so: the kind
 * of business is a searchable sheet, "Stay in the loop" turns on this phone's alerts, and a PDF is added on a
 * computer.
 */

export interface ScreenProps {
  readonly step: Exclude<AiSetupStep, 'try'>;
  readonly state: AiSetupState;
  readonly answers: AiSetupAnswers;
  readonly set: <K extends keyof AiSetupAnswers>(key: K, value: AiSetupAnswers[K]) => void;
  readonly problems: AiSetupProblems;
  readonly business: AiSetupBusinessDraft;
  readonly setBusiness: (patch: Partial<AiSetupBusinessDraft>) => void;
  readonly findings: readonly AiSetupFinding[];
  /**
   * The first screen's "Start from", while the business's agency saved answers and it has no teammate yet (§9): the
   * saved answers picked (null: our picks).
   */
  readonly startFrom?: {
    readonly templates: readonly AiSetupTemplateOption[];
    readonly value: string | null;
    readonly onChange: (templateId: string | null) => void;
  } | null;
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

const NOTE_TONES = {
  info: { box: 'bg-card-2', text: 'text-text-2', icon: 'text-text-3' },
  accent: { box: 'bg-accent-soft', text: 'text-accent-text', icon: 'text-accent-text' },
  warning: { box: 'bg-warning-soft', text: 'text-warning-text', icon: 'text-warning-text' },
} as const;

/** A line in a tinted box: what's happening, or what to know. */
function Note({
  tone = 'info',
  icon,
  busy,
  children,
  testID,
}: {
  tone?: keyof typeof NOTE_TONES;
  icon?: LucideIcon;
  /** A spinner in place of the icon: something's still going. */
  busy?: boolean;
  children: string;
  testID?: string;
}) {
  const look = NOTE_TONES[tone];
  const colors = useColors();
  return (
    <View
      className={cn('flex-row items-start gap-2.5 rounded-menu px-3.5 py-3', look.box)}
      role={tone === 'warning' ? 'alert' : undefined}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tone === 'accent' ? colors.accent : colors.text3} />
      ) : icon ? (
        <Icon as={icon} className={cn('mt-0.5 size-4', look.icon)} />
      ) : null}
      <Text className={cn('min-w-0 flex-1 text-[13.5px] leading-[19px]', look.text)}>
        {children}
      </Text>
    </View>
  );
}

/** A few answers to pick one of. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Label>{label}</Label>
      <View className="gap-2" role="radiogroup" accessibilityLabel={label}>
        {children}
      </View>
    </View>
  );
}

function BusinessScreen({ answers, business, setBusiness, problems, startFrom }: ScreenProps) {
  const name = nameOf(answers);
  return (
    <>
      <Field label={W.businessName} error={problems['business.name']}>
        <Input
          value={business.name}
          onChangeText={(text) => setBusiness({ name: text })}
          maxLength={120}
          autoCapitalize="words"
          invalid={!!problems['business.name']}
          accessibilityLabel={W.businessName}
          testID="ai-setup-business-name"
        />
      </Field>
      <KindField
        value={business.industry}
        onChange={(industry) => setBusiness({ industry })}
        error={problems['business.industry']}
      />
      <WebsiteField
        value={business.site}
        noSite={business.noSite}
        onChange={(site) => setBusiness({ site })}
        onNoSite={(noSite) => setBusiness({ noSite })}
        hint={withAiName(business.noSite ? W.noWebsiteHint : W.websiteHint, name)}
        error={problems['business.website']}
      />
      {startFrom ? <StartFrom {...startFrom} /> : null}
    </>
  );
}

/** Where the answers start: answers the agency saved, or our picks (§9). */
function StartFrom({ templates, value, onChange }: NonNullable<ScreenProps['startFrom']>) {
  const T = AI_SETUP_TEMPLATE_WORDS;
  return (
    <View className="gap-2">
      <View className="gap-1">
        <Label>{T.startFrom}</Label>
        <Text className="text-[13px] leading-[18px] text-text-3">{T.startFromHint}</Text>
      </View>
      <View className="gap-2" role="radiogroup" accessibilityLabel={T.startFrom}>
        {templates.map((t) => (
          <Option
            key={t.id}
            on={value === t.id}
            onSelect={() => onChange(t.id)}
            title={t.name}
            badge={<Badge>{SETUP_KIND_LABELS[t.kind]}</Badge>}
            description={t.about}
            testID={`ai-setup-start-${t.id}`}
          />
        ))}
        <Option
          on={value === null}
          onSelect={() => onChange(null)}
          title={T.ourPicks}
          testID="ai-setup-start-picks"
        />
      </View>
    </View>
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
    <View className="gap-2">
      {SETUP_JOBS.map((job) => (
        <Tick
          key={job}
          on={answers.jobs.includes(job)}
          onToggle={() => toggle(job)}
          title={AI_SETUP_JOB_LABELS[job]}
          testID={`ai-setup-job-${job}`}
        />
      ))}
      <FieldError>{aiSetupProblemAt(problems, 'jobs')}</FieldError>
    </View>
  );
}

/** While Ava reads the website for these screens. */
function Reading({ state, answers }: Pick<ScreenProps, 'state' | 'answers'>) {
  if (!state.reading) return null;
  return (
    <Note tone="accent" busy testID="ai-setup-reading">
      {withAiName(W.reading, nameOf(answers))}
    </Note>
  );
}

function AboutScreen({ state, answers, set, problems }: ScreenProps) {
  const { area } = setupFor(state.industry);
  return (
    <>
      <Reading state={state} answers={answers} />
      <Field label={W.description} error={problems['description']}>
        <TextArea
          value={answers.description}
          onChangeText={(text) => set('description', text)}
          maxLength={2000}
          invalid={!!problems['description']}
          accessibilityLabel={W.description}
          testID="ai-setup-description"
        />
      </Field>
      <ServicesField
        services={answers.services}
        onChange={(next) => set('services', next)}
        problems={problems}
      />
      <Field label={area.question} error={problems['area']}>
        <Input
          value={answers.area}
          onChangeText={(text) => set('area', text)}
          maxLength={500}
          placeholder={area.example}
          invalid={!!problems['area']}
          accessibilityLabel={area.question}
          testID="ai-setup-area"
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
      <View className="gap-1">
        <Label>{W.openHours}</Label>
        <HoursField
          value={answers.openHours}
          onChange={(next) => set('openHours', next)}
          idPrefix="ai-setup-open"
          error={aiSetupProblemAt(problems, 'openHours')}
        />
      </View>
      <Group label={withAiName(W.answerWhen, name)}>
        {HOURS_MODES.map((mode) => (
          <Option
            key={mode}
            on={answers.answerWhen === mode}
            onSelect={() => set('answerWhen', mode)}
            title={AI_SETUP_ANSWER_WHEN_LABELS[mode]}
            testID={`ai-setup-answer-${mode}`}
          />
        ))}
      </Group>
      {answers.answerWhen === 'custom' ? (
        <View className="gap-1">
          <Label>{withAiName(W.customHours, name)}</Label>
          <HoursField
            value={answers.customHours}
            onChange={(next) => set('customHours', next)}
            idPrefix="ai-setup-custom"
            error={aiSetupProblemAt(problems, 'customHours')}
          />
        </View>
      ) : null}
    </>
  );
}

function FactsScreen({ state, answers, set }: ScreenProps) {
  const facts = quickFactsFor(state.industry);
  /** What the website says, shown while the answer is still the website's. */
  const site = state.found?.facts ?? {};
  return (
    <View testID="ai-setup-facts">
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
          testID={`ai-setup-fact-${f.key}`}
          note={site[f.key] && site[f.key] === answers.facts[f.key] ? W.fromWebsite : null}
        />
      ))}
    </View>
  );
}

function MeetScreen({ state, answers, set, problems }: ScreenProps) {
  const name = nameOf(answers);
  return (
    <>
      <Field label={W.name} error={problems['name']}>
        <Input
          value={answers.name}
          onChangeText={(text) => set('name', text)}
          maxLength={40}
          autoCapitalize="words"
          invalid={!!problems['name']}
          accessibilityLabel={W.name}
          testID="ai-setup-name"
        />
      </Field>
      <Group label={withAiName(W.disclosure, name)}>
        <Option
          on={answers.disclosure === 'first_message'}
          onSelect={() => set('disclosure', 'first_message')}
          title={AI_SETUP_DISCLOSURE_LABELS.first_message}
          badge={<Badge variant="ok">{W.disclosureRecommended}</Badge>}
          description={`“${firstTextPreview(name, 'first_message', state.businessName)}”`}
          testID="ai-setup-disclosure-first_message"
        />
        <Option
          on={answers.disclosure === 'when_asked'}
          onSelect={() => set('disclosure', 'when_asked')}
          title={AI_SETUP_DISCLOSURE_LABELS.when_asked}
          description={W.disclosureWhenAsked}
          testID="ai-setup-disclosure-when_asked"
        />
      </Group>
      {answers.disclosure === 'when_asked' ? (
        <Note tone="warning" icon={TriangleAlert} testID="ai-setup-california">
          {W.disclosureCalifornia}
        </Note>
      ) : null}
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
            testID={`ai-setup-tone-${tone}`}
          />
        ))}
      </Group>
      <View className="gap-1.5">
        <Pills
          name="prices"
          legend={withAiName(W.prices, name)}
          options={['no', 'yes'] as const}
          labels={AI_SETUP_PRICE_LABELS}
          value={answers.allowPrices ? 'yes' : 'no'}
          onChange={(v) => set('allowPrices', v === 'yes')}
        />
        <Text className="text-[13px] leading-[18px] text-text-3">{W.pricesHint}</Text>
      </View>
    </>
  );
}

function LearnedScreen({ state, answers, set, problems, findings }: ScreenProps) {
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
        <View className="gap-2" testID="ai-setup-findings">
          {findings.length ? (
            <>
              <View className="min-h-9 flex-row items-center justify-between gap-3">
                <Text className="text-[13px] font-medium">
                  {W.findings} · {findings.length}
                </Text>
                {dropped.size ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => set('dropFindings', [])}
                    testID="ai-setup-keep-all"
                  >
                    {W.keepAll}
                  </Button>
                ) : null}
              </View>
              {findings.map((f) => (
                <Tick
                  key={f.id}
                  on={!dropped.has(f.id)}
                  onToggle={() => toggle(f.id)}
                  title={f.title}
                  description={f.body}
                  testID={`ai-setup-finding-${f.id}`}
                />
              ))}
            </>
          ) : null}
          {scan === 'running' ? (
            <Note busy>{withAiName(W.findingsWaiting, name)}</Note>
          ) : scan === 'failed' ? (
            <Note icon={Info}>{withAiName(W.findingsFailed, name)}</Note>
          ) : !findings.length ? (
            <Note icon={Info}>{withAiName(W.findingsNone, name)}</Note>
          ) : null}
        </View>
      ) : (
        <Text className="text-[15px] leading-[21px] text-text-2">{W.learnedNoWebsite}</Text>
      )}
      <TopQuestionsField
        value={answers.topQuestions}
        onChange={(next) => set('topQuestions', next)}
        problems={problems}
      />
      <Note icon={FileText} testID="ai-setup-pdf-on-computer">
        {P.pdfOnComputer}
      </Note>
    </>
  );
}

/** "Stay in the loop" on the phone: this phone's alerts in place of "Get the phone app", then your cell. */
function LoopScreen({ answers }: ScreenProps) {
  const { business } = useBusiness();
  const number = useBusinessNumber(business.id);
  const name = nameOf(answers);
  return (
    <>
      <Alerts name={name} />
      {number ? (
        <MyCellCard title={W.cellTitle} intro={W.cellWhy} />
      ) : (
        <Card className="gap-1 p-3.5" testID="ai-setup-cell">
          <Text className="text-base font-semibold">{W.cellTitle}</Text>
          <Text className="text-[13px] leading-[18px] text-text-2">{P.cellNoNumber}</Text>
        </Card>
      )}
      <Note icon={Info}>{withAiName(W.emailOff, name)}</Note>
    </>
  );
}

/** Whether this phone gets the alerts when the teammate needs a person, and turning them on. */
function Alerts({ name }: { name: string }) {
  const push = usePushRegistration();
  const [busy, setBusy] = React.useState(false);
  const on = push.permission === 'granted';
  // Turned off in the phone's settings: only the phone's settings can turn them back on.
  const blocked = push.permission === 'denied' && !push.canAskAgain;
  const turnOn = async () => {
    if (blocked) {
      toast.show(P.notificationsOff);
      await Linking.openSettings();
      return;
    }
    setBusy(true);
    try {
      await pushRegistration.ask();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="gap-3 p-3.5" testID="ai-setup-alerts">
      <View className="flex-row items-start gap-3">
        <View className="size-9 items-center justify-center rounded-[9px] bg-accent-soft">
          <Icon as={Bell} className="size-[18px] text-accent-text" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-semibold">{P.alertsTitle}</Text>
          <Text
            className={cn('text-[13px] leading-[18px]', on ? 'text-success-text' : 'text-text-2')}
            testID={on ? 'ai-setup-alerts-on' : 'ai-setup-alerts-off'}
          >
            {withAiName(on ? P.alertsOn : P.alertsOff, name)}
          </Text>
        </View>
      </View>
      {on ? null : (
        <Button
          variant="secondary"
          loading={busy}
          onPress={() => void turnOn()}
          testID="ai-setup-alerts-turn-on"
        >
          {blocked ? P.openSettings : P.turnOnAlerts}
        </Button>
      )}
    </Card>
  );
}

function ChatScreen({ answers, set }: ScreenProps) {
  return (
    <View className="gap-2" role="radiogroup" accessibilityLabel="Website chat">
      <Option
        on={answers.chat}
        onSelect={() => set('chat', true)}
        title={AI_SETUP_CHAT_LABELS.yes}
        testID="ai-setup-chat-yes"
      />
      <Option
        on={!answers.chat}
        onSelect={() => set('chat', false)}
        title={AI_SETUP_CHAT_LABELS.no}
        testID="ai-setup-chat-no"
      />
    </View>
  );
}
