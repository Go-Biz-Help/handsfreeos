/**
 * Correlation ids minted by this browser tab. The live-updates channel drops broadcasts that carry
 * one of them: the code that made the change already refreshed, so the echo would only double-fetch.
 */
const recent: string[] = [];
const MAX = 50;

export function mintCorrelationId(): string {
  const id = crypto.randomUUID();
  recent.push(id);
  if (recent.length > MAX) recent.splice(0, recent.length - MAX);
  return id;
}

export function isOwnRequest(correlationId: string | null | undefined): boolean {
  return !!correlationId && recent.includes(correlationId);
}
