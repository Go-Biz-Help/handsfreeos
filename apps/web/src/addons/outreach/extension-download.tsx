'use client';
/**
 * Getting the browser extension (docs/outreach.md, decisions 45, 71 and 83): HandsFreeOS hands out its own build, zipped
 * into `public/downloads` as this web app builds (apps/extension/scripts/download.mjs; its version and size come
 * through next.config.ts), unless the business gave its own link (`extensionLink`, Settings → General). Five steps,
 * each with a picture beside it: download and unzip, Developer mode, Load unpacked, pin it, then sign in. The setup's
 * install step shows them all with Stuck? under them; the Settings tab folds them away.
 */
import { CHROME_EXTENSIONS_URL, SETUP_WORDS as W } from '@hfos/core/addons/outreach/setup';
import { ChevronDown, Download, LifeBuoy } from 'lucide-react';
import type { ReactNode } from 'react';
import { CopyField } from '@/components/ui/copy-field';
import { INSTALL_PICTURES } from './install-pictures';

/** The build this web app hands out. Read whole: Next.js puts the values in as it builds. */
const VERSION = process.env.HFOS_EXTENSION_VERSION ?? '';
const BYTES = Number(process.env.HFOS_EXTENSION_BYTES) || null;
/**
 * The name stays the same from version to version, so a newer zip unzips over the same folder; the version on the end
 * only makes browsers fetch the newer one.
 */
const OURS = `/downloads/hfos-social.zip?v=${VERSION}`;

/** Where the extension downloads from: the business's own link, else HandsFreeOS's build. */
export function extensionHref(link: string | null): string {
  return link ?? OURS;
}

/** A step of its own: its number, its words and what to do, and its picture beside them. */
export function PictureStep({
  n,
  title,
  text,
  picture,
  children,
  last = false,
}: {
  n: number;
  title: string;
  text: string;
  picture: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <li
      className={`grid grid-cols-[28px_minmax(0,1fr)] gap-4 border-t border-border py-[18px] md:grid-cols-[28px_minmax(0,1fr)_300px] ${last ? 'border-b' : ''}`}
      data-testid={`outreach-install-step-${n}`}
    >
      <span
        className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent-text"
        aria-hidden="true"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-col gap-2.5">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <p className="text-text-2">{text}</p>
        {children}
      </div>
      <div className="col-start-2 md:col-start-3">{picture}</div>
    </li>
  );
}

/** The four things that go wrong most, folded: Chrome's words for each, and the fix. */
export function StuckFold() {
  return (
    <details
      className="group rounded-menu border border-border"
      data-testid="outreach-install-stuck"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-menu px-3.5 py-2.5 font-medium [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <LifeBuoy className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          {W.stuck.title}
        </span>
        <ChevronDown
          className="h-4 w-4 transition-transform duration-150 group-open:rotate-180"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </summary>
      <dl className="flex flex-col gap-3 border-t border-border p-3.5">
        {W.stuck.items.map((i) => (
          <div key={i.q}>
            <dt className="font-semibold">{i.q}</dt>
            <dd className="mt-0.5 text-text-2">{i.a}</dd>
          </div>
        ))}
        <p className="text-[12.5px] text-text-3">{W.devModeNote}</p>
      </dl>
    </details>
  );
}

export function ExtensionDownload({
  link,
  email,
  folded = false,
}: {
  /** The business's own link to the zip, when it gave one. */
  link: string | null;
  /** Who signs in: the last step names them. */
  email?: string;
  /** The steps folded under "How to install it" (the Settings tab). */
  folded?: boolean;
}) {
  const ours = link === null;
  const download = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <a
        href={extensionHref(link)}
        // Ours downloads as hfos-social.zip; a team's own link opens wherever it lives.
        {...(ours
          ? { download: 'hfos-social.zip' }
          : { target: '_blank', rel: 'noopener noreferrer' })}
        className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent-hover"
        data-testid="outreach-setup-download"
      >
        <Download className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        {W.download}
      </a>
      {ours ? (
        <span className="text-[12.5px] text-text-3" data-testid="outreach-download-about">
          {W.downloadAbout(VERSION, BYTES)}
        </span>
      ) : null}
    </div>
  );
  const steps = (
    <ol className="flex flex-col" data-testid="outreach-install-steps">
      {W.install.map((s, i) => (
        <PictureStep
          key={s.title}
          n={i + 1}
          title={s.title}
          text={s.text}
          picture={INSTALL_PICTURES[i]}
          last={!email && i === W.install.length - 1}
        >
          {i === 0 && !folded ? download : null}
          {i === 1 ? (
            <CopyField
              className="max-w-xs"
              value={CHROME_EXTENSIONS_URL}
              label={W.copy}
              copied={W.copied}
            />
          ) : null}
        </PictureStep>
      ))}
      {email ? (
        <PictureStep
          n={W.install.length + 1}
          title={W.signIn.title}
          text={W.signIn.text(email)}
          picture={INSTALL_PICTURES[W.install.length]}
          last
        />
      ) : null}
    </ol>
  );
  if (folded)
    return (
      <div className="flex flex-col gap-4" data-testid="outreach-extension-download">
        {download}
        <details className="group rounded-menu border border-border">
          <summary className="cursor-pointer list-none rounded-menu px-3.5 py-2.5 text-[14px] font-medium [&::-webkit-details-marker]:hidden">
            {W.howToInstall}
          </summary>
          <div className="flex flex-col gap-3 border-t border-border p-3.5">
            {steps}
            <p className="text-[12.5px] text-text-3">{W.update}</p>
          </div>
        </details>
      </div>
    );
  return (
    <div className="flex flex-col gap-4" data-testid="outreach-extension-download">
      {steps}
    </div>
  );
}
