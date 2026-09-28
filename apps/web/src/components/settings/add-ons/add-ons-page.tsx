'use client';
/**
 * Settings → Add-ons (0108): what this business has added to HandsFreeOS and where each one stands, what it could
 * add, and what's coming. Owners and admins (`addons.manage`) install, turn on and off and uninstall; only owners
 * (`addons.purge`) delete an add-on's data, after typing its name (the owner's decisions, 2026-09-28).
 *
 * Everything shown comes from the page's one look-up (`addon.list`), handed down again whenever the page is read
 * again: after this person's own moves, when a teammate or the worker moves an add-on (the shell reads the page
 * again on every `addon` event), and every few seconds while one is on its way somewhere, in case the live channel
 * is down. The words for states, moves and checks are the ones the phone uses (`@hfos/core`'s add-on words).
 */
import {
  ADDON_CATALOG,
  ADDON_PAGE_WORDS,
  addonBlockedWords,
  addonMovedLine,
  addonMovesFor,
  findAddon,
  isBusyState,
  isInstalledState,
  type InstallationState,
  type LifecycleAction,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { addonNavItems, menuAddons } from '@/components/shell/nav-links';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { AddonList, InstalledAddon } from '@/lib/api/types';
import { AddonCard, type CardCapability } from './addon-card';
import { AddonSettingsSheet, hasSettings } from './addon-settings-sheet';
import {
  AskMoveDialog,
  ConfirmMoveDialog,
  type MakeMove,
  type MoveTarget,
  type TakingAction,
} from './move-dialogs';
import { addonName } from './words';

/** The rules a move comes back with when other add-ons have to move with it: asked about, then sent again. */
const ASK_RULES: ReadonlySet<string> = new Set(['addon_needs', 'addon_required_by']);
const W = ADDON_PAGE_WORDS;
const sectionTitle = 'text-lg font-semibold leading-[1.3] tracking-[-0.005em]';

/** The add-ons a refusal asks about (`details.addons`). */
const askedAbout = (details: unknown): string[] => {
  const addons = (details as { addons?: unknown } | null)?.addons;
  return Array.isArray(addons) ? addons.filter((a): a is string => typeof a === 'string') : [];
};

/** A move's request: one path per move, all taking the same body. */
function send(
  action: Exclude<LifecycleAction, 'purge'>,
  body: { workspaceId: string; addonId: string; include: string[] },
) {
  const api = apiBrowser();
  switch (action) {
    case 'install':
      return api.POST('/v1/commands/addon.install', { body });
    case 'enable':
      return api.POST('/v1/commands/addon.enable', { body });
    case 'disable':
      return api.POST('/v1/commands/addon.disable', { body });
    case 'uninstall':
      return api.POST('/v1/commands/addon.uninstall', { body });
  }
}

function Section({
  title,
  description,
  testId,
  children,
}: {
  title: string;
  description?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  const id = `${testId}-title`;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id} data-testid={testId}>
      <div>
        <h2 id={id} className={sectionTitle}>
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-[70ch] text-[13px] text-text-2">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function AddonsSettings({
  workspaceId,
  list,
  canPurge,
  focus,
}: {
  workspaceId: string;
  list: AddonList;
  /** Only owners delete an add-on's data (`addons.purge`). */
  canPurge: boolean;
  /** An add-on to bring into view (`?addon=`, from Home's suggestion). */
  focus: string | null;
}) {
  const router = useRouter();
  const { addons: running, permissions } = useWorkspaceShell();
  const [pending, setPending] = useState<{ addonId: string; action: LifecycleAction } | null>(null);
  const [confirm, setConfirm] = useState<(MoveTarget & { action: TakingAction }) | null>(null);
  const [ask, setAsk] = useState<
    (MoveTarget & { action: LifecycleAction; include: string[]; message: string }) | null
  >(null);
  const [settingsOf, setSettingsOf] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(focus);

  const stateOf = (id: string): InstallationState | null =>
    list.installed.find((i) => i.addonId === id)?.state ?? null;
  // What the server says this business could add now (available, free, and everything it needs can come too).
  const installable = new Set(list.capabilities.installable.map((c) => c.provider));
  const installedIds = new Set(list.installed.map((i) => i.addonId));
  const here = [...list.installed].sort(
    (a, b) =>
      Number(!isInstalledState(a.state)) - Number(!isInstalledState(b.state)) ||
      a.name.localeCompare(b.name),
  );
  const toAdd = list.catalog.filter(
    (c) => c.status === 'available' && !installedIds.has(c.addonId),
  );
  const coming = list.catalog.filter((c) => c.status === 'planned' && !installedIds.has(c.addonId));
  const moving = list.installed.some((i) => isBusyState(i.state));
  const places = addonNavItems(workspaceId, permissions, menuAddons(running));

  // Installing, uninstalling and deleting finish on their own within seconds: check again every few, in case the
  // live channel is down (it usually gets there first).
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [moving, router]);

  // Opened from Home's suggestion: bring that add-on into view and mark it for a few seconds.
  useEffect(() => {
    if (!focus) return;
    document
      .getElementById(`addon-${focus}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(timer);
  }, [focus]);

  /** What each of an add-on's capabilities is: its manifest's words, or the server's for one this build lacks. */
  const capabilitiesOf = (id: string): CardCapability[] => {
    const m = findAddon(ADDON_CATALOG, id);
    if (m)
      return m.capabilities.map((c) => ({ id: c.id, label: c.label, description: c.description }));
    const { current, restricted, turnedOff, installable: canAdd, planned } = list.capabilities;
    return [...current, ...restricted, ...turnedOff, ...canAdd, ...planned].filter(
      (c) => c.provider === id,
    );
  };

  const move: MakeMove = async (target, action, include, confirmName) => {
    setPending({ addonId: target.addonId, action });
    try {
      const out =
        action === 'purge'
          ? unwrap(
              await apiBrowser().POST('/v1/commands/addon.purge', {
                body: { workspaceId, addonId: target.addonId, confirmName: confirmName ?? '' },
              }),
            )
          : unwrap(
              await send(action, { workspaceId, addonId: target.addonId, include: [...include] }),
            );
      setConfirm(null);
      setAsk(null);
      const said = addonMovedLine(target.addonId, target.name, action, out.moved, addonName);
      if (said) toast.success(said);
      router.refresh();
      return null;
    } catch (e) {
      // "…needs Property Management. Turn it on too?": asked once, then sent again with the ones agreed to.
      if (e instanceof ApiError && e.rule && ASK_RULES.has(e.rule)) {
        setConfirm(null);
        setAsk({
          ...target,
          action,
          include: [...new Set([...include, ...askedAbout(e.details)])],
          message: e.message,
        });
        return null;
      }
      // The name typed didn't match: said under the field, where it was typed.
      if (action === 'purge' && e instanceof ApiError && e.code === 'validation')
        return fieldErrors(e)['confirmName'] ?? errorMessage(e);
      toast.error(errorMessage(e));
      setConfirm(null);
      setAsk(null);
      // It may have moved since the page was drawn (busy, already installed, turned off): show where it is now.
      router.refresh();
      return null;
    } finally {
      setPending(null);
    }
  };

  function start(target: MoveTarget, action: LifecycleAction) {
    // Taking something away is confirmed first, with what else it would change.
    if (action === 'disable' || action === 'uninstall' || action === 'purge')
      setConfirm({ ...target, action });
    else void move(target, action, []);
  }

  // An add-on's settings are open only while it's on: they close when it's turned off, and stay closed after.
  const settingsAddon =
    settingsOf && stateOf(settingsOf) === 'enabled' && running.includes(settingsOf)
      ? (findAddon(ADDON_CATALOG, settingsOf) ?? null)
      : null;
  useEffect(() => {
    if (settingsOf && !settingsAddon) setSettingsOf(null);
  }, [settingsOf, settingsAddon]);

  const installedCard = (i: InstalledAddon) => {
    const m = findAddon(ADDON_CATALOG, i.addonId);
    const on = i.running;
    const canInstall = installable.has(i.addonId);
    const target = { addonId: i.addonId, name: i.name };
    const first = on ? places.find((p) => p.key.startsWith(`addon:${i.addonId}:`)) : undefined;
    // Back again after it was removed: paid ones, and ones only support hands out (beta), come from support.
    const away = i.state === 'uninstalled' || i.state === 'purged';
    const note =
      away && !canInstall && !i.retired
        ? m?.billing.model === 'paid' && i.status === 'available'
          ? W.paid
          : i.status === 'beta' || i.status === 'built'
            ? W.support
            : null
        : null;
    return (
      <li key={i.addonId}>
        <AddonCard
          addonId={i.addonId}
          name={i.name}
          summary={i.summary}
          manifest={m}
          capabilities={capabilitiesOf(i.addonId)}
          place="installed"
          installed={i}
          moves={addonMovesFor(i.state, {
            manage: true,
            purge: canPurge,
            installable: canInstall,
            retired: i.retired,
          })}
          pending={pending?.addonId === i.addonId ? pending.action : null}
          running={on}
          highlight={highlight === i.addonId}
          open={first?.href ?? null}
          onMove={(action) => start(target, action)}
          onSettings={
            m && on && i.state === 'enabled' && hasSettings(m)
              ? () => setSettingsOf(i.addonId)
              : undefined
          }
          note={note}
        />
      </li>
    );
  };

  const availableCard = (c: AddonList['catalog'][number]) => {
    const m = findAddon(ADDON_CATALOG, c.addonId);
    const canInstall = installable.has(c.addonId);
    const note = canInstall
      ? null
      : m?.billing.model === 'paid'
        ? W.paid
        : ((m ? addonBlockedWords(ADDON_CATALOG, m, stateOf, (id) => installable.has(id)) : null) ??
          W.cantAdd);
    return (
      <li key={c.addonId}>
        <AddonCard
          addonId={c.addonId}
          name={c.name}
          summary={c.summary}
          manifest={m}
          capabilities={capabilitiesOf(c.addonId)}
          place="available"
          installed={null}
          moves={canInstall ? ['install'] : []}
          pending={pending?.addonId === c.addonId ? pending.action : null}
          running={false}
          highlight={highlight === c.addonId}
          open={null}
          onMove={(action) => start({ addonId: c.addonId, name: c.name }, action)}
          note={note}
        />
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-7" data-testid="addons-settings">
      <p className="max-w-[80ch] text-[13.5px] text-text-2">{W.intro}</p>

      <Section title={W.inBusiness} testId="addons-installed">
        {here.length ? (
          <ul className="flex flex-col gap-3">{here.map(installedCard)}</ul>
        ) : (
          <div data-testid="addons-installed-empty">
            <EmptyState title={W.noneHereTitle} dashed>
              {W.noneHere}
            </EmptyState>
          </div>
        )}
      </Section>

      <Section
        title={W.available}
        description={toAdd.length ? W.availableDetail : undefined}
        testId="addons-available"
      >
        {toAdd.length ? (
          <ul className="flex flex-col gap-3">{toAdd.map(availableCard)}</ul>
        ) : (
          <div data-testid="addons-available-empty">
            <EmptyState title={W.noneToAddTitle} dashed>
              {W.noneToAdd}
            </EmptyState>
          </div>
        )}
      </Section>

      {coming.length ? (
        <Section title={W.comingSoon} description={W.comingSoonDetail} testId="addons-planned">
          <ul className="flex flex-col gap-3">
            {coming.map((c) => (
              <li key={c.addonId}>
                <AddonCard
                  addonId={c.addonId}
                  name={c.name}
                  summary={c.summary}
                  manifest={findAddon(ADDON_CATALOG, c.addonId)}
                  capabilities={capabilitiesOf(c.addonId)}
                  place="planned"
                  installed={null}
                  moves={[]}
                  pending={null}
                  running={false}
                  highlight={highlight === c.addonId}
                  open={null}
                  onMove={() => {}}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <ConfirmMoveDialog
        workspaceId={workspaceId}
        target={confirm}
        busy={pending !== null}
        onClose={() => setConfirm(null)}
        onMove={move}
      />
      <AskMoveDialog ask={ask} busy={pending !== null} onClose={() => setAsk(null)} onMove={move} />
      <AddonSettingsSheet
        workspaceId={workspaceId}
        addon={settingsAddon}
        onClose={() => setSettingsOf(null)}
        onTurnedOff={() => {
          setSettingsOf(null);
          router.refresh();
        }}
      />
    </div>
  );
}
