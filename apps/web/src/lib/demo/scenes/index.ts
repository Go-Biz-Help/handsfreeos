import type { DemoState } from '../state';
import type { DemoWorld } from '../world';
import { ADDON_SCENES } from './addons';
import { ASK_DO_SCENES } from './ask-do';
import { ASK_LOOK_SCENES } from './ask-look';
import { talkFromTheTruck } from './ask-voice';
import { businessSetup } from './business-setup';
import { busyCall } from './busy-call';
import { CALENDAR_MONEY_SCENES } from './calendar-money';
import { CALLS_COACH_SCENES } from './calls-coach';
import { DAY_ONE_SCENES } from './day-one';
import { GROWTH_SCENES } from './growth';
import { leadText } from './lead-text';
import { moneyOwed } from './money-owed';
import { myDay } from './my-day';
import { PAPERWORK_CALL_SCENES } from './paperwork-calls';
import { priceQuestion } from './price-question';
import { quoteToInvoice } from './quote-to-invoice';
import { reviewRequests } from './review-requests';
import { SETUP_SCENES } from './setup';
import { TEAMMATE_CHANNEL_SCENES } from './teammate-channels';
import { TEAMMATE_SALES_SCENES } from './teammate-sales';
import { TEAMMATE_VISIT_SCENES } from './teammate-visits';
import { textCampaign } from './text-campaign';
import { upsetCustomer } from './upset-customer';
import { WEBINAR_SEARCH_SCENES } from './webinar-search';
import { websiteChat } from './website-chat';
import type { DemoScene } from './types';

export type { DemoPlayer, DemoScene, DemoStep } from './types';
export { SCENE_KIND_LABEL } from './types';

/** Every scene, in the presentation's order. */
export const DEMO_SCENES: readonly DemoScene[] = [
  leadText,
  busyCall,
  websiteChat,
  priceQuestion,
  upsetCustomer,
  quoteToInvoice,
  textCampaign,
  businessSetup,
  moneyOwed,
  myDay,
  reviewRequests,
  ...TEAMMATE_VISIT_SCENES,
  ...TEAMMATE_SALES_SCENES,
  ...TEAMMATE_CHANNEL_SCENES,
  ...CALENDAR_MONEY_SCENES,
  ...PAPERWORK_CALL_SCENES,
  ...DAY_ONE_SCENES,
  ...GROWTH_SCENES,
  ...WEBINAR_SEARCH_SCENES,
  ...CALLS_COACH_SCENES,
  ...ADDON_SCENES,
  ...SETUP_SCENES,
  ...ASK_LOOK_SCENES,
  ...ASK_DO_SCENES,
  talkFromTheTruck,
].sort((a, b) => a.number - b.number);

export const findScene = (id: string) => DEMO_SCENES.find((s) => s.id === id) ?? null;

/**
 * The business Admin → Demo player opens, as the founder working in it as its owner: the made-up home-services
 * business that apps/worker/scripts/seed-demo.ts writes for app-store reviewers. Found by this name, so it must match
 * the seed's `BUSINESS`. Nothing a scene does is saved, so playing there leaves the reviewers' business as it was.
 */
export const DEMO_BUSINESS = 'Bright Path Home Services';

/** A scene's voiceover as one script, to paste into a teleprompter or a video editor. */
export const voiceoverScript = (scene: DemoScene): string =>
  [
    `Scene ${scene.number}: ${scene.title}`,
    ...scene.steps.map((step, i) => `${i + 1}. ${step.label}\n${step.voiceover}`),
  ].join('\n\n');

/** What the scene has made up after the steps that have run, for answers in `workspaceId`. */
export function buildWorld(state: DemoState, workspaceId: string): DemoWorld | null {
  const scene = findScene(state.scene);
  if (!scene) return null;
  const world: DemoWorld = {
    state,
    workspaceId,
    conversations: [],
    campaigns: [],
    estimates: [],
    invoices: [],
    services: [],
    lessons: [],
    leads: [],
    visits: [],
    google: { connected: false, busy: [] },
    documents: [],
    referrals: [],
    answer: null,
    cards: {},
    chat: [],
    confirmed: [],
    teammateAutomatic: false,
    reviews: [],
    reviewsConnected: false,
    offers: [],
    imports: [],
    notes: [],
    coach: null,
    setup: null,
    outreach: [],
    tasks: [],
  };
  scene.setup?.(world, state.startedAt);
  state.steps.forEach((offset, i) => scene.steps[i]?.change?.(world, state.startedAt + offset));
  return world;
}
