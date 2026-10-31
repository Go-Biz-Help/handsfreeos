'use client';
import { GUIDE_WORDS, PHONE_APP_LINKS } from '@hfos/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';

/**
 * "Get the phone app": a code to scan and a link for each phone. The links come from core (onboarding/app-links.ts):
 * the App Store for iPhone and Google Play for Android.
 */
export function PhoneAppDialog({
  open,
  onOpenChange,
  notifications,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened from "Turn on notifications", which is done in the app. */
  notifications?: boolean;
}) {
  const [codes, setCodes] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    // Loaded when the dialog opens, so Home doesn't carry the QR code library for everyone who never does.
    void import('qrcode')
      .then(({ default: QRCode }) =>
        Promise.all(
          PHONE_APP_LINKS.links.map((link) =>
            QRCode.toDataURL(link.url, { margin: 1, width: 320 }).then((png) =>
              setCodes((c) => ({ ...c, [link.platform]: png })),
            ),
          ),
        ),
      )
      .catch(() => undefined);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={GUIDE_WORDS.appTitle}
        description={
          notifications
            ? `${GUIDE_WORDS.appNotificationsNote} ${PHONE_APP_LINKS.testing ? GUIDE_WORDS.appTesting : ''}`
            : PHONE_APP_LINKS.testing
              ? GUIDE_WORDS.appTesting
              : undefined
        }
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="phone-app-links">
          {PHONE_APP_LINKS.links.map((link) => (
            <div
              key={link.platform}
              className="flex flex-col items-center gap-2 rounded-menu bg-card-2 p-4 text-center"
            >
              <div className="text-sm font-semibold">{link.label}</div>
              <div className="flex h-[140px] w-[140px] items-center justify-center rounded-control bg-white p-2">
                {codes[link.platform] ? (
                  // A data: URL made in this browser: no loader, no request.
                  <img
                    src={codes[link.platform]}
                    alt={`Code for the ${link.label} app`}
                    className="h-full w-full"
                  />
                ) : null}
              </div>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="text-[13px] font-medium text-accent-text hover:underline"
              >
                Open {link.from}
              </a>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
