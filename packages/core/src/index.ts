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
export * from './messaging/sms';
export * from './messaging/quiet-hours';
export * from './messaging/bridge';
export * from './schemas/assistant';
export * from './assistant/tools';
export * from './assistant/consent';
export * from './calendar/index';
export * from './workflows/index';
export * from './knowledge/index';
export * from './ai-team/index';
export * from './chat/index';
export * from './attention/index';
export * from './money/index';
