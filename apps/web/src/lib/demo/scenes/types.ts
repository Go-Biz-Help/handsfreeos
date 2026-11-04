import type { DemoWorld } from '../world';

/**
 * One step of a scene: a line in the side menu, what it makes up (`change`, run on the server and in the browser
 * alike), and what the player does on screen (`run`, the browser only). The change lands before the run, so a
 * page the run opens or refreshes already shows it.
 */
export interface DemoStep {
  /** The side menu's line: what happens next. */
  readonly label: string;
  /** A line for the presenter, under the label. */
  readonly say?: string;
  readonly change?: (world: DemoWorld, at: number) => void;
  /** What this tab hears changed afterwards (entity types), so the screens on show fetch again. */
  readonly live?: readonly string[];
  readonly run?: (player: DemoPlayer) => Promise<void>;
}

export interface DemoScene {
  readonly id: string;
  /** Its number in the presentation's list. */
  readonly number: number;
  readonly title: string;
  /** Which AI it shows. */
  readonly kind: 'teammate' | 'assistant';
  /** Where the first step starts, in the business (e.g. `inbox`). */
  readonly startsOn: string;
  /** The made-up records it starts with. */
  readonly setup?: (world: DemoWorld, at: number) => void;
  readonly steps: readonly DemoStep[];
}

/** What a step's `run` can do on screen. Each waits for what it touches to be there. */
export interface DemoPlayer {
  readonly workspaceId: string;
  /** The presenter, whose name a reply they type signs with. */
  readonly me: { readonly id: string; readonly name: string };
  /** Opens a page of the business (`inbox/<id>`), as a click on a link would. */
  go(path: string): Promise<void>;
  /** Moves the pointer to the first match (a CSS selector, or `@id` for a data-testid) and clicks it. */
  click(target: string): Promise<void>;
  /** Points at it without clicking. */
  point(target: string): Promise<void>;
  /** Points at Ask HandsFreeOS in the menu and opens it on a new chat. */
  openAssistant(): Promise<void>;
  /** Types the question in Ask HandsFreeOS (opening it first if it's closed) and sends it. */
  ask(question: string): Promise<void>;
  /** Types into a box on the page (a textarea or an input), a letter at a time, without sending it. */
  type(target: string, text: string): Promise<void>;
  /** Tells this tab's screens these entity types changed, so they fetch again (after a run's own click). */
  refresh(entityTypes: readonly string[]): void;
  /** Waits for a match to show (ms; 8 seconds unless given). */
  waitFor(target: string, ms?: number): Promise<Element>;
  wait(ms: number): Promise<void>;
}
