import {
  clearsBar,
  joinAnd,
  MAIN_OFFER_BAR,
  MAIN_OFFER_PHONE_WORDS as PW,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  OFFER_STEP_WORDS,
  offerLineFrom,
  offerStepOf,
  SCORED_PARTS,
  timeOfDay,
  type MainOfferNotes,
  type MissingPart,
  type OfferStep,
  type ScoredPart,
} from '@hfos/core';
import { router, useFocusEffect } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { ChevronRight, CloudOff, ExternalLink, Pencil, Sparkles } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useGrants } from '@/lib/grants';
import { useLiveAnswer } from '@/lib/live-answer';
import { openWeb } from '@/lib/open-web';

import { AnywaySheet } from './anyway-sheet';
import {
  draftMoved,
  draftRevision,
  MAIN_OFFER_MANAGE,
  mainOfferCalls,
  offerAiError,
  type MainOffer,
  type MainOfferTry,
} from './calls';
import { LiveOffer } from './live';
import { DirectionBox, PartCard, ScoreGlance } from './review';
import { TryReady } from './try-ready';

/**
 * Settings → Main offer on the phone (HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md; design/main-offer, 11 to
 * 16). It needs signal: the offer and this round's tries are asked on open, and nothing of them is kept on the phone.
 * Whoever can change the offer (`main_offer.manage`) gets the Review step, as the web's builder ends with it; everyone
 * else reads the live version.
 */

interface Loaded {
  readonly offer: MainOffer;
  readonly tries: readonly MainOfferTry[];
}

export function MainOfferScreen() {
  const { business } = useBusiness();
  const { permissions } = useGrants();
  const manages = permissions?.includes(MAIN_OFFER_MANAGE) ?? false;
  const load = React.useCallback(async (): Promise<Loaded> => {
    const calls = mainOfferCalls(business.id);
    const [offer, tries] = await Promise.all([
      calls.get(),
      manages ? calls.tries() : Promise.resolve([]),
    ]);
    return { offer, tries };
  }, [business.id, manages]);
  const answer = useLiveAnswer(load, `${business.id}:${manages}`, PW.needsSignal);
  const data = answer.data;
  // Coming back from Edit it myself asks again: the draft changed there, and its score went with it.
  const { reload } = answer;
  const first = React.useRef(true);
  useFocusEffect(
    React.useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
    }, [reload]),
  );
  const reviews = manages && !!data && data.offer.inUse && !!(data.offer.draft || data.offer.live);

  const body = !data ? (
    answer.error ? (
      <Trouble words={answer.error} onRetry={answer.reload} />
    ) : (
      <View className="items-center py-10">
        <ActivityIndicator />
      </View>
    )
  ) : !data.offer.inUse ? (
    <Notice testID="main-offer-not-in-use">{PW.notInUse(joinAnd(data.offer.comesWith))}</Notice>
  ) : !data.offer.live && !data.offer.draft ? (
    manages ? (
      <BuildOnWeb workspaceId={business.id} />
    ) : (
      <Notice testID="main-offer-ask-owner">{W.askOwner}</Notice>
    )
  ) : null;

  return (
    <Screen
      title={W.title}
      subtitle={reviews ? OFFER_STEP_WORDS.score.title : undefined}
      leading="back"
      back={businessHref(business.id, 'settings')}
      scroll={!reviews}
      testID="main-offer"
    >
      {body}
      {data && !body ? (
        reviews ? (
          <Review
            workspaceId={business.id}
            offer={data.offer}
            tries={data.tries}
            onReload={answer.reload}
          />
        ) : (
          <ReadOnly offer={data.offer} />
        )
      ) : null}
    </Screen>
  );
}

/** With no signal, or after a failure: what happened, and Try again. */
function Trouble({ words, onRetry }: { words: string; onRetry: () => void }) {
  return (
    <Card className="items-center gap-3 px-5 py-8" testID="main-offer-trouble">
      <Icon as={CloudOff} className="size-6 text-text-3" />
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">{words}</Text>
      <Button variant="secondary" className="self-stretch" onPress={onRetry}>
        {PW.tryAgain}
      </Button>
    </Card>
  );
}

function Notice({ children, testID }: { children: string; testID: string }) {
  return (
    <Card className="px-4 py-4" testID={testID}>
      <Text className="leading-[22px] text-text-2">{children}</Text>
    </Card>
  );
}

/** Opens a page of the main offer on the web; says so when the phone couldn't. */
async function openOnWeb(path: string): Promise<void> {
  if (!(await openWeb(path))) toast.error(PW.webDidntOpen);
}

const builderPath = (workspaceId: string, step?: OfferStep) =>
  `/app/w/${workspaceId}/main-offer/build${step ? `?step=${step}` : ''}`;

/** Nothing built yet: the builder's first steps are on a computer (answered 2). */
function BuildOnWeb({ workspaceId }: { workspaceId: string }) {
  return (
    <Card className="gap-3 px-4 py-4" testID="main-offer-build">
      <Text className="text-lg font-semibold tracking-[-0.18px]">{PW.buildTitle}</Text>
      <Text className="leading-[22px] text-text-2">{PW.buildHint}</Text>
      <Button
        icon={ExternalLink}
        onPress={() => void openOnWeb(builderPath(workspaceId))}
        testID="main-offer-open-web"
      >
        {PW.openOnWeb}
      </Button>
    </Card>
  );
}

/** Someone is changing the offer: who, when, and that the live version keeps running. */
function DraftBanner({ offer }: { offer: MainOffer }) {
  const draft = offer.draft;
  if (!draft) return null;
  return (
    <View
      className="flex-row items-start gap-2.5 rounded-menu bg-accent-soft px-3.5 py-3"
      testID="main-offer-draft"
    >
      <Icon as={Pencil} className="mt-0.5 size-4 text-accent-text" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="font-medium">{W.draftBy(draft.by?.name ?? 'Someone')}</Text>
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          {W.draftAbout(
            draft.at ? timeOfDay(draft.at) : '',
            !!draft.score,
            offer.live?.version ?? null,
          )}
        </Text>
      </View>
    </View>
  );
}

/** For everyone who can't change it: the live version, and that someone is working on a new one. */
function ReadOnly({ offer }: { offer: MainOffer }) {
  return (
    <>
      <DraftBanner offer={offer} />
      {offer.live ? (
        <LiveOffer live={offer.live} direction={offer.direction} comesWith={offer.comesWith} />
      ) : (
        <Notice testID="main-offer-nothing-live">{PW.nothingLive}</Notice>
      )}
    </>
  );
}

/** Where a missing box is filled in: the scored parts here (Edit it myself), the method's steps and the rest on the web. */
const editsHere = (m: MissingPart): ScoredPart | null => {
  const step = offerStepOf(m.path);
  return m.path !== 'method.steps' && (SCORED_PARTS as readonly string[]).includes(step)
    ? (step as ScoredPart)
    : null;
};

type Busy = 'score' | 'try' | 'live' | null;

/**
 * The Review step: the draft (or, with none, the live version) with its score, each part with a note and Keep, and the
 * direction, with the web's actions: Score my offer, Make a try, Go live and Use it anyway. What's typed stays across
 * the answers asked again after each; the notes and kept parts start from the latest try's, as on the web.
 */
function Review({
  workspaceId,
  offer,
  tries,
  onReload,
}: {
  workspaceId: string;
  offer: MainOffer;
  tries: readonly MainOfferTry[];
  onReload: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const calls = React.useMemo(() => mainOfferCalls(workspaceId), [workspaceId]);
  const source = offer.draft ?? offer.live!;
  const parts = source.parts;
  const score = offer.draft ? offer.draft.score : offer.live!.score;
  const missing: readonly MissingPart[] = offer.draft?.missing ?? [];
  const [notes, setNotes] = React.useState<MainOfferNotes>(tries[0]?.notes ?? {});
  const [keep, setKeep] = React.useState<ScoredPart[]>([...(tries[0]?.keep ?? [])]);
  const [direction, setDirection] = React.useState(offer.direction ?? '');
  const [busy, setBusy] = React.useState<Busy>(null);
  const [anyway, setAnyway] = React.useState(false);
  // The try just made, with the draft's score it's set beside: the draft's revision moves on as the try is made.
  const [made, setMade] = React.useState<{ t: MainOfferTry; before: typeof score } | null>(null);
  const nextTry = TW.tryName((tries[0]?.number ?? 0) + 1);

  /** A step of the builder, on the web: the niche, proof and the one line stay there (answered 3). */
  const openStep = (step: OfferStep) => void openOnWeb(builderPath(workspaceId, step));
  const edit = (part: ScoredPart) =>
    router.push(businessHref(workspaceId, `settings/main-offer-part?part=${part}`));
  const openMissing = (m: MissingPart) => {
    const part = editsHere(m);
    if (part) edit(part);
    else openStep(offerStepOf(m.path));
  };

  /** Shows why it didn't work; someone else's change to the draft asks for the offer again. */
  const failed = (e: unknown) => {
    toast.error(offerAiError(e));
    if (draftMoved(e)) onReload();
  };

  /** Keeps the draft (from the live version, with none yet), then the direction when it changed; the revision after. */
  async function persist(): Promise<number> {
    let revision = await draftRevision(calls, offer);
    const want = direction.trim();
    if (want !== (offer.direction ?? '').trim())
      revision = await calls.saveDirection(revision, want);
    return revision;
  }

  async function scoreNow() {
    setBusy('score');
    try {
      await calls.score(await persist());
      onReload();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  }

  /** A try of the whole offer, from the draft, the direction, the notes and the parts to keep. */
  async function makeTry() {
    setBusy('try');
    try {
      const revision = await persist();
      const said = Object.fromEntries(
        SCORED_PARTS.filter((p) => notes[p]?.trim()).map((p) => [p, notes[p]!.trim()]),
      );
      const out = await calls.makeTry(revision, said, keep);
      if (out.saved && out.try) setMade({ t: out.try, before: score });
      else toast.error(TW.tryMoved);
      onReload();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  }

  async function goLive(why?: string) {
    setBusy('live');
    try {
      const version = await calls.publish(offer.revision, why);
      setAnyway(false);
      toast.show(W.live(version));
      router.back();
    } catch (e) {
      failed(e);
      setBusy(null);
    }
  }

  if (made)
    return (
      <ScrollView className="flex-1" contentContainerClassName="p-4 pb-8">
        <TryReady
          made={made.t}
          draftScore={made.before}
          onCompare={() => void openOnWeb(`${builderPath(workspaceId, 'score')}&try=${made.t.id}`)}
          onBack={() => setMade(null)}
        />
      </ScrollView>
    );

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3.5 p-4 pb-8"
        contentContainerStyle={keyboard ? { paddingBottom: keyboard + 32 } : undefined}
        keyboardShouldPersistTaps="handled"
        testID="main-offer-review"
      >
        {offer.draft ? (
          <DraftBanner offer={offer} />
        ) : (
          <View className="rounded-menu bg-accent-soft px-3.5 py-3" testID="main-offer-live-only">
            <Text className="text-[13.5px] leading-[19px]">{PW.liveOnly(offer.live!.version)}</Text>
          </View>
        )}

        <Card className="gap-1.5 px-4 py-3.5">
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.46px] text-text-3">
            {TW.yourDraft}
          </Text>
          <Text className="text-[16px] leading-[24px]" testID="offer-line">
            {parts.line?.trim() || offerLineFrom(parts)}
          </Text>
        </Card>

        {missing.length ? <Missing missing={missing} onOpen={openMissing} /> : null}

        {score ? (
          <>
            <ScoreGlance score={score} />
            <View className="gap-1 pt-1">
              <Text className="text-lg font-semibold tracking-[-0.18px]" role="heading">
                {TW.eachPart}
              </Text>
              <Text className="text-[13.5px] leading-[19px] text-text-2">{TW.eachPartHint}</Text>
            </View>
            <View className="gap-2.5" testID="offer-parts">
              {SCORED_PARTS.map((p) => (
                <PartCard
                  key={p}
                  part={p}
                  parts={parts}
                  score={score}
                  defaultOpen={score.parts[p].score < MAIN_OFFER_BAR}
                  edits={{
                    note: notes[p] ?? '',
                    onNote: (n) => setNotes((ns) => ({ ...ns, [p]: n })),
                    kept: keep.includes(p),
                    onKeep: (k) =>
                      setKeep((ks) =>
                        k ? [...ks.filter((x) => x !== p), p] : ks.filter((x) => x !== p),
                      ),
                    onEdit: () => edit(p),
                  }}
                />
              ))}
            </View>
          </>
        ) : (
          <Card className="gap-1 px-4 py-3.5" testID="offer-not-scored">
            <Text className="font-semibold">{TW.notScored}</Text>
            <Text className="text-[13.5px] leading-[19px] text-text-2">{PW.notScoredHint}</Text>
          </Card>
        )}

        <DirectionBox
          direction={direction}
          onDirection={setDirection}
          notes={notes}
          keep={keep}
          nextTry={nextTry}
          busy={busy === 'try'}
          disabled={!!busy && busy !== 'try'}
          onMake={() => void makeTry()}
        />
      </ScrollView>

      {keyboard ? null : (
        <Footer
          live={!offer.draft}
          scored={!!score}
          clears={!!score && clearsBar(score)}
          missing={missing}
          nextTry={nextTry}
          busy={busy}
          onMissing={openMissing}
          onScore={() => void scoreNow()}
          onTry={() => void makeTry()}
          onLive={() => void goLive()}
          onAnyway={() => setAnyway(true)}
        />
      )}
      {score ? (
        <AnywaySheet
          open={anyway}
          onClose={() => setAnyway(false)}
          score={score}
          busy={busy === 'live'}
          onGo={(why) => void goLive(why)}
        />
      ) : null}
    </View>
  );
}

/** What the draft still needs before it can be scored and go live; each opens where it's filled in. */
function Missing({
  missing,
  onOpen,
}: {
  missing: readonly MissingPart[];
  onOpen: (m: MissingPart) => void;
}) {
  return (
    <Card className="gap-1 px-4 py-3" testID="offer-missing">
      <Text className="pb-1 text-[13.5px] font-medium">{W.stillNeeds}</Text>
      {missing.map((m) => (
        <Pressable
          key={m.path}
          role="link"
          onPress={() => onOpen(m)}
          className="min-h-11 flex-row items-center gap-2 active:opacity-70"
        >
          <Text className="flex-1 text-[14px] text-accent-text">{m.label}</Text>
          <Icon as={ChevronRight} className="size-4 text-text-3" />
        </Pressable>
      ))}
    </Card>
  );
}

/**
 * The bar at the bottom, as the web's footer: Score my offer before a score; Go live when every part clears and
 * nothing is missing; otherwise the first thing missing, or Use it anyway with Make a try. The live version, with no
 * draft, can only be tried again.
 */
function Footer({
  live,
  scored,
  clears,
  missing,
  nextTry,
  busy,
  onMissing,
  onScore,
  onTry,
  onLive,
  onAnyway,
}: {
  live: boolean;
  scored: boolean;
  clears: boolean;
  missing: readonly MissingPart[];
  nextTry: string;
  busy: Busy;
  onMissing: (m: MissingPart) => void;
  onScore: () => void;
  onTry: () => void;
  onLive: () => void;
  onAnyway: () => void;
}) {
  const first = missing[0];
  const others = (mine: Busy) => !!busy && busy !== mine;
  const tryButton = (
    <Button
      className="flex-1"
      loading={busy === 'try'}
      disabled={others('try')}
      onPress={onTry}
      testID="offer-make-try-foot"
    >
      {busy === 'try' ? TW.making(nextTry) : TW.makeTry(nextTry)}
    </Button>
  );
  return (
    <View
      className="flex-row gap-2.5 border-t border-border bg-card px-4 py-2.5"
      testID="offer-footer"
    >
      {live ? (
        tryButton
      ) : first ? (
        <Button className="flex-1" onPress={() => onMissing(first)} testID="offer-fill-in">
          {W.goTo(OFFER_STEP_WORDS[offerStepOf(first.path)].name)}
        </Button>
      ) : !scored ? (
        <Button
          className="flex-1"
          icon={Sparkles}
          loading={busy === 'score'}
          disabled={others('score')}
          onPress={onScore}
          testID="offer-score-it"
        >
          {busy === 'score' ? W.scoring : W.scoreIt}
        </Button>
      ) : clears ? (
        <Button
          className="flex-1"
          loading={busy === 'live'}
          disabled={others('live')}
          onPress={onLive}
          testID="offer-go-live"
        >
          {W.goLive}
        </Button>
      ) : (
        <>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={!!busy}
            onPress={onAnyway}
            testID="offer-use-anyway"
          >
            {W.useAnyway}
          </Button>
          {tryButton}
        </>
      )}
    </View>
  );
}
