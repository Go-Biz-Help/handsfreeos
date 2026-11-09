'use client';

/**
 * Skip for now on the failed-payment page (20261027023600): until when this person skipped it, kept on this device
 * only, per business. Lost storage (a private window) just shows the page again, which is the safe side.
 */
const key = (workspaceId: string) => `hfos.paymentSkip.${workspaceId}`;

export function readPaymentSkip(workspaceId: string): string | null {
  try {
    return window.localStorage.getItem(key(workspaceId));
  } catch {
    return null;
  }
}

export function writePaymentSkip(workspaceId: string, until: string): void {
  try {
    window.localStorage.setItem(key(workspaceId), until);
  } catch {
    // Nowhere to keep it: the page shows again on the next screen.
  }
}
