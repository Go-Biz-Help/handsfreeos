import { androidFingerprints, assetLinks, associationResponse } from '@/lib/app-links';

// Read when asked, so a fingerprint added in Vercel's settings needs a redeploy but no code change.
export const dynamic = 'force-dynamic';

/** GET /.well-known/assetlinks.json: the Android app that may open this site's links (lib/app-links.ts). */
export function GET(): Response {
  return associationResponse(
    assetLinks(androidFingerprints(process.env.ANDROID_SHA256_CERT_FINGERPRINTS)),
  );
}
