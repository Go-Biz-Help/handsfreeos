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

/**
 * The answers, and whether DNS said there is no such name at all (not just no records of this kind): the guided
 * email setup tells someone their website name looks misspelled. `missing` is false when DNS didn't answer.
 */
export async function lookUpName<T>(
  fn: () => Promise<T[]>,
): Promise<{ found: T[] | null; missing: boolean }> {
  try {
    return { found: await fn(), missing: false };
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '');
    return { found: ABSENT.has(code) ? [] : null, missing: code === 'ENOTFOUND' };
  }
}
