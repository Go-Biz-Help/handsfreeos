/** This build doesn't know where the worker is (`EXPO_PUBLIC_WORKER_URL`): the web does that part. */
export class NotInThisBuild extends Error {
  constructor() {
    super('This part of setup isn’t in this build of the app.');
  }
}
