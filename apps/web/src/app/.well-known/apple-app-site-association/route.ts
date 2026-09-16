import { appleAppSiteAssociation, associationResponse } from '@/lib/app-links';

/** GET /.well-known/apple-app-site-association: which of this site's links open the iPhone app (lib/app-links.ts). */
export function GET(): Response {
  return associationResponse(appleAppSiteAssociation());
}
