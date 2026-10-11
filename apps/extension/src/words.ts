/**
 * Plain words the extension's jobs and pages share, with no page to draw on: the background's jobs read these too.
 */

/** "1 comment", "6 comments"; "1 person", "6 people" with the plural given. */
export function counted(count: number, thing: string, things = `${thing}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? thing : things}`;
}
