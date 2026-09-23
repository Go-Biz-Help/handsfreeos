/**
 * @hfos/core — browser-safe domain layer: permissions, error shape, zod schemas and their types.
 * Commands, queries and the kernel live in '@hfos/core/server'.
 */
export * from './permissions';
export * from './errors';
export * from './intl/index';
export * from './mobile';
export * from './push';
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
export * from './crm/pipeline-words';
export * from './crm/task-words';
export * from './crm/file-words';
export * from './crm/synced';
export * from './crm/contact-points';
// Fields a business invents, and the kinds of records and relationships it makes up (0101).
export * from './crm/custom-fields';
export * from './relationships/index';
export * from './hosting/branded-paths';
export * from './messaging/consent';
export * from './messaging/a2p';
export * from './messaging/policies';
export * from './messaging/preflight';
export * from './messaging/sms';
export * from './messaging/quiet-hours';
export * from './messaging/bridge';
export * from './schemas/assistant';
export * from './assistant/tools';
export * from './assistant/consent';
// How the business is set up, and where each part of it lives (M12).
export * from './assistant/settings-map';
// The Assistant's words, and the settings people have of their own (M10 step 17).
export * from './assistant/words';
export * from './account/settings-words';
// The side menu, as each person arranges it.
export * from './account/menu';
export * from './calendar/index';
export * from './workflows/index';
// Forms, surveys and quizzes (M15).
export * from './forms/index';
export * from './knowledge/index';
export * from './ai-team/index';
export * from './chat/index';
export * from './attention/index';
// Settings → Automations: the catalog and the switches it owns.
export * from './automations/index';
export * from './money/index';
export * from './inbox/index';
export * from './migrations/index';
// Ideas, the roadmap and What's new (0102).
export * from './ideas/index';
