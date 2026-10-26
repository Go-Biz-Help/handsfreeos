/**
 * @hfos/core — browser-safe domain layer: permissions, error shape, zod schemas and their types.
 * Commands, queries and the kernel live in '@hfos/core/server'.
 */
export * from './permissions';
export * from './errors';
export * from './intl/index';
export * from './industries';
export * from './mobile';
export * from './push';
export * from './meetings/settings';
export * from './meetings/review';
export * from './meetings/google';
export * from './schemas/index';
export { slugify } from './slug';
export const CORE_VERSION = '0.1.0';
export * from './crm/phone';
export * from './crm/import-mapping';
export * from './crm/not-applied';
// The CRM screens' shared words and working out (M10 step 15).
export * from './crm/format';
export * from './crm/record-words';
export * from './crm/timeline-words';
export * from './crm/attribution-words';
// Which emails are Indeed telling a business somebody applied, and what they say without the AI (funnels).
export * from './crm/indeed';
export * from './crm/pipeline-words';
export * from './crm/task-words';
export * from './crm/file-words';
export * from './crm/synced';
export * from './crm/contact-points';
export * from './crm/person-merge';
export * from './crm/picked-contact';
// The search text a phone works out for itself: its pickers and its offline search.
export * from './crm/search-text';
// Fields a business invents, and the kinds of records and relationships it makes up (0101).
export * from './crm/custom-fields';
export * from './relationships/index';
export * from './hosting/branded-paths';
export * from './messaging/consent';
export * from './messaging/a2p';
export * from './messaging/policies';
// A business's own policy or terms, given back with the texting section in place.
export * from './messaging/policy-update';
export * from './messaging/preflight';
export * from './messaging/sms';
export * from './messaging/rcs';
// Facebook Messenger and Instagram direct messages (20261025000200).
export * from './messaging/social';
// Facebook and Instagram lead ads' answers, consent boxes and access (funnels).
export * from './messaging/lead-ads';
export * from './messaging/video-link';
export * from './messaging/file-link';
export * from './messaging/quiet-hours';
export * from './messaging/bridge';
export * from './messaging/number-import';
export * from './schemas/assistant';
export * from './assistant/tools';
export * from './assistant/tools-main-offer';
export * from './assistant/consent';
// How the business is set up, and where each part of it lives (M12).
export * from './assistant/settings-map';
export * from './assistant/places-map';
// The Assistant's words, and the settings people have of their own (M10 step 17).
export * from './assistant/words';
export * from './account/settings-words';
export * from './account/view-as-words';
export * from './account/sign-in';
export * from './account/extension-sign-in';
// The moments a person is told about, push beside email, for both apps and settings search.
export * from './account/notification-rows';
// The side menu, as each person arranges it.
export * from './account/menu';
export * from './calendar/index';
export * from './workflows/index';
// Forms, surveys and quizzes (M15).
export * from './forms/index';
export * from './knowledge/index';
export * from './main-offer/parts';
export * from './main-offer/examples';
export * from './main-offer/assist';
export * from './main-offer/words';
// Partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2): their settings and how they earn.
export * from './partners/index';
export * from './writing';
export * from './ai-team/index';
// Funnels: the steps the AI teammate takes each person through.
export * from './funnels/index';
// The ways a lead comes in, for a funnel's "came in by" rule (teammate funnels).
export { INTAKE_KINDS, INTAKE_NAMES, type IntakeKind } from './crm/intake-kinds';
// Quick setup: a few simple questions that set up a working AI teammate.
export * from './ai-setup/index';
export * from './chat/index';
export * from './attention/index';
// Settings → Automations: the catalog and the switches it owns.
export * from './automations/index';
export * from './onboarding/index';
// The guided setup a new business goes through, from its address to its AI teammate.
export * from './onboarding-setup/index';
// The business's logo and colour, on its booking page, website chat, invoices and emails.
export * from './look/index';
// The AI keeps customers' tags and details up to date (0107).
export * from './contact-ai/index';
export * from './money/index';
export * from './inbox/index';
export * from './migrations/index';
// Ideas, the roadmap and What's new (0102).
export * from './ideas/index';
// Talking out loud: the Assistant's voice mode and the test console's calls.
export * from './voice/index';
export * from './voice/phone-audio';
// Add-ons: what one declares, the catalogue, the lifecycle, and what a business can do (docs/addon-architecture.md).
export * from './addons/index';
// The support desk (M13): its words, sections and queue, for the web's /admin and the phone's Support desk.
export * from './support/index';
// Check-ins (round six): the limits, the business's times, and the words both apps and the worker say.
export * from './safety';
export * from './safety-phone';
// Legal holds (round six): what a record on hold says, on both apps.
export * from './record-holds';
// The Deleted bin (20261027000400): what deleting for good says, on both apps.
export * from './bin-words';
// Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md): probes, ranking, marks, links and words.
export * from './search/index';
// Settings search: the Settings menu's pages and every setting on them, searched on the device (stage 6).
export * from './settings/index';
