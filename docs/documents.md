# Documents and e-signatures

Contracts and agreements a business's customers sign online, DocuSign-style. A template is made once from a PDF:
fields placed on its pages for each person who signs, and any of the PDF's own words typed over. Sending one fills it
in from HandsFreeOS, gives each signer a private link by email and text, and follows it to a signed PDF with a proof
page, saved on the customer's Files and locked for good.

The owner's answers of 28 October 2026 decide what it does (27 of them, listed in
`/mnt/project-files/e-signatures/plan.md` while it's being built, and summed up under "Rules worth knowing" below).
It's built in five parts. **Part 1 is the web**: templates from a PDF, sending, the signing page, the signed copy,
reminders, expiry, void and send again, and the Assistant. **Part 2** adds the AI placing the fields on a PDF (4a),
**Sign now** for someone signing in person (13a), and documents in the customer's portal (10b).

## Where things are

| What                                      | Where                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| The definition, checks and words          | `packages/core/src/documents/` (`definition.ts`, `check.ts`, `words.ts`; browser-safe)   |
| Loading one, and filling in from HFOS     | `packages/core/src/documents/load.ts`, `fill.ts` (server only)                           |
| Commands                                  | `packages/core/src/commands/document-template.ts`, `document.ts`                         |
| Reads                                     | `packages/core/src/queries/document.ts`                                                  |
| Tables                                    | migrations `20261027015100` (the `document` record type) and `20261027015200`            |
| The app                                   | `apps/web/src/app/app/w/[workspaceId]/documents/`, `apps/web/src/components/documents/`  |
| The signing page                          | `apps/web/src/app/d/[token]/`, served by `apps/worker/src/documents/routes.ts`           |
| Links, codes                              | `apps/worker/src/documents/links.ts`                                                     |
| Sending links, reminders, the signed copy | `apps/worker/src/documents/jobs.ts`                                                      |
| The signed PDF and its proof page         | `apps/worker/src/documents/pdf.ts` (pdf-lib)                                             |
| Reading and drawing PDFs in the browser   | `apps/web/src/lib/documents/pdf.ts` (pdf.js)                                             |
| The AI placing fields                     | `packages/core/src/documents/place.ts`, `apps/web/src/lib/documents/spots.ts`, and the   |
|                                           | worker's `apps/worker/src/documents/place.ts` (`POST /v1/documents/place-fields`)        |
| Part 2's tables                           | migration `20261027017000` (in-person signers, the portal's reads, `documents` usage)    |
| The customer's portal                     | `portal.documents` in `packages/core/src/queries/portal.ts`; the page at                 |
|                                           | `apps/web/src/app/c/[token]/documents/`; opening one is `apps/worker/src/http/portal.ts` |

## The shape

- **A definition** (`DocumentDefinition`, version 1) is the PDF's pages in points, the roles that sign in their order,
  the fields placed for each, the word changes, and the settings. A template keeps one; a sent document keeps its own
  copy, with that customer's own word changes and what was filled in before it went (`presets`).
- **Positions are fractions of the page**, from the top left, so the editor, the signing page, the phone and the
  signed PDF agree whatever size each draws it at. Pages are measured turned as the PDF says (pdf.js's viewport at
  scale 1); the worker draws onto each original page with its rotation and crop box.
- **Roles** are a customer's (`customer`) or the business's own people (`team`). `sender` is not a role: it is the
  business filling in its part on the Send screen, and its fields go out already filled.
- **Tables**, in schema `app`, each with row security per business:
  - `document_templates`: name, definition, revision, source file, archived;
  - `documents`: one sent copy, its definition, what it's about, status, expiry, the signed file and fingerprints;
  - `document_signers`: each signer and copy-only recipient, with their link version, code, consent and steps' times;
  - `document_values`: each field's answer and who gave it;
  - `document_steps`: the proof trail, which nothing updates or deletes.

## Rules worth knowing before changing anything

**A sent document is never edited (answer 15a).** To fix one, void it and send it again: the Send screen starts from
it (`?from=`), and the new one says which it replaces. The old links answer "taken back".

**The template's PDF never changes under a sent document.** A document keeps its source file id; swapping a
template's PDF uploads a new file. `document_template.set_source` takes off fields and word changes on pages the new
PDF doesn't have, and says how many.

**What a signer types fills blanks on the customer, never writing over (7a).** Only the customer's own fields in
`WRITE_BACK_SOURCES`, and only when they're empty.

**Every change from the signing page is a POST**, opening it included: mail scanners follow links. Each address is
held to `SIGNING_LIMITS`, and every answer is `no-store` with `no-referrer`.

**A signer's link is their whole permission.** It's an HMAC of the signer's id and link version under a key derived
from the money links' key (`hfos:document-signing-links:v1`), so rotating that key keeps old links working through
the previous keys. A reminder sends the same link; raising a signer's `link_version` retires the links already
sent, and an older one then answers 410 "out of date". The 6-digit code
(11a) is kept only as a keyed hash, works for 10 minutes and 5 tries, and a new one waits 45 seconds.

**The words they agree to are the worker's (16a).** `consentWording` is shown word for word on the page and kept with
each signature by `document.sign`, which takes the wording from the server, never from the page.

**The signed copy is made once.** Its file id is fixed by the document's id, so a retried job finds the file it
already made. It's filed on the customer's Files from `documents`, locked with reason `signed`, and the original's and
the signed copy's SHA-256 are kept on the document and printed on the proof page.

**Texts wait for quiet hours.** A link, reminder or copy that can't text now emails at once and texts at the end of
quiet hours, as one step of the trail.

**Templates are owners' and admins' (`documents.manage`); anyone who can see the customer sends (`documents.send`).**
Both can be changed per role and per person. The link the team copies is asked for as them, so a customer they
can't see is "not there".

**The Assistant does what a screen does.** Making, changing, archiving and sending are screen actions, each on a
Confirm card. Uploading a PDF is the person's own file, so it isn't the Assistant's. It never deletes for good.

**The browser reads PDFs with pdf.js's legacy build, on the page's own thread.** It runs on the older phones
customers sign on, and nothing has to be served from a separate address. Fonts, character maps and image decoders a
PDF asks for come from jsDelivr at the exact version installed; a PDF that needs none of them never asks.

**A typed signature is a picture of the name**, drawn in one of `SIGNATURE_STYLES` (Google fonts, via `next/font`),
cropped to the ink. The signed copy never needs the font.

**The AI only labels the spots; it never says where a field goes (4a).** The editor finds the spots on the PDF (a run
of underscores, a line or small box drawn, the room after a label like "Signature:") with the words around each, and
the model says which are fields, of what kind, for whom, filled in from what. Core checks its answer
(`placedFields`): a spot it was given, once each; a role on the template; a signature never the business's before it
sends (it goes to the business's signer, or is left out); a fill-in only from what fits the kind. The editor adds the
fields as one change Undo takes back, skipping any that sit on a field already there, and saves as it always does.
When the PDF has few words to go on (a scan), the model reads the PDF too, up to 30 pages. Its tokens are
`documents` usage, against the daily AI limit.

**Someone signing in person gets no link (13a).** Marked "With you now" on the Send screen (`in_person`), no link goes
at their turn and no reminder goes on its own. **Sign now** on the document (`document.sign_now`, on their turn only)
notes who handed it over (an `in_person` step with their name) and checks the code the template asks for: whoever
hands it over says it's them. The signing page then opens on that device, saying whose turn it is first, and to hand
it back at the end. Remind sends them their first link after all, when there's an email or mobile to send it to. The
Assistant never does it: it's the person's own device in a customer's hands.

**The portal shows a customer their own documents (10b),** under row security as `portal_actor`: their own place on
each (`portal.document_signer_ids()`), and every signer's position and status on those documents for whose turn it
is, never who the others are or how to reach them. Voided ones aren't shown. Opening one from there (`POST
/public/portal/documents/:signerId/open`) gives the signing page's own link and checks the code the template asks
for, since signing in to the portal was a code to the same person; the trail says so.

## Not yet

- Part 3: the phone app, templates included.
- Part 4: payments and file uploads when signing, an estimate carrying a contract, forms' Signature question on the
  new pad, workflows, and the AI teammate (asking a person first).
- Part 5: writing templates in HandsFreeOS, turning an uploaded PDF into an editable one, and Real Estate's third
  choice beside DocuSign and Dotloop.
- Sending one document to many customers at once.
