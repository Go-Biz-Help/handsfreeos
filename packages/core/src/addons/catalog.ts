/**
 * The add-on catalogue: every add-on HandsFreeOS knows about, built or planned, as its manifest. This is the one
 * list the kernel, the lifecycle commands, the screens and the AI read; nothing else keeps its own.
 *
 * Adding an add-on is one line here (browser-safe manifest), one in `./server-modules.ts` (its commands and queries)
 * and, when it has them, one in the worker's and the web's lists — `pnpm addon:new <id>` writes all of them. A
 * `planned` add-on is a manifest with no code: it lets "what is coming" be answered without ever being offered.
 *
 * Kept deliberately explicit: no add-on registers itself as a side effect of being imported (the package is
 * `sideEffects: false`), so what ships is exactly what is listed.
 */
import type { Catalog } from './graph';

export const ADDON_CATALOG: Catalog = [];
