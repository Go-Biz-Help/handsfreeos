'use client';
/**
 * Getting the browser extension (docs/outreach.md, decisions 45 and 60): HandsFreeOS hands out its own build, zipped
 * into `public/downloads` as this web app builds (apps/extension/scripts/download.mjs; its version and size come
 * through next.config.ts), unless the business gave its own link (`extensionLink`, Settings → General), and says how to
 * load it into Chrome with Developer mode, step by step. The setup's install step shows it all; the Settings tab folds
 * the steps away.
 */
import { CHROME_EXTENSIONS_URL, SETUP_WORDS as W } from '@hfos/core/addons/outreach/setup';
import { Download } from 'lucide-react';
import { CopyField } from '@/components/ui/copy-field';

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

export function ExtensionDownload({
  link,
  email,
  businessName,
  folded = false,
}: {
  /** The business's own link to the zip, when it gave one. */
  link: string | null;
  /** Who signs in, and to which business: the last step names them. */
  email?: string;
  businessName?: string;
  /** The steps folded under "How to install it" (the Settings tab). */
  folded?: boolean;
}) {
  const ours = link === null;
  const steps = (
    <ol
      className="flex list-decimal flex-col gap-2 pl-5 text-[14px]"
      data-testid="outreach-install-steps"
    >
      {W.install.map((line, i) => (
        <li key={line}>
          {line}
          {i === 1 ? (
            <CopyField
              className="mt-1.5 max-w-xs"
              value={CHROME_EXTENSIONS_URL}
              label={W.copy}
              copied={W.copied}
            />
          ) : null}
        </li>
      ))}
      {email && businessName ? <li>{W.signInStep(email, businessName)}</li> : null}
    </ol>
  );
  return (
    <div className="flex flex-col gap-4" data-testid="outreach-extension-download">
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
      {folded ? (
        <details className="group rounded-menu border border-border">
          <summary className="cursor-pointer list-none rounded-menu px-3.5 py-2.5 text-[14px] font-medium [&::-webkit-details-marker]:hidden">
            {W.howToInstall}
          </summary>
          <div className="flex flex-col gap-3 border-t border-border p-3.5">
            {steps}
            <p className="text-[12.5px] text-text-3">{W.devModeNote}</p>
            <p className="text-[12.5px] text-text-3">{W.update}</p>
          </div>
        </details>
      ) : (
        <>
          {steps}
          <p className="text-[12.5px] text-text-3">{W.devModeNote}</p>
        </>
      )}
    </div>
  );
}
