# Adding contacts on the phone, and business cards

The owner's ask of 17 November 2026: "Need to be able to add a contact that's not on the phone's contact list and we
need to add the scanner and it should also save the picture of the business card and crop out any background and
straighten it so all that shows is the card, also should be able to input both sides as well."

## What a person does

Contacts (More → Contacts) has a **+** at the top right. It opens **Add a contact** with three ways:

- **Scan a business card**: the camera opens. The front is read, then **Add the back** reads the back. Each side
  fills only the boxes still empty, so the back never undoes a fix the person made after the front.
- **Type it in**: the same New contact screen, empty. For someone who isn't in the phone's contacts.
- **Pick from your contacts**: the phone's own picker, as before (one at a time, no contacts permission).

New contact has a name, job title, company, phone (and more numbers, each with its label), email (and more emails),
website, address and a note. **Add contact** works with no signal, like every change on the phone; reading a card needs
signal and says so.

Under each side's picture: **Retake**, **Fix the edges** (drag the four corners onto the card, then **Crop**) and
**Remove**.

## How it works

- The phone takes or picks the picture with the camera it already had (no new native code, so it ships as an
  over-the-air update), shrinks it to a 2,048 px JPEG and sends it to the worker:
  `POST /v1/contacts/read-card` (`apps/worker/src/contacts/read-card.ts`). Providers live in the worker, so the API
  never sees the picture.
- The AI (`BUSINESS_CARD_SYSTEM` in `packages/core/src/crm/business-card.ts`) copies the details. It also says roughly
  where the card's four corners are, in the order the card reads, in pixels of the picture it was shown. The ask tells
  it how wide and high that picture is (`businessCardAsk`), and `cornersFromAnswer` divides by the same size.
- The worker finds the card by its own edges (`apps/worker/src/contacts/card-finder.ts`): the long straight lines in
  the photo, the four-sided outlines they make, and whether each side really is a step from one colour to another along
  its whole length. A rounded corner, or one corner under a thumb or a clip, is let off.
- The AI's corners are only a hint (`straightenCard` in `apps/worker/src/contacts/card-picture.ts`). They say which
  outline is the card, and which way up it reads, so a card photographed sideways comes out the right way up. In order:
  1. the outline the hint points at;
  2. the AI's own corners, when the photo's edges bear them out;
  3. the clearest outline in the photo, when the hint points at nothing. It has to be clear on every side.
  4. Otherwise the photo isn't cropped.
- The card is pulled flat at its true shape (worked out from the photo's perspective) and cut a hair inside its edges,
  so no table shows.
- With corners placed by hand (Fix the edges), the picture is only straightened again: no AI, nothing counted.
- The AI's tokens count as `business_card` usage (app.ai_usage, migration 20261027028700) for the person scanning,
  against the daily AI limit and the balance.
- Nothing is saved until **Add contact**. Then, in order on the phone's queue: the company (`company.create`, unless
  one of the business's companies has the same name), the contact (`person.create`, source "Business card"), and each
  side's straightened picture on their Files ("Business card front.jpg", "Business card back.jpg"). A side that couldn't
  be read keeps the picture as taken.
- Job title and website have no box on a person, so they lead the contact's note; the website also goes on a company
  added for them.

## Rules worth knowing before changing anything

- **Nothing is saved before the person checks the form.** The AI fills boxes; it never adds anyone on its own.
- **The back fills only empty boxes** (`fillCardForm`). Never let a later side overwrite what's there.
- **The picture kept is the card alone.** When the edges can't be found, the picture is kept as taken and the person
  is told to fix the edges.
- **No crop beats a wrong crop.** When the worker can't be sure which outline is the card, it leaves the photo as
  taken. Don't loosen the finder's limits to crop more often without trying it on real photos.
- **The crop never rests on the AI's corners alone.** On 17 November 2026 the AI gave its corners in pixels of the
  picture it saw, the worker read them as thousandths, and both of the owner's first cards were cropped below the card.
  The scripted AI in the tests had hidden it. So the card is found in the photo itself, and the tests give the finder
  hints at the wrong scale, in the wrong place, and none at all.
- **Known limits.** A card lying on something bigger and card-shaped (a sheet of paper) is cropped to that when the AI's
  hint is no help. A white card on white paper, or a dark card on a dark keyboard, is left uncropped. Fix the edges
  covers each of these.
- **Never put a real card's photo in the repository.** It shows a stranger's details. The tests draw their cards.
- **No new native modules on the phone** for this: the App Store has 1.0.0, and a native change means 1.0.1 and a
  review. A native document scanner (VisionKit, ML Kit) would be an upgrade for a later native release.
