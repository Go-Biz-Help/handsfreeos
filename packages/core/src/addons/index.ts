/**
 * Add-ons, browser-safe: what an add-on declares, the catalogue, the dependency graph, the lifecycle's moves, the
 * capability sets, the recommendation rules and the one suggestion Home may show. The server half (defining an add-on's commands, composing the
 * registry) is in `./server`, exported from '@hfos/core/server'. See docs/addon-architecture.md.
 */
export * from './manifest';
export * from './lifecycle';
export * from './graph';
export * from './capabilities';
export * from './plan';
export * from './recommend';
export * from './suggest';
export * from './catalog';
