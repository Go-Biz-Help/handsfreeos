/**
 * Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md), browser-safe: what a search looks for, how hits rank,
 * where they matched, where they open, what the dropdown shows and every word, for the server, the web and the phone.
 * The server's half (`search/server`) is exported from '@hfos/core/server' only.
 */
export * from './fold';
export * from './words';
export * from './kinds';
export * from './probes';
export * from './rank';
export * from './snippet';
export * from './close';
export * from './href';
export * from './dropdown';
export * from './lines';
export * from './explain';
export * from './copy';
