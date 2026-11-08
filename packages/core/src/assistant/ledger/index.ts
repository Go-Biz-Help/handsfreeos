/**
 * The Assistant's checklist, one file per area of the app: every item on its screens, every level down, with how Ask
 * HandsFreeOS covers it, the fingerprint of each screen file when its items were checked, and the audit's gaps.
 * fingerprints.json is the screen files as they are now (`pnpm assistant:ledger` rewrites it, and so does every
 * deploy). Server-only: the API reads it for Admin → Assistant coverage, so no screen carries it.
 */
import type { LedgerCovered } from '../../schemas/assistant-ledger';
import home from './home.json';
import inbox from './inbox.json';
import customers from './customers.json';
import pipelineTasks from './pipeline-tasks.json';
import calendar from './calendar.json';
import money from './money.json';
import marketing from './marketing.json';
import documents from './documents.json';
import workflows from './workflows.json';
import aiTeam from './ai-team.json';
import knowledgeOffer from './knowledge-offer.json';
import ideasAddons from './ideas-addons.json';
import safetyTeam from './safety-team.json';
import settingsBusiness from './settings-business.json';
import settingsCalendars from './settings-calendars.json';
import settingsChannels from './settings-channels.json';
import settingsMoneyPartners from './settings-money-partners.json';
import myAccount from './my-account.json';
import agency from './agency.json';
import outreach from './outreach.json';
import realestateDeals from './realestate-deals.json';
import realestateRest from './realestate-rest.json';
import salescoach from './salescoach.json';
import socialcontent from './socialcontent.json';
import staff from './staff.json';
import publicLinks from './public-links.json';
import onboarding from './onboarding.json';
import fingerprints from './fingerprints.json';

export interface LedgerAreaFile {
  readonly area: string;
  readonly title: string;
  /** The day its items were last checked. */
  readonly checkedOn: string;
  /** Each file its items live in, with its fingerprint when they were checked. */
  readonly files: Readonly<Record<string, string>>;
  readonly items: readonly {
    readonly path: string;
    readonly kind: string;
    readonly file: string;
    readonly covered: LedgerCovered;
    readonly by: string;
  }[];
  readonly gaps: readonly {
    readonly id: string;
    readonly severity: string;
    readonly kind: string;
    readonly where: string;
    readonly gap: string;
    readonly fix: string;
    readonly status: string;
    readonly pr: number | null;
  }[];
}

/** Every area, in the order the audit walked the app. A test checks every file here is listed. */
export const LEDGER_AREAS = [
  home,
  inbox,
  customers,
  pipelineTasks,
  calendar,
  money,
  marketing,
  documents,
  workflows,
  aiTeam,
  knowledgeOffer,
  ideasAddons,
  safetyTeam,
  settingsBusiness,
  settingsCalendars,
  settingsChannels,
  settingsMoneyPartners,
  myAccount,
  agency,
  outreach,
  realestateDeals,
  realestateRest,
  salescoach,
  socialcontent,
  staff,
  publicLinks,
  onboarding,
] as unknown as readonly LedgerAreaFile[];

/** Every screen file, and every file an area lists, with its fingerprint now. */
export const LEDGER_FINGERPRINTS: Readonly<Record<string, string>> = fingerprints;
