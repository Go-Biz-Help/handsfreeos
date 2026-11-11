/**
 * Where a business's domain has its mail and its DNS, for the business email step: the names its MX records and its
 * name servers point at. Core reads them (`mailHostOf`, `dnsHostOf`) into "none", "google", "godaddy" and so on.
 */
import { promises as dns } from 'node:dns';

export const systemNameServers = (domain: string): Promise<string[]> => dns.resolveNs(domain);

/** Answers that mean there are none. Anything else (a timeout, a failing server) means nobody can tell. */
const ABSENT = new Set(['ENOTFOUND', 'ENODATA']);

/** The answers: [] when DNS says there are none, null when it didn't answer. */
export async function lookUp<T>(fn: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await fn();
  } catch (e) {
    return ABSENT.has(String((e as { code?: unknown }).code ?? '')) ? [] : null;
  }
}
