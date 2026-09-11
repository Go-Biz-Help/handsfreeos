/**
 * @hfos/core — browser-safe domain layer: permissions, error shape, zod schemas and their types.
 * Commands, queries and the kernel live in '@hfos/core/server'.
 */
export * from './permissions';
export * from './errors';
export * from './schemas/index';
export { slugify } from './slug';
export const CORE_VERSION = '0.1.0';
