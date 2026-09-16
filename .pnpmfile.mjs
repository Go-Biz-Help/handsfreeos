// drizzle-orm lists op-sqlite, the phone app's database, as an optional peer. pnpm links an optional peer that is
// anywhere in the workspace, which would put op-sqlite (about 335 MB) and React Native into the API and worker
// images. The server never uses drizzle's op-sqlite driver, so drizzle doesn't get to see it.
function readPackage(pkg) {
  if (pkg.name === 'drizzle-orm') {
    delete pkg.peerDependencies?.['@op-engineering/op-sqlite'];
    delete pkg.peerDependenciesMeta?.['@op-engineering/op-sqlite'];
  }
  return pkg;
}

export const hooks = { readPackage };
