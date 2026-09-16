// drizzle-orm lists every database driver it can use as an optional peer, and pnpm links an optional peer that is
// anywhere in the workspace. Two of those drivers live here for other reasons: op-sqlite, the phone app's database
// (about 335 MB, with React Native behind it), and better-sqlite3, which the sync scenarios' Node client uses
// (apps/sync; a native build). Linked to drizzle-orm, both would land in the API and worker images. The server only
// uses drizzle's postgres-js driver, so drizzle doesn't get to see them.
const KEPT_FROM_DRIZZLE = ['@op-engineering/op-sqlite', 'better-sqlite3', '@types/better-sqlite3'];

function readPackage(pkg) {
  if (pkg.name === 'drizzle-orm') {
    for (const name of KEPT_FROM_DRIZZLE) {
      delete pkg.peerDependencies?.[name];
      delete pkg.peerDependenciesMeta?.[name];
    }
  }
  return pkg;
}

export const hooks = { readPackage };
