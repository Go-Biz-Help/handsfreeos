/**
 * The small pictures beside the extension's install steps and a network's Allow (docs/outreach.md, decision 83; the
 * canvas "Social Outreach setup"): Chrome's own screens drawn plainly in the app's tokens, so they read in light and
 * dark and never go stale the way screenshots do. Each is decoration beside its words, hidden from screen readers.
 */
import { ArrowRight, FolderClosed, Pin, Puzzle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/ui/brand';
import { cn } from '@/lib/utils';

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="flex min-h-[120px] flex-col justify-center gap-2 rounded-menu border border-border bg-card-2 p-3"
    >
      {children}
    </div>
  );
}

/** A browser window, plainly: its address bar, then what's under it. */
function Chrome({
  address,
  bar,
  children,
}: {
  address?: string;
  bar?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[8px] border border-border-strong bg-card">
      {address !== undefined || bar ? (
        <div className="flex items-center gap-2 border-b border-border bg-card-2 px-2.5 py-1.5">
          <span className="flex h-5 min-w-0 flex-1 items-center truncate rounded-full border border-border bg-card px-2 font-mono text-[11.5px]">
            {address}
          </span>
          {bar}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** What the step points at: the accent's ring around it. */
const lit = 'rounded-[6px] shadow-[0_0_0_3px_var(--ring)]';

const mono = 'font-mono text-[11.5px]';

export const INSTALL_PICTURES: readonly ReactNode[] = [
  // Download it and unzip it, into a folder that stays put.
  <Frame key="download">
    <div className="flex items-center justify-center gap-3">
      <div className="flex flex-col items-center gap-1.5">
        <span className="flex h-14 w-12 items-end justify-center rounded-[6px] border-[1.5px] border-border-strong bg-card pb-1.5 text-[10px] font-bold text-text-3">
          ZIP
        </span>
        <span className={cn(mono, 'whitespace-nowrap text-text-2')}>hfos-social.zip</span>
      </div>
      <ArrowRight className="h-5 w-5 text-text-3" strokeWidth={1.75} />
      <div className="flex flex-col items-center gap-1.5">
        <span className={cn(lit, 'flex h-12 w-16 items-center justify-center text-accent')}>
          <FolderClosed className="h-10 w-10 fill-accent-soft" strokeWidth={1.5} />
        </span>
        <span className="flex flex-col items-center">
          <span className={cn(mono, 'whitespace-nowrap text-text-2')}>hfos-social</span>
          <span className="text-[11px] text-text-3">in Documents</span>
        </span>
      </div>
    </div>
  </Frame>,
  // Developer mode, at the top right of chrome://extensions.
  <Frame key="developer">
    <Chrome address="chrome://extensions">
      <div className="flex items-center justify-between gap-2 px-2.5 py-3">
        <span className="text-[13px] font-semibold">Extensions</span>
        <span className={cn(lit, 'flex items-center gap-2 px-1.5 py-1')}>
          <span className="text-[11.5px]">Developer mode</span>
          <span className="relative block h-4 w-7 rounded-full bg-accent">
            <span className="absolute right-0.5 top-0.5 block h-3 w-3 rounded-full bg-card" />
          </span>
        </span>
      </div>
    </Chrome>
  </Frame>,
  // Load unpacked, and the folder that has manifest.json in it.
  <Frame key="load">
    <Chrome>
      <div className="flex gap-1.5 border-b border-border p-2.5">
        <span
          className={cn(
            lit,
            'border border-accent px-2 py-1 text-[11.5px] font-medium text-accent-text',
          )}
        >
          Load unpacked
        </span>
        <span className="rounded-[6px] border border-border-strong px-2 py-1 text-[11.5px] text-text-3">
          Pack extension
        </span>
      </div>
      <div className="flex flex-col gap-1 px-2.5 py-2">
        <span className={cn(mono, 'flex items-center gap-1.5 text-text-2')}>
          <FolderClosed className="h-3.5 w-3.5" strokeWidth={1.75} />
          hfos-social
        </span>
        <span className={cn(mono, 'pl-5 font-medium text-accent-text')}>manifest.json</span>
      </div>
    </Chrome>
  </Frame>,
  // The puzzle piece, then the pin.
  <Frame key="pin">
    <Chrome
      address=""
      bar={
        <span className={cn(lit, 'flex h-6 w-6 items-center justify-center text-accent-text')}>
          <Puzzle className="h-4 w-4" strokeWidth={1.75} />
        </span>
      }
    >
      <div className="flex items-center justify-between gap-2 p-2.5">
        <span className="flex items-center gap-2 text-[12px]">
          <BrandMark size={16} />
          HandsFreeOS Social (test)
        </span>
        <span className={cn(lit, 'flex h-6 w-6 items-center justify-center text-accent-text')}>
          <Pin className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
      </div>
    </Chrome>
  </Frame>,
  // The number in the extension, and the same one picked here.
  <Frame key="sign-in">
    <div className="flex items-stretch gap-2.5">
      <Chrome>
        <div className="flex flex-col items-center gap-1.5 p-2.5 text-center">
          <BrandMark size={18} />
          <span className="text-[11.5px] font-semibold">In the extension</span>
          <span className="text-[24px] font-bold tabular-nums tracking-tight text-accent-text">
            47
          </span>
        </div>
      </Chrome>
      <Chrome>
        <div className="flex flex-col items-center gap-1.5 p-2.5 text-center">
          <span className="text-[11.5px] font-semibold">On this page</span>
          <div className="flex gap-1">
            <span className="flex h-6 w-7 items-center justify-center rounded-[6px] border border-border-strong text-[11.5px] text-text-3">
              12
            </span>
            <span
              className={cn(
                lit,
                'flex h-6 w-7 items-center justify-center border border-accent bg-accent-soft text-[11.5px] font-semibold text-accent-text',
              )}
            >
              47
            </span>
            <span className="flex h-6 w-7 items-center justify-center rounded-[6px] border border-border-strong text-[11.5px] text-text-3">
              83
            </span>
          </div>
        </div>
      </Chrome>
    </div>
  </Frame>,
];

/** A network's Allow: the panel's button, Chrome's box, then a reload of the network's page. */
export function allowPictures(network: string, site: string): ReactNode[] {
  return [
    <Frame key="panel">
      <Chrome>
        <div className="flex flex-col gap-2.5 p-2.5">
          <span className="flex items-center gap-2 text-[12px] font-semibold">
            <BrandMark size={16} />
            HandsFreeOS Social
          </span>
          <div className="flex items-center justify-between gap-2 rounded-[8px] bg-card-2 px-2.5 py-2">
            <span className="text-[12px]">{network}</span>
            <span className={cn(lit, 'bg-accent px-2 py-1 text-[11.5px] font-medium text-white')}>
              Allow on {network}
            </span>
          </div>
        </div>
      </Chrome>
    </Frame>,
    <Frame key="box">
      <Chrome>
        <div className="flex flex-col gap-2 p-2.5 shadow-2">
          <span className="text-[12px] font-semibold">HandsFreeOS Social (test) wants to</span>
          <span className="text-[11.5px] text-text-2">Read and change your data on {site}</span>
          <div className="flex justify-end gap-1.5">
            <span className="rounded-[6px] border border-border-strong px-2 py-1 text-[11.5px] text-text-3">
              Deny
            </span>
            <span className={cn(lit, 'bg-accent px-2 py-1 text-[11.5px] font-medium text-white')}>
              Allow
            </span>
          </div>
        </div>
      </Chrome>
    </Frame>,
    <Frame key="reload">
      <Chrome
        address={site}
        bar={
          <span className={cn(lit, 'flex h-6 w-6 items-center justify-center text-accent-text')}>
            <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
        }
      />
    </Frame>,
  ];
}
