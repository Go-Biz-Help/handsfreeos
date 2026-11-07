/**
 * What Settings → Lead intake gives a business to paste: where a website form posts, the form itself, and where a
 * connected app sends, with the worker's address in front. Said once, for the screen and the Assistant. Browser-safe.
 */

/** Where a website form posts its leads. */
export const intakeFormUrl = (workerUrl: string, key: string): string =>
  `${workerUrl.replace(/\/+$/, '')}/intake/f/${key}`;

/** Where a connected app (Zapier, Make) sends its leads, with its key. */
export const intakeApiUrl = (workerUrl: string): string =>
  `${workerUrl.replace(/\/+$/, '')}/v1/intake`;

/** The form to paste into a page, as Copy the snippet copies it. */
export const intakeFormSnippet = (
  workerUrl: string,
  key: string,
  redirect: string | null,
): string =>
  `<form action="${intakeFormUrl(workerUrl, key)}" method="POST">
  <input name="name" placeholder="Your name" required />
  <input name="phone" type="tel" placeholder="Phone" />
  <input name="email" type="email" placeholder="Email" />
  <textarea name="message" placeholder="What do you need?"></textarea>
  <!-- Robots fill this in; people never see it. -->
  <input name="website" tabindex="-1" autocomplete="off" style="display:none" />
  <button type="submit">Send</button>
</form>${redirect ? `\n<!-- Afterwards they land on ${redirect} -->` : ''}`;

/** How an app sends one lead, with its key left for the person to put in. */
export const intakeCurlExample = (workerUrl: string): string =>
  `curl -X POST ${intakeApiUrl(workerUrl)} \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Dana Reyes","phone":"512-555-0134","email":"dana@example.com","message":"Need a quote"}'`;
