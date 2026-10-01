/**
 * The money core (Milestone 9): the arithmetic, the formatters, the document states, numbering, the settings and
 * the words. Pure and browser-safe, so an estimate adds up the same on a screen, in an email and on the
 * customer's own page. Commands, queries and the providers are server-side.
 *
 * **Nothing here may import a database client.** `@hfos/core` is bundled into the browser, so one value
 * import of `sql` from `@hfos/db/client` drags the whole Postgres driver in and the web build fails on
 * `Can't resolve 'fs'` — which is exactly what `wallet-gate.ts` did until it was moved to `../server`. The
 * rule is easy to break because a type-only import of `Tx` is fine and looks identical.
 */
export * from './totals';
export * from './rates';
export * from './usage-keys';
export * from './wallet-ladders';
export * from './format';
export * from './status';
export * from './numbering';
export * from './settings';
export * from './words';
export * from './lists';
export * from './visit';
export * from './document-words';
export * from './wallet-words';
export * from './rcs-fees';
