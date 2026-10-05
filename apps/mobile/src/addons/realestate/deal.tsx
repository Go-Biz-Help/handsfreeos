import { daysBetween, localDateOf, money } from '@hfos/core';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import {
  clientNames,
  RE_DEAL_WORDS,
  RE_DOCUMENTS_WORDS,
} from '@hfos/core/addons/realestate/phone-words-deals';
import { dueWords, SOURCE_WORDS, startedByWords } from '@hfos/core/addons/realestate/rule-words';
import {
  isDoneDuty,
  LISTING_EXITS,
  STAGE_LABELS,
  stagesOf,
  type DealStage,
} from '@hfos/core/addons/realestate/states';
import { OUTCOME_LABELS } from '@hfos/core/addons/realestate/words';
import {
  clientTasksOfCopy,
  contingenciesOfCopy,
  contractReadsOfCopy,
} from '@hfos/core/addons/realestate/views/closing';
import {
  dealPageOfCopy,
  dealRisksOfCopy,
  type DealPage,
  type DealRisksView,
} from '@hfos/core/addons/realestate/views/deal-page';
import { documentsOfCopy } from '@hfos/core/addons/realestate/views/documents';
import { listPriceOfCopy } from '@hfos/core/addons/realestate/views/listing';
import type { TermSource } from '@hfos/core/addons/realestate/dates/key-dates';
import { useQuery } from '@powersync/react-native';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  Ban,
  CalendarDays,
  Check,
  ChevronRight,
  Clock,
  Ellipsis,
  MessageSquare,
  Pencil,
  Phone,
  Users,
} from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { startCall } from '@/inbox/calls';
import { errorMessage } from '@/lib/api';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { useRealestateCopy } from './copy';
import { addDealNote, moveStage, requestUpdate } from './deal-actions';
import { dayOf, dueChip, GroupLabel, Tabs } from './deal-bits';
import { DealMoreSheet, ExportSheet, HoldBanner, HoldSheet, useDealHold } from './deal-more';
import { DutyScreen } from './duty-sheet';
import { NeedsSignalCard, openRe, RE_EXPORT, SummaryChip, useReContext } from './kit';

/**
 * A deal (board 78): a buyer deal or a listing, with what could stop the closing first and the next move, then its
 * dates, people and every page of the deal. Call and text reach the clients from the top. Each page opens through
 * the route map: the phone's own screen once this build has it, the web until then. More holds the rest, and what
 * HandsFreeOS has to check first (the AI, export, holds) says it needs signal. With `?duty=`, the duty itself.
 */

const RECORDS_HOLD = 'records.hold';

export function DealScreen({ dealId, duty }: { dealId: string; duty?: string }) {
  if (duty) return <DutyScreen dutyId={duty} dealId={dealId} />;
  return <DealPageScreen dealId={dealId} />;
}

/** What the deal's pages say about themselves, from the phone's copy. */
export interface DealCounts {
  readonly documents: number;
  readonly contingenciesOpen: number;
  /** The newest reading of a contract, and how many of its values wait for a person. */
  readonly read: { readonly readId: string; readonly waiting: number } | null;
  readonly clients: readonly {
    readonly personId: string;
    readonly name: string;
    readonly portal: string;
  }[];
  readonly listPrice: number | null;
}

function DealPageScreen({ dealId }: { dealId: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const page = React.useMemo(() => dealPageOfCopy(copy, dealId, ctx), [copy, dealId, ctx]);
  const risks = React.useMemo(() => dealRisksOfCopy(copy, dealId), [copy, dealId]);
  const counts = React.useMemo<DealCounts>(() => {
    const reads = contractReadsOfCopy(copy, dealId, ctx)?.reads ?? [];
    return {
      documents: documentsOfCopy(copy, dealId).length,
      contingenciesOpen:
        contingenciesOfCopy(copy, dealId, ctx)?.contingencies.filter((c) => c.state === 'open')
          .length ?? 0,
      read: reads[0] ? { readId: reads[0].readId, waiting: reads[0].waiting } : null,
      clients: clientTasksOfCopy(copy, dealId, ctx)?.clients ?? [],
      listPrice: listPriceOfCopy(copy, dealId),
    };
  }, [copy, dealId, ctx]);
  const hold = useDealHold(ctx.workspaceId, dealId);
  return (
    <DealView
      page={page}
      risks={risks}
      counts={counts}
      hold={hold.data ?? null}
      onHoldChanged={hold.reload}
      workspaceId={ctx.workspaceId}
      timeZone={ctx.timeZone}
      now={ctx.now}
      canExport={ctx.holds(RE_EXPORT)}
      canHold={ctx.holds(RECORDS_HOLD)}
    />
  );
}

type Tab = 'overview' | 'duties' | 'people';

export function DealView({
  page,
  risks,
  counts,
  hold,
  onHoldChanged,
  workspaceId,
  timeZone,
  now,
  canExport,
  canHold,
}: {
  page: DealPage | null;
  risks: DealRisksView | null;
  counts: DealCounts;
  hold: React.ComponentProps<typeof HoldBanner>['hold'] | null;
  onHoldChanged: () => void;
  workspaceId: string;
  timeZone: string;
  now: number;
  canExport: boolean;
  canHold: boolean;
}) {
  const [tab, setTab] = React.useState<Tab>('overview');
  const [sheet, setSheet] = React.useState<'more' | 'export' | 'hold' | 'note' | null>(null);
  const [next, setNext] = React.useState<typeof sheet>(null);
  if (!page)
    return (
      <Screen title={RE_DOCUMENTS_WORDS.title} leading="back" testID="re-deal">
        <NeedsSignalCard words={RE_PHONE_WORDS.notOnPhone} testID="re-deal-missing" />
      </Screen>
    );
  const d = page.deal;
  const dealId = d.dealId;
  const address = page.property?.address ?? null;
  const live = d.outcome === null && !d.archived;
  const path = (p: string) =>
    `/app/w/${workspaceId}/a/realestate/deals/${dealId}${p ? `/${p}` : ''}`;
  const openPage = (p: string) => openWebPath(path(p));
  const openDuty = (dutyId: string) => openRe(workspaceId, `deals/${dealId}?duty=${dutyId}`);
  const open = page.duties.filter((t) => !isDoneDuty(t.status));
  const run = stagesOf(d.side).filter(
    (s) => !(LISTING_EXITS as readonly string[]).includes(s) || s === d.stage,
  );
  const here = run.indexOf(d.stage as DealStage);
  const nextStage = here >= 0 ? (run[here + 1] ?? null) : null;
  const closing = page.terms.find((t) => t.key === 'closing')?.entries[0]?.date ?? null;
  const days = Math.max(
    0,
    daysBetween(localDateOf(Date.parse(d.stageEnteredAt), timeZone), localDateOf(now, timeZone)),
  );
  const line = [
    address,
    d.side === 'buyer' ? RE_DEAL_WORDS.buyerDeal : RE_DEAL_WORDS.listing,
    d.side === 'listing'
      ? RE_DEAL_WORDS.inStage(d.stageLabel, days)
      : closing
        ? RE_DEAL_WORDS.closing(dayOf(closing, timeZone, now)!)
        : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const clientId =
    counts.clients[0]?.personId ??
    page.parties.find((p) => p.role === 'client' && p.personId)?.personId ??
    null;

  // A sheet that leads to another opens it once it's gone (iOS shows one modal at a time).
  const switchTo = (to: typeof sheet) => {
    setNext(to);
    setSheet(null);
  };

  return (
    <Screen
      title={d.name}
      subtitle={address ?? undefined}
      leading="back"
      testID="re-deal"
      scroll={false}
      trailing={
        <Pressable
          role="button"
          accessibilityLabel={RE_DEAL_WORDS.more}
          onPress={() => setSheet('more')}
          hitSlop={6}
          className="size-10 items-center justify-center"
          testID="re-deal-more-button"
        >
          <Icon as={Ellipsis} className="size-[22px] text-text-2" />
        </Pressable>
      }
    >
      <View className="gap-3 border-b border-border bg-card px-4 pb-3.5 pt-3">
        <View className="flex-row items-start gap-2">
          <Text variant="heading" className="flex-1" testID="re-deal-name">
            {d.name}
          </Text>
          <Badge variant="accent">
            <Text>{d.stageLabel}</Text>
          </Badge>
        </View>
        <Text className="-mt-1.5 text-[13.5px] text-text-2" testID="re-deal-line">
          {line}
        </Text>
        {!page.full ? (
          <View className="gap-1">
            <SummaryChip />
            <Text className="text-[12.5px] text-text-3">{RE_PHONE_WORDS.summaryNote}</Text>
          </View>
        ) : null}
        <DealButtons
          workspaceId={workspaceId}
          clientId={clientId}
          onNote={() => setSheet('note')}
        />
      </View>
      <Tabs<Tab | 'dates' | 'documents' | 'history'>
        value={tab}
        onChange={(t) => {
          if (t === 'overview' || t === 'duties' || t === 'people') setTab(t);
          else openPage(t);
        }}
        label={d.name}
        tabs={[
          { value: 'overview', label: RE_DEAL_WORDS.tabs.overview },
          { value: 'duties', label: RE_DEAL_WORDS.tabs.duties(open.length) },
          { value: 'dates', label: RE_DEAL_WORDS.tabs.dates },
          { value: 'documents', label: RE_DEAL_WORDS.tabs.documents },
          { value: 'people', label: RE_DEAL_WORDS.tabs.people },
          { value: 'history', label: RE_DEAL_WORDS.tabs.history },
        ]}
        testID="re-deal-tabs"
      />
      <ScrollPage>
        {hold ? (
          <HoldBanner
            hold={hold}
            timeZone={timeZone}
            onLift={canHold ? () => setSheet('hold') : undefined}
          />
        ) : null}
        {d.archived ? (
          <Card className="px-4 py-3">
            <Text className="text-[14px] text-text-2">{RE_DEAL_WORDS.archived}</Text>
          </Card>
        ) : d.outcome ? (
          <Card className="px-4 py-3" testID="re-deal-ended">
            <Text className="text-[14px] text-text-2">
              {RE_DEAL_WORDS.ended(
                (OUTCOME_LABELS as Readonly<Record<string, string>>)[d.outcome] ?? d.outcome,
                d.outcomeAt
                  ? dayOf(localDateOf(Date.parse(d.outcomeAt), timeZone), timeZone, now)
                  : null,
                d.outcomeReason,
              )}
            </Text>
          </Card>
        ) : null}
        {tab === 'overview' ? (
          <Overview
            page={page}
            risks={risks}
            counts={counts}
            timeZone={timeZone}
            now={now}
            onDuty={openDuty}
            onPage={openPage}
          />
        ) : tab === 'duties' ? (
          <DutiesTab page={page} timeZone={timeZone} now={now} onDuty={openDuty} />
        ) : (
          <People page={page} counts={counts} workspaceId={workspaceId} />
        )}
      </ScrollPage>

      <DealMoreSheet
        open={sheet === 'more'}
        onClose={() => setSheet(null)}
        dealName={d.name}
        nextStage={nextStage ? STAGE_LABELS[nextStage] : null}
        atClosing={d.stage === 'closing'}
        live={live}
        canExport={canExport && !d.archived}
        canHold={canHold}
        held={hold !== null}
        onUpdate={() => {
          setSheet(null);
          void requestUpdate(workspaceId, dealId)
            .then((r) => {
              toast.show(RE_DEAL_WORDS.writing);
              router.push(
                businessHref(
                  workspaceId,
                  `a/realestate/deals/${dealId}/updates/${r.output.draftId}`,
                ) as Href,
              );
            })
            .catch((e: unknown) => toast.error(errorMessage(e)));
        }}
        onNextStage={() => {
          setSheet(null);
          if (!nextStage) return;
          void moveStage(workspaceId, dealId, nextStage)
            .then(() => toast.show(RE_DEAL_WORDS.movedTo(STAGE_LABELS[nextStage])))
            .catch((e: unknown) => toast.error(errorMessage(e)));
        }}
        onExport={() => switchTo('export')}
        onHold={() => switchTo('hold')}
        onWeb={() => {
          setSheet(null);
          void openWeb(path(''));
        }}
      />
      <MoreNext
        next={next}
        sheet={sheet}
        onOpen={(s) => {
          setNext(null);
          setSheet(s);
        }}
      />
      <ExportSheet
        open={sheet === 'export'}
        onClose={() => setSheet(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
      <HoldSheet
        open={sheet === 'hold'}
        onClose={() => setSheet(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={d.name}
        hold={hold}
        onDone={() => {
          setSheet(null);
          onHoldChanged();
        }}
      />
      <NoteSheet
        open={sheet === 'note'}
        onClose={() => setSheet(null)}
        onSave={async (body) => {
          try {
            await addDealNote(workspaceId, dealId, body);
            setSheet(null);
            toast.show(RE_DEAL_WORDS.noteAdded);
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </Screen>
  );
}

/** Opens the sheet More led to, once More has gone. */
function MoreNext({
  next,
  sheet,
  onOpen,
}: {
  next: 'more' | 'export' | 'hold' | 'note' | null;
  sheet: string | null;
  onOpen: (s: 'more' | 'export' | 'hold' | 'note') => void;
}) {
  React.useEffect(() => {
    if (!next || sheet) return;
    const t = setTimeout(() => onOpen(next), 350);
    return () => clearTimeout(t);
  }, [next, sheet, onOpen]);
  return null;
}

function ScrollPage({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3 p-3 pb-8">
      {children}
    </ScrollView>
  );
}

/** Call, Text and Note: the clients from the top, and a note on the deal with no signal. */
function DealButtons({
  workspaceId,
  clientId,
  onNote,
}: {
  workspaceId: string;
  clientId: string | null;
  onNote: () => void;
}) {
  const { data: people } = useQuery<{ phone_e164: string | null }>(
    'SELECT phone_e164 FROM people WHERE id = ?',
    [clientId ?? ''],
  );
  const { data: threads } = useQuery<{ id: string }>(
    `SELECT id FROM conversations WHERE workspace_id = ? AND person_id = ? AND channel = 'sms'
     ORDER BY last_message_at DESC`,
    [workspaceId, clientId ?? ''],
  );
  const phone = people[0]?.phone_e164 ?? null;
  return (
    <View className="flex-row gap-2">
      <Button
        className="flex-1"
        icon={Phone}
        onPress={() => {
          if (!clientId) toast.error(RE_DEAL_WORDS.noClient);
          else if (!phone) toast.error(RE_DEAL_WORDS.noPhone);
          else startCall({ personId: clientId }, { workspaceId });
        }}
        testID="re-deal-call"
      >
        {RE_DEAL_WORDS.call}
      </Button>
      <Button
        className="flex-1"
        variant="secondary"
        icon={MessageSquare}
        onPress={() => {
          if (!clientId) toast.error(RE_DEAL_WORDS.noClient);
          else if (!threads[0]) toast.error(RE_DEAL_WORDS.noThread);
          else router.push(businessHref(workspaceId, `inbox/${threads[0].id}`) as Href);
        }}
        testID="re-deal-text"
      >
        {RE_DEAL_WORDS.text}
      </Button>
      <Button
        className="flex-1"
        variant="secondary"
        icon={Pencil}
        onPress={onNote}
        testID="re-deal-note"
      >
        {RE_DEAL_WORDS.note}
      </Button>
    </View>
  );
}

function NoteSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (body: string) => void;
}) {
  const [body, setBody] = React.useState('');
  const colors = useColors();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RE_DEAL_WORDS.noteTitle}
      testID="re-deal-note-sheet"
    >
      <View className="gap-2.5 pt-3">
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder={RE_DEAL_WORDS.notePlaceholder}
          placeholderTextColor={colors.placeholder}
          multiline
          autoFocus
          className="min-h-24 rounded-menu border border-border-strong bg-card px-3.5 py-3 font-sans text-base text-text"
          testID="re-deal-note-body"
        />
        <Button
          disabled={!body.trim()}
          onPress={() => {
            onSave(body);
            setBody('');
          }}
          testID="re-deal-note-save"
        >
          {RE_DEAL_WORDS.noteSave}
        </Button>
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------- overview

function Overview({
  page,
  risks,
  counts,
  timeZone,
  now,
  onDuty,
  onPage,
}: {
  page: DealPage;
  risks: DealRisksView | null;
  counts: DealCounts;
  timeZone: string;
  now: number;
  onDuty: (dutyId: string) => void;
  onPage: (path: string) => void;
}) {
  const d = page.deal;
  const reasons = risks?.reasons ?? [];
  const reds = reasons.filter((r) => r.level === 'red').length;
  const [all, setAll] = React.useState(false);
  const shown = all ? reasons : reasons.slice(0, 4);
  const inRisks = new Set(reasons.map((r) => r.dutyId).filter(Boolean));
  const next = page.duties.find(
    (t) => !isDoneDuty(t.status) && t.status !== 'draft' && !inRisks.has(t.dutyId),
  );
  const today = localDateOf(now, timeZone);
  const dates = page.terms
    .filter((t) => t.kind === 'date' && t.entries[0]?.date)
    .map((t) => ({ t, date: t.entries[0]!.date! }))
    .filter((x) => x.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);
  return (
    <>
      {d.side === 'listing' && counts.listPrice !== null ? (
        <Card className="gap-1 px-4 py-3" testID="re-deal-price">
          <View className="flex-row items-center gap-2">
            <Text className="flex-1 text-[18px] font-semibold">{money(counts.listPrice)}</Text>
            <Badge variant="ok">
              <Text>{d.stageLabel}</Text>
            </Badge>
          </View>
        </Card>
      ) : null}

      <GroupLabel
        label={
          reasons.length === 0
            ? RE_DEAL_WORDS.nothingInTheWay
            : reds > 0
              ? RE_DEAL_WORDS.couldStop(reds)
              : RE_DEAL_WORDS.needAttention(reasons.length)
        }
        tone={reds > 0 ? 'danger' : 'muted'}
        testID="re-deal-risks-title"
      />
      {reasons.length === 0 ? (
        <Card className="px-4 py-3">
          <Text className="text-[14px] text-text-2">{RE_DEAL_WORDS.nothingInTheWayLine}</Text>
        </Card>
      ) : (
        shown.map((r, i) => {
          const chip = r.dueAt ? dueChip(r.dueAt, timeZone, now, Date.parse(r.dueAt) <= now) : null;
          return (
            <Pressable
              key={`${r.code}-${r.dutyId ?? ''}-${i}`}
              role="button"
              onPress={() => (r.dutyId ? onDuty(r.dutyId) : onPage('dates'))}
              testID={`re-deal-risk-${i}`}
              className={cn(
                'gap-1 rounded-card border px-3.5 py-3',
                r.level === 'red'
                  ? 'border-danger-soft bg-danger-soft'
                  : 'border-warning-soft bg-warning-soft',
              )}
            >
              <View className="flex-row items-start gap-2">
                <Text
                  className={cn(
                    'flex-1 text-[14.5px] font-semibold',
                    r.level === 'red' ? 'text-danger-text' : 'text-warning-text',
                  )}
                  numberOfLines={2}
                >
                  {r.words}
                </Text>
                {chip ? (
                  <Text className="text-[12.5px] font-medium text-text-2">{chip.words}</Text>
                ) : null}
              </View>
              <Text className="text-[13px] text-text-2">
                {[
                  r.accountable ? RE_DEAL_WORDS.owner(r.accountable.name) : null,
                  r.next ? RE_DEAL_WORDS.next(r.next) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Pressable>
          );
        })
      )}
      {reasons.length > 4 ? (
        <Pressable
          role="button"
          onPress={() => setAll(!all)}
          testID="re-deal-risks-more"
          className="px-1"
        >
          <Text className="text-[13.5px] text-accent-text">
            {all ? RE_DEAL_WORDS.showFewer : RE_DEAL_WORDS.showAll(reasons.length)}
          </Text>
        </Pressable>
      ) : null}

      {next ? (
        <>
          <GroupLabel label={RE_DEAL_WORDS.nextTitle} />
          <Card>
            <Row
              icon={Pencil}
              label={next.title}
              detail={
                next.proofMissing
                  ? RE_DEAL_WORDS.stillNeeds(next.proofMissing)
                  : (next.accountable?.name ?? undefined)
              }
              end={
                next.dueAt
                  ? (dayOf(localDateOf(Date.parse(next.dueAt), timeZone), timeZone, now) ??
                    undefined)
                  : undefined
              }
              onPress={() => onDuty(next.dutyId)}
              testID="re-deal-next"
            />
          </Card>
        </>
      ) : null}

      {dates.length ? (
        <>
          <GroupLabel label={RE_DEAL_WORDS.keyDates} />
          <Card>
            {dates.map(({ t, date }, i) => {
              const e = t.entries[0]!;
              const source =
                SOURCE_WORDS[e.source as TermSource]?.replace(/^(the|an?) /, '') ?? e.source;
              return (
                <Row
                  key={t.key}
                  first={i === 0}
                  label={t.label}
                  detail={[source[0]!.toUpperCase() + source.slice(1), e.sourceRef]
                    .filter(Boolean)
                    .join(' · ')}
                  end={dayOf(date, timeZone, now) ?? undefined}
                  onPress={() => onPage('dates')}
                  testID={`re-deal-date-${t.key}`}
                />
              );
            })}
          </Card>
        </>
      ) : null}

      <People page={page} counts={counts} compact />

      <GroupLabel label={d.side === 'listing' ? RE_DEAL_WORDS.theListing : RE_DEAL_WORDS.pages} />
      <Card testID="re-deal-pages">
        {pagesOf(page, counts).map((p, i) => (
          <Row
            key={p.path}
            first={i === 0}
            label={p.label}
            detail={p.detail}
            onPress={() => onPage(p.path)}
            testID={`re-deal-page-${p.path.replace(/\//g, '-')}`}
          />
        ))}
      </Card>
    </>
  );
}

/** Every page of the deal, as the phone's route map names them. */
export function pagesOf(
  page: DealPage,
  counts: DealCounts,
): { readonly path: string; readonly label: string; readonly detail?: string }[] {
  const P = RE_DEAL_WORDS.page;
  const side =
    page.deal.side === 'buyer'
      ? [
          { path: 'buyer', label: P.buyer },
          { path: 'homes', label: P.homes },
          { path: 'tours', label: P.tours },
          { path: 'matches', label: P.matches },
          { path: 'offers', label: P.offers },
          { path: 'financing', label: P.financing },
          { path: 'inspections', label: P.inspections },
          { path: 'client-tasks', label: P.clientTasks },
        ]
      : [
          { path: 'facts', label: P.facts, detail: RE_DEAL_WORDS.pageLine.facts },
          { path: 'photos', label: P.photos },
          { path: 'description', label: P.description },
          {
            path: 'price',
            label: P.price,
            ...(counts.listPrice !== null ? { detail: money(counts.listPrice) } : {}),
          },
          { path: 'marketing', label: P.marketing },
          { path: 'open-houses', label: P.openHouses },
          { path: 'showings', label: P.showings },
          { path: 'offers', label: P.offers },
          { path: 'net-sheet', label: P.netSheet },
          { path: 'client-tasks', label: P.sellerTasks },
        ];
  return [
    ...side,
    { path: 'dates', label: P.dates },
    {
      path: 'contingencies',
      label: P.contingencies,
      ...(page.full
        ? { detail: RE_DEAL_WORDS.pageLine.contingencies(counts.contingenciesOpen) }
        : {}),
    },
    ...(counts.read
      ? [
          {
            path: `contract/${counts.read.readId}`,
            label: P.contract,
            detail: RE_DEAL_WORDS.pageLine.contract(counts.read.waiting),
          },
        ]
      : []),
    {
      path: 'documents',
      label: P.documents,
      ...(page.full ? { detail: RE_DEAL_WORDS.pageLine.documents(counts.documents) } : {}),
    },
    { path: 'history', label: P.history },
  ];
}

function Row({
  icon,
  label,
  detail,
  end,
  onPress,
  first = true,
  testID,
}: {
  icon?: React.ComponentProps<typeof Icon>['as'];
  label: string;
  detail?: string;
  end?: string;
  onPress?: () => void;
  first?: boolean;
  testID?: string;
}) {
  const body = (
    <>
      {icon ? <Icon as={icon} className="size-5 text-text-2" /> : null}
      <View className="min-w-0 flex-1 gap-px py-2">
        <Text className="text-[15px]">{label}</Text>
        {detail ? <Text className="text-[13px] text-text-3">{detail}</Text> : null}
      </View>
      {end ? <Text className="text-[13.5px] text-text-2">{end}</Text> : null}
      {onPress ? <Icon as={ChevronRight} className="size-4 text-text-3" /> : null}
    </>
  );
  const className = cn(
    'min-h-14 flex-row items-center gap-3 px-3.5',
    !first && 'border-t border-border',
  );
  return onPress ? (
    <Pressable
      role="button"
      accessibilityLabel={[label, detail, end].filter(Boolean).join('. ')}
      onPress={onPress}
      testID={testID}
      className={cn(className, 'active:bg-card-2')}
    >
      {body}
    </Pressable>
  ) : (
    <View className={className} testID={testID}>
      {body}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------- people

function People({
  page,
  counts,
  workspaceId,
  compact,
}: {
  page: DealPage;
  counts: DealCounts;
  workspaceId?: string;
  compact?: boolean;
}) {
  const clients = counts.clients.length
    ? counts.clients
    : page.parties
        .filter((p) => p.role === 'client' && p.personId)
        .map((p) => ({ personId: p.personId!, name: p.name, portal: 'none' }));
  const others = page.parties.filter((p) => p.role !== 'client');
  const portal = clients.map((c) => RE_DEAL_WORDS.portalStates[c.portal]).find(Boolean);
  const openPerson = (id: string) =>
    router.push(businessHref(workspaceId ?? '', `customers/people/${id}`) as Href);
  return (
    <>
      <GroupLabel label={RE_DEAL_WORDS.people} />
      <Card testID="re-deal-people">
        {clients.length ? (
          <Row
            icon={Users}
            label={clientNames(clients.map((c) => c.name))}
            detail={[
              clients.length > 1 ? RE_DEAL_WORDS.clients : RE_DEAL_WORDS.client,
              portal ? RE_DEAL_WORDS.portal(portal) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            onPress={workspaceId ? () => openPerson(clients[0]!.personId) : undefined}
            testID="re-deal-clients"
          />
        ) : null}
        {others.map((p, i) => (
          <Row
            key={p.relationshipId}
            first={!clients.length && i === 0}
            icon={Phone}
            label={p.name}
            detail={[p.label, compact ? null : p.note].filter(Boolean).join(' · ')}
            onPress={workspaceId && p.personId ? () => openPerson(p.personId!) : undefined}
          />
        ))}
        {!compact
          ? page.team.map((t, i) => (
              <Row
                key={t.userId}
                first={!clients.length && !others.length && i === 0}
                label={t.name}
                detail={RE_DEAL_WORDS.team[t.role] ?? t.role}
              />
            ))
          : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- duties

function DutiesTab({
  page,
  timeZone,
  now,
  onDuty,
}: {
  page: DealPage;
  timeZone: string;
  now: number;
  onDuty: (dutyId: string) => void;
}) {
  const [which, setWhich] = React.useState<'open' | 'done'>('open');
  const open = page.duties.filter((t) => !isDoneDuty(t.status));
  const done = page.duties.filter((t) => isDoneDuty(t.status));
  const shown = which === 'open' ? open : done;
  const groups = new Map<string, typeof shown>();
  for (const t of shown) {
    const g = startedByWords(t.startedBy);
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  return (
    <>
      <Segmented
        value={which}
        onChange={setWhich}
        label={RE_DEAL_WORDS.tabs.duties(open.length)}
        options={[
          {
            value: 'open',
            label: RE_DEAL_WORDS.dutiesOpen(open.length),
            testID: 're-deal-duties-open',
          },
          {
            value: 'done',
            label: RE_DEAL_WORDS.dutiesDone(done.length),
            testID: 're-deal-duties-done',
          },
        ]}
      />
      {shown.length === 0 ? (
        <Card className="px-4 py-6">
          <Text className="text-center text-[14px] text-text-2">{RE_DEAL_WORDS.noDutiesOpen}</Text>
        </Card>
      ) : (
        [...groups].map(([group, list]) => (
          <View key={group} className="gap-1.5">
            <GroupLabel label={group} />
            <Card>
              {list.map((t, i) => {
                const isDone = isDoneDuty(t.status);
                const icon = isDone
                  ? Check
                  : t.status === 'blocked'
                    ? Ban
                    : t.status === 'waiting_external' || t.status === 'draft'
                      ? Clock
                      : CalendarDays;
                return (
                  <Pressable
                    key={t.dutyId}
                    role="button"
                    onPress={() => onDuty(t.dutyId)}
                    testID={`re-deal-duty-${t.dutyId}`}
                    className={cn(
                      'min-h-14 flex-row items-center gap-3 px-3.5 py-2 active:bg-card-2',
                      i > 0 && 'border-t border-border',
                    )}
                  >
                    <Icon
                      as={icon}
                      className={cn(
                        'size-[18px]',
                        isDone ? 'text-success' : t.overdue ? 'text-danger' : 'text-text-3',
                      )}
                    />
                    <View className="min-w-0 flex-1 gap-px">
                      <Text className={cn('text-[15px]', isDone && 'text-text-2')}>{t.title}</Text>
                      <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
                        {[
                          t.accountable?.name,
                          t.proofMissing
                            ? RE_DEAL_WORDS.stillNeeds(t.proofMissing)
                            : t.proof
                              ? RE_DEAL_WORDS.proof(t.proof)
                              : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <View className="items-end gap-1">
                      {t.status === 'waiting_external' && t.waitingOn ? (
                        <Badge variant="pending">
                          <Text numberOfLines={1}>{`Waiting on ${t.waitingOn}`}</Text>
                        </Badge>
                      ) : t.status === 'blocked' ? (
                        <Badge variant="danger">
                          <Text numberOfLines={1}>{RE_DEAL_WORDS.blocked(t.blocked)}</Text>
                        </Badge>
                      ) : t.status === 'draft' ? (
                        <Badge variant="pending">
                          <Text>{RE_DEAL_WORDS.waitingFor}</Text>
                        </Badge>
                      ) : null}
                      {t.dueAt ? (
                        <Text
                          className={cn(
                            'text-[12.5px]',
                            t.overdue ? 'text-danger-text' : 'text-text-2',
                          )}
                        >
                          {dueWords(t.dueAt, timeZone, { now, open: !isDone })}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </Card>
          </View>
        ))
      )}
    </>
  );
}
