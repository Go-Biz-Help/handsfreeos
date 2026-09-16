/** Where the local PowerSync Service listens (`pnpm sync:start`; HFOS_SYNC_PORT moves it). */
export const SYNC_URL =
  process.env.HFOS_SYNC_URL ?? `http://127.0.0.1:${process.env.HFOS_SYNC_PORT ?? '54430'}`;
