/**
 * Playwright's route for Real Estate Agent (round four's spec), under the worker's test-route guard: its worker
 * module's `testRoutes`, which http/test-routes.ts registers only with the fake providers, never in production.
 *
 * POST /test/realestate/at-risk-since { workspaceId, dutyId, hours } says an at-risk duty has been at risk for so many
 * hours, so a browser test sees it go to the business's alert people at the next sweep without waiting a business
 * day. The duty must be at risk already (a sweep marked it); run the sweep after with /test/scheduled-jobs/run-due
 * and the dedupe key `<workspaceId>:realestate.sweep:<workspaceId>`.
 *
 * Round five: the stand-in e-signature service's page, `/test/realestate/esign/:id` (below).
 */
import { catalogAddon, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from '../../http/common';
import { escapeHtml } from '../../emails/templates';
import { deadEnd, shell } from '../../http/oauth';
import { workerMeta } from '../../services';
import { addonScope } from '../context';
import { checkByExternalId, standinAct, standinEnvelope, type StandinAct } from './esign/index';

const AtRiskSince = z.object({
  workspaceId: z.uuid(),
  dutyId: z.uuid(),
  hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
});

export function registerRealestateTestRoutes(app: FastifyInstance, deps: HttpDeps): void {
  registerStandinEsignRoutes(app, deps);
  app.post('/test/realestate/at-risk-since', async (req) => {
    const body = parseBody(AtRiskSince, req.body ?? {});
    const [row] = await asWorker(deps.db, { workspaceId: body.workspaceId }, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`update addon_realestate.duties
            set at_risk_since = now() - make_interval(hours => ${body.hours})
            where workspace_id = ${body.workspaceId} and id = ${body.dutyId}
              and at_risk_since is not null
            returning id`,
      ),
    );
    if (!row)
      throw HfosError.notFound(
        'That duty isn’t at risk yet. Run the sweep once it’s overdue, then try again.',
      );
    return { dutyId: row.id };
  });
}

/**
 * The stand-in e-signature service's page (./esign/standin.ts): where an agent "places the fields and sends it",
 * and a browser test plays the signers. Each press tells the business at once, as DocuSign's updates would.
 */
export function registerStandinEsignRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const pageUrl = (id: string, back: string | null) =>
    `/test/realestate/esign/${encodeURIComponent(id)}${back ? `?return=${encodeURIComponent(back)}` : ''}`;
  // Only back to the app itself.
  const backOf = (q: unknown) => {
    const r = (q as Record<string, unknown> | undefined)?.['return'];
    return typeof r === 'string' && r.startsWith(`${deps.webUrl}/`) ? r : null;
  };

  app.get<{ Params: { id: string } }>('/test/realestate/esign/:id', async (req, reply) => {
    const e = standinEnvelope(req.params.id);
    if (!e) return deadEnd(reply, 404, 'Nothing here', 'The stand-in has forgotten that one.');
    const back = backOf(req.query);
    const name = e.provider === 'docusign' ? 'DocuSign' : 'Dotloop';
    const button = (act: StandinAct, label: string) =>
      `<form method="post" action="${escapeHtml(`${pageUrl(e.id, back).replace(/\?.*$/, '')}/${act}${back ? `?return=${encodeURIComponent(back)}` : ''}`)}" style="display:inline"><button data-testid="standin-esign-${act}" style="font: inherit; font-weight: 600; padding: 8px 14px; margin: 0 8px 8px 0; border-radius: 8px; border: 1px solid #2d69d8; background: #2d69d8; color: #fff; cursor: pointer;">${escapeHtml(label)}</button></form>`;
    const buttons =
      e.state === 'draft'
        ? button('send', 'Send it')
        : e.state === 'sent'
          ? button('sign', 'Everyone signed') + button('decline', 'A signer declines')
          : '';
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        shell(
          `Stand-in ${name}`,
          `<p style="font-size: 12px; color: #5b616a; margin: 0 0 6px;">Stand-in ${escapeHtml(name)}, for trying HandsFreeOS</p>` +
            `<h1 style="font-size: 18px; margin: 0 0 6px;" data-testid="standin-esign-subject">${escapeHtml(e.subject)}</h1>` +
            `<p style="font-size: 14px; margin: 0 0 14px;">${escapeHtml(e.documentName)} · <span data-testid="standin-esign-state">${escapeHtml(e.state)}</span></p>` +
            `<ul style="font-size: 14px; padding-left: 18px; margin: 0 0 16px;">${e.signers
              .map(
                (s) =>
                  `<li>${s.order}. ${escapeHtml(s.name)} &lt;${escapeHtml(s.email)}&gt;: ${escapeHtml(s.state)}</li>`,
              )
              .join('')}</ul>` +
            buttons +
            (back
              ? `<p style="margin: 12px 0 0;"><a data-testid="standin-esign-back" href="${escapeHtml(back)}" style="color: #2d69d8; font-weight: 600; text-decoration: none;">Back to HandsFreeOS</a></p>`
              : ''),
        ),
      );
  });

  app.post<{ Params: { id: string; act: string } }>(
    '/test/realestate/esign/:id/:act',
    async (req, reply) => {
      const act = req.params.act as StandinAct;
      const e = standinEnvelope(req.params.id);
      if (!e || !['send', 'sign', 'decline'].includes(act) || !standinAct(e.id, act))
        return deadEnd(reply, 409, 'That can’t happen now', 'Go back and refresh the page.');
      // The business hears at once, as it would from DocuSign's updates (Dotloop's stand-in says nothing).
      const [on] = await asWorker(deps.db, { workspaceId: e.workspaceId }, (tx) =>
        rows<{ organization_id: string; generation: number }>(
          tx,
          sql`select private.workspace_organization(i.workspace_id) as organization_id, i.generation
              from app.addon_installations i
              where i.workspace_id = ${e.workspaceId} and i.addon_id = 'realestate' and i.state = 'enabled'`,
        ),
      );
      if (on)
        await checkByExternalId(
          addonScope(
            deps,
            catalogAddon('realestate'),
            { workspaceId: e.workspaceId, organizationId: on.organization_id },
            on.generation,
            workerMeta(),
          ),
          e.id,
        );
      const back = backOf(req.query);
      return reply.redirect(act === 'send' && back ? back : pageUrl(e.id, back), 303);
    },
  );
}
