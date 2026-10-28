/** Where the worker answers. The same address the providers call; never the fly.dev one. */
export const workerUrl = (): string =>
  process.env.WORKER_PUBLIC_URL?.replace(/\/$/, '') ?? 'https://hooks.handsfreeos.com';
