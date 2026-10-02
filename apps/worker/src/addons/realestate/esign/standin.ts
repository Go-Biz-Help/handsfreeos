/**
 * The stand-in e-signature service (round five, step 7): what DocuSign and Dotloop answer with in development and
 * tests (ADDON_CONNECTORS=fake), so nothing leaves the worker. It keeps what it's given in memory, as either one
 * would: a DocuSign stand-in says where signing stands; a Dotloop stand-in, like Dotloop, says nothing.
 *
 * Its page (`/test/realestate/esign/:id`, registered only with the stand-ins) is where an agent "places the fields
 * and sends it", and where a browser test plays the signers: Send it, Everyone signed, A signer declines. The signed
 * copy is the document as it was sent; DocuSign's stand-in adds a one-page certificate.
 */
import { randomUUID } from 'node:crypto';
import type { EsignSigner } from '@hfos/core/addons/realestate/esign';
import { EsignUnreachable, type EsignService, type EsignStanding } from './types';

export interface StandinEnvelope {
  readonly id: string;
  readonly provider: 'docusign' | 'dotloop';
  readonly workspaceId: string;
  readonly subject: string;
  readonly documentName: string;
  readonly bytes: Buffer;
  state: EsignStanding['state'];
  signers: EsignSigner[];
  sentAt: string | null;
  completedAt: string | null;
  voidReason: string | null;
  /** How many times it was sent again to whoever hadn't signed. */
  reminded: number;
}

const envelopes = new Map<string, StandinEnvelope>();

export const standinEnvelope = (id: string): StandinEnvelope | undefined => envelopes.get(id);
export const resetStandinEsign = () => envelopes.clear();

/** What a signer does on the stand-in's page. */
export type StandinAct = 'send' | 'sign' | 'decline';

/** Plays the stand-in: the agent sends it, or the signers sign or decline. False when that can't happen now. */
export function standinAct(id: string, act: StandinAct): boolean {
  const e = envelopes.get(id);
  if (!e) return false;
  const now = new Date().toISOString();
  if (act === 'send') {
    if (e.state !== 'draft') return false;
    e.state = 'sent';
    e.sentAt = now;
    e.signers = e.signers.map((s) => ({ ...s, state: 'sent' }));
    return true;
  }
  if (e.state !== 'sent') return false;
  if (act === 'sign') {
    e.state = 'completed';
    e.completedAt = now;
    e.signers = e.signers.map((s) => ({ ...s, state: 'signed', signedAt: now }));
  } else {
    e.state = 'declined';
    e.signers = e.signers.map((s, i) => (i === 0 ? { ...s, state: 'declined' } : s));
  }
  return true;
}

/** A one-page PDF with these lines on it (Latin-1, Helvetica). */
export function standinPdf(lines: readonly string[]): Buffer {
  const safe = lines.map((l) =>
    l
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
      .replace(/[\\()]/g, (c) => `\\${c}`),
  );
  const stream = `BT /F1 12 Tf 16 TL 72 720 Td ${safe.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const lost = () =>
  new EsignUnreachable('The stand-in e-signature service has forgotten that one. Send it again.');

export function createStandinEsign(opts: {
  readonly provider: 'docusign' | 'dotloop';
  readonly workspaceId: string;
  readonly publicUrl: string;
}): EsignService {
  const page = (id: string, returnUrl?: string) =>
    `${opts.publicUrl}/test/realestate/esign/${encodeURIComponent(id)}${
      returnUrl ? `?return=${encodeURIComponent(returnUrl)}` : ''
    }`;
  return {
    provider: 'standin',
    async prepare(req) {
      const id = `standin-${opts.provider}-${randomUUID()}`;
      envelopes.set(id, {
        id,
        provider: opts.provider,
        workspaceId: opts.workspaceId,
        subject: req.subject,
        documentName: req.document.name,
        bytes: req.document.bytes,
        state: 'draft',
        signers: req.signers.map((s) => ({ ...s, state: 'waiting', signedAt: null })),
        sentAt: null,
        completedAt: null,
        voidReason: null,
        reminded: 0,
      });
      // Like a Dotloop loop, the stand-in's page is always the same; DocuSign's is made each time.
      return { externalId: id, openUrl: opts.provider === 'dotloop' ? page(id) : null };
    },
    async openUrl(externalId, _state, returnUrl) {
      if (!envelopes.has(externalId)) throw lost();
      return page(externalId, returnUrl);
    },
    async status(externalId) {
      const e = envelopes.get(externalId);
      if (!e) throw lost();
      if (e.provider === 'dotloop') return null;
      return {
        state: e.state,
        signers: e.signers.map((s) => ({ ...s })),
        sentAt: e.sentAt,
        completedAt: e.completedAt,
      };
    },
    async copies(externalId) {
      const e = envelopes.get(externalId);
      if (!e) throw lost();
      return {
        signed: e.bytes,
        certificate:
          e.provider === 'docusign'
            ? standinPdf([
                'Certificate of Completion (stand-in)',
                '',
                `Envelope: ${e.id}`,
                `Subject: ${e.subject}`,
                `Document: ${e.documentName}`,
                '',
                ...e.signers.map((s) => `${s.name} <${s.email}>: signed ${s.signedAt ?? ''}`),
                '',
                'Made by the stand-in e-signature service for trying HandsFreeOS.',
              ])
            : null,
      };
    },
    async void(externalId, reason) {
      const e = envelopes.get(externalId);
      if (!e) return;
      e.state = 'voided';
      e.voidReason = reason;
    },
    ...(opts.provider === 'docusign'
      ? {
          async remind(externalId: string) {
            const e = envelopes.get(externalId);
            if (!e) throw lost();
            e.reminded += 1;
          },
        }
      : {}),
  };
}
