# Forms, surveys and quizzes (M15)

One builder. A form, a survey and a quiz are the same definition with a different `mode`, which is why a
business can turn a feedback survey into a scored quiz without rebuilding it, and why there is one editor,
one engine and one set of results screens rather than three of each.

## Where things are

| What                                | Where                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| The definition, the ops, the engine | `packages/core/src/forms/`                                                               |
| Commands                            | `packages/core/src/commands/form.ts`, `form-response.ts` (and its uploads)               |
| Reads                               | `packages/core/src/queries/form.ts`                                                      |
| Tables                              | migrations `0073`–`0078`, and `0085` for the phone                                       |
| The app                             | `apps/web/src/app/app/w/[workspaceId]/forms/`, `apps/web/src/components/forms/`          |
| The phone                           | `apps/mobile/src/forms/`                                                                 |
| The public page                     | `apps/web/src/app/f/[site]/[slug]/`, served by `apps/worker/src/http/forms.ts`           |
| The AI builder                      | `apps/worker/src/forms/builder.ts` (tools in `packages/core/src/forms/ai-tools.ts`)      |
| The Assistant's tools               | `apps/worker/src/assistant/tools-forms.ts`                                               |
| Reading a linked page's forms       | `apps/worker/src/forms/page-forms.ts` (reads in `packages/core/src/forms/page-forms.ts`) |
| The AI teammate's tools             | `ask_form` / `answer_form` in `apps/worker/src/ai-team/tools.ts`                         |

## The shape

`forms/` mirrors `workflows/` file for file, for the reason that pattern exists: several editors have to be
several views of one thing rather than several things that drift.

- **`definition.ts`** — a versioned tree: `mode`, pages of questions with stable ids, calculations, the
  results people land on, what happens on submit, and the settings.
- **`ops.ts`** — the only way anything changes a form. A batch goes in all together or not at all, and every
  op hands back its inverse, so Undo is a list of ops rather than a saved copy.
- **`render.ts`** — which questions are showing, whether an answer will do, what the numbers come to, and
  where somebody lands. The editor's preview, the public page and the server all run this, which is what
  keeps them from disagreeing.
- **`describe.ts`** — plain English for a change ("“Your phone”: made it required") and `diffForms`.
- **`ai-tools.ts`** — the flat tools the builder calls, and the checking that turns them into ops.
- **`starters.ts`** — ten forms a business can publish as they come, the custom order among them.
- **`quantities.ts`** — a "How many of each" answer: its rows, its total, what it comes to and its words.

## Rules worth knowing before changing anything

**A draft is the business's own working copy.** Nobody outside it can open a draft, which is why the
Assistant may build and change forms on its own, and why publishing is a separate act with a confirmation.

**Publishing never opens a closed form.** Fixing a typo on a form you closed for the season leaves it
closed.

**An answer to a question that isn't showing is dropped, not recorded.** The engine prunes the answers to
what was visible, and it settles — taking one answer away can hide the next question. The server prunes
again on arrival, which is also what stops a crafted POST filling in a hidden question.

**A form never rubs anything out.** It fills a blank field on a customer and adds what wasn't there; a
customer leaving the email box empty this time doesn't erase the address on file.

**A sent form always has someone to save it under** (2026-11-11). Who it is comes from the questions the business
pointed at the customer's fields; failing that, an email question is their email, a phone question their phone, and
a short answer whose words ask for nothing but a name ("First Name", "Your last name", "Full name") is their name
(`contactFromAnswers` in `forms/submit.ts`). With no name at all, a new customer is saved under their number or
email (`intakeName`, as a text is) until somebody adds one. Shop Your Solar's contact form had name boxes that saved
to nowhere, and a new customer's form failed with "Something went wrong on our side".

**Every answer a form saves fits the record it goes on** (2026-11-11). A form's boxes allow more than a customer's
fields hold, so what an answer writes is made to fit rather than failing the whole form (`PERSON_LIMITS` in
`forms/submit.ts`; the test is "every answer a form saves fits the customer it goes on"):

- What the customer can fix is asked on the page: an email is checked the way the customer's record checks it (an
  accented letter or a comma is asked again), and a short answer saved as their Email or Phone has to be one.
- What they shouldn't have to care about is cut to fit: names to 80 characters, the town to 100 and the state to 50,
  the source (the form's name when nothing else says) to 80, notes to 10,000. A lead worth less than nothing is worth
  nothing.
- Every field is kept: City goes in their address's town, a picked choice saves its label rather than its id, and a
  new customer keeps the Notes, Other phone and Where they came from answers a returning one would have filled in.
  On a returning customer an address fills only its blank parts, never the street on file.

**Answers keep the version they were given on**, and each answer carries the question's wording as it read
at the time. Rewording a question never rewrites what somebody already said.

**A response in the Deleted bin takes its answers out of sight with it** (20261027010300). A response goes
in the bin with its customer, their leads' responses included. A lead deleted on its own leaves the customer's
responses and answers where they are (docs/deleting.md, "A lead, a company or a record takes only what's about
it"). While a response is in the bin, `form_answers_follow_response` hides its answers from everyone in the
business: they're a row each with no bin mark of their own, so until then Results still counted and quoted them.
Results and anything else that reads answers by form or by business leave them out, Bring back brings them back,
and the worker reads them as it always has.

**A live poll is only for a HandsFreeOS video call** (20261027019700). Its questions pop up when the team (or,
later, the AI) asks them, so it has no public page, no embed, no rules on its questions, and the AI teammate and the
phone never ask it; `form_response.*` refuses one (`form_is_poll`). Its answers still land as an ordinary response,
so nothing that reads answers needs to know.

**Every business has a contact form** (the owner, 2026-11-22: "we should just automatically create an a2p compliant
contact form when someone creates an account"). `registration.ensure_contact_form` (`forms/contact-form.ts`) gives a
business the **Get in touch** starter, published, unless it already has a published form that asks for a phone
number and shows our texting box when it opens (`worksAsContactForm` in `texting-box.ts`; a form that goes a page at
a time shows the box later, so it doesn't count). The worker runs it when a business is
made, and texting approval runs it again when it starts, so a business made before this, or one that deleted its
form, gets one then. It's an ordinary form afterwards: the business can change it, close it or delete it. Texting
approval's side is "Letting us collect it: the chat or our contact form" in `docs/operations.md`.

**Ids are made by us, never by a model.** The AI builder writes labels; `formToolCallsToOps` stamps the
ids and tells the model what they are.

**What the AI builder may leave out is optional, never null** (2026-11-11). Claude takes at most 16 values that
may be one of several types (`anyOf`, or a type like `['string', 'null']`) and 24 optional fields across a
request's strict tools, and past either it refuses the whole request ("Schema is too complex for compilation").
The builder's tools had 21 nullable fields, so every request failed and the Assistant said the AI that writes
form questions had failed. `obj(required, optional)` in `ai-tools.ts` builds each tool; the worker's
`ai-anthropic` test keeps the form and workflow builders within the limits, and the provider sends a tool past
them without `strict` rather than have the request refused (`strictWithinLimits` in `packages/ai`).

**A picture or a page someone sends is what to build, never what to do** (2026-11-24). The Assistant's `build_form`
can work from pictures sent with the question (`fromPictures`) or a link (`fromLink`), and the form builder's prompt
says words on either are the form's words, never instructions to it. The pictures aren't kept: only how many came is
saved with the question (`assistant_messages.context.pictures`), and older questions tell the model they're gone.

**The editor keeps the spaces being typed; what's saved is trimmed.** The editor applies an op on every
keystroke, and the form's parse trims every text, so it calls `applyFormOps` with `keepSpaces` to put back a
space typed at either end. Without it the space after a word was gone before the next word arrived. The server
applies the same ops without `keepSpaces`, so nothing is stored with stray spaces.

**The editor lets a box the form needs be emptied; it never saves it empty.** A question's words, a choice, the
words on a button, what a words-only question says and what a signature is for can't be empty, so the parse
refuses an op that empties one ("Write the question."). Applied on every keystroke, that refusal left the last
letter behind when someone selected it all and pressed Backspace (2026-11-11). Those boxes use `RequiredField` and
`RequiredInput` (`apps/web/src/components/forms/required-text.tsx`): while one is empty nothing is sent, the line
under it says the form keeps its last words until new ones are typed, and the first letter goes through as usual.
Drafts stay valid, so nothing about publishing changes.

## Checkboxes, and a single checkbox

- **Checkboxes** (`type: 'checkboxes'`, called "Pick any" until 2026-11-02) is several choices where they check any
  number, with an optional least and most.
- **A single checkbox** is one box to check, like "I agree to the terms" or "I own my home". It isn't a type of its
  own: it's a yes or no shown as one box (`config.display = 'checkbox'`, `isSingleCheckbox`), so Results, show-if
  rules, the export, a quiz's grading, the phone and the AI teammate all read it as the yes or no they already know.
  The question's title is the words beside the box. The add menu has a row for it (`single_checkbox` in
  `QUESTION_MENU`, which starts it required), and a yes or no's settings switch between **Yes and No buttons** and
  **One box to check**.

**What rules here:**

- **Checked is a yes; unchecked is no answer.** It's never recorded as a No, so Results counts the people who checked it.
- **One that must be answered must be checked** (`CHECK_THIS_BOX` in `render.ts`). A No (said in a conversation, say)
  doesn't count as agreeing. Saving part way leaves that problem out until it's sent
  (`isUnansweredProblem`), as it does for any question not answered yet.
- **A form never needs a texting box of its own** (2026-11-11). Every form that asks who they are already shows ours
  under the questions (`smsConsentWords`): the carrier-approved words the texting registration quotes, never ticked,
  never required, and the only box whose yes is saved on the customer. A yes or no the business adds asking the same
  thing (`textingBoxesTwice` in `forms/texting-box.ts`) gets a warning card in the editor with **Delete this
  question**, and the Assistant's `get_form` lists it under `asksForTextsTwice`. A warning, never a blocker: the words
  are only a guess at what the question means. A required one is called out too, since carriers turn those down.

## Name boxes, and Google address search

- **First name and Last name** (2026-11-18) are rows in the add menu's Details group. Like a single checkbox, they
  aren't types of their own: each is a short answer pointed at the customer's first or last name (`NAME_QUESTIONS`,
  `nameQuestionOf` in `forms/questions.ts`, `newNameQuestion` in the editor), so whoever sends the form is saved under
  their name the way an Email question saves their email. The list calls them First name and Last name. Rewording one
  keeps it saving there; pointing **Where the answer goes** somewhere else makes it a plain short answer again. The
  public page tells the browser what they are (`given-name`, `family-name`), so it offers to fill them in, and they
  take 80 characters, what a customer's name holds (`NAME_MAX_LENGTH`).
- **Google address search** (`config.search` on an address question, off until the business turns it on in the
  question's settings): as they type the street, Google suggests real US addresses, and picking one fills the street,
  town, state and ZIP (`addressFromPlace` in `forms/address.ts`, `address-field.tsx`). They can still type it all.

**What rules here:**

- **It uses the web app's Google Maps browser key** (`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, with Places API (New)),
  the same key and the same one-session-per-address billing as the service areas' address box (`addressSearch` in
  `lib/maps/google.ts`). Google's script loads only once someone starts typing in that street box, so a form with it
  off loads nothing from Google.
- **Without Google it's a plain box.** With no key, or where Google refuses (a form served on a business's own domain
  the key's referrer list doesn't include), they type the address as before. The switch says so when there's no key.
- **The suggestions sit in the form's flow,** not floating over it, so an embedded form grows to show them rather
  than cutting them off at the frame's edge. "Google Maps" shows under them, as Google asks when its suggestions
  appear without one of its maps.
- **Only the street box searches,** so an address that asks for just the town and ZIP has no switch. The phone fills
  an address in with its plain boxes.

## How many of each (orders)

For a business that sells things (2026-11-20, the owner's picks 1a 2a 3a 4a 5a 6b): a T-shirt shop's sizes, a bakery's
flavors, a crafter's mugs, tumblers, keychains and pins. **How many of each** (`type: 'quantities'`, in the add menu's
Numbers group) is rows the business names, a number box beside each with a minus and a plus, and the total under them
("24 shirts"), with what it comes to when the rows have prices. Two columns from five rows, as on a paper order form;
one on a phone. The **Custom order** starter asks what they'd like (T-shirts, Mugs, Tumblers, Keychains, Pins,
Something else) and shows a How many of each for each one picked, then colors, pickup or delivery, the date and
design notes.

- **The rows are `config.choices`** (`QuantityRow`: `label`, `price` in dollars or null, `productId`), so they're
  added, reworded, reordered and removed with a choice's ops (`add_choice`, `delete_choice`, `update_question` with
  `config.choices` by id), and the AI builder and the Assistant write them the same way. Settings: `unit` (what the
  total counts), `minTotal` and `maxTotal` (a 12-shirt minimum), `showPrices`, and `makesOrder` (on unless it's
  `false`: a sent form with something ordered on it makes an order on Money → Orders, "Orders" in
  `docs/selling-products.md`; the editor's **Makes an order** switch).
- **The answer is how many of each row by its id** (`QuantitiesAnswer`, `{"c_ab12cd34": 3}`), only rows above 0.
  Nothing ordered is `{}`, which is no answer, so a required one asks again. Rewording "Adult M" keeps every order
  already given pointing at it.
- **Rows from the price list.** **Add from your products…** (and **Add all N**) copies a product's name and price into
  a row and keeps its `productId` (the editor reads them from `form.catalogs`' `products`; someone without
  `money.read` sees none). Like an invoice's line, the row keeps its copy, so repricing a product never reprices a live
  form; when they've drifted apart the row says so and offers **Use that price**.
- **A row per size.** A product with sizes or colors (`docs/selling-products.md`) is offered as "T-shirt, a row per
  size": one row per choice of that option, each at the product's price with the choice's bump, keeping
  `optionChoiceId` beside `productId` (`rowsFromOption`). The drift check reads the same price (`priceListCents`), and
  a row whose choice was taken off the product says so and keeps its name and price.
- **The AI builder links rows too** (2026-11-24). It's given the business's price list (`form.catalogs`, run as the
  person, so someone without `money.read` gets none) in `priceListForModel`'s words, and a row it writes for something
  on that list carries `productId`, and `optionChoiceId` for a size, at the list's price. `formToolCallsToOps` refuses
  a newly linked row whose product or choice isn't on the list, so a made-up id never reaches a form and stock still
  counts.

**What rules here:**

- **In a rule it's how many in all; in a calculation it's what it comes to.** `numericAnswer` reads the total count,
  so "is at least 24" works; `includes` a row's id is true when they ordered some of it. `answerNumber` (calculations)
  reads count × price over the rows when any row has a price (a row without one adds nothing), and the count when
  none do. It's worked out in cents, so 3 × $10.10 is $30.30.
- **What the order comes to can be the lead's value.** Where the answer goes → **Lead value** (`lead.value` accepts
  it) puts count × price on the lead (`patchesFromAnswers`).
- **It's kept in words too.** `recordAnswers` keeps only the rows ordered and their words ("Adult M × 5, Adult 2XL × 2 ·
  7 shirts · $88", `quantitiesWords`) in `form_answers.text_value`, which the timeline, the phone, the export and the
  Assistant read; `number_value` is how many in all. **Results** draws a bar per row counting what was ordered, with the
  total and the usual order's size.
- **The phone fills it in** with a minus, the count and a plus per row, and the Assistant's `fill_in_form` takes
  counts by row id or words (`{"Adult M": 5}`, or "Adult M: 5, Adult L: 3"). **The AI teammate doesn't ask one** in a
  conversation (`NOT_IN_CHAT_TYPES`): a form with one is sent as a link. It reads a sent one in words, never ids.
- **Checked like any answer, on the page and the server** (`quantitiesProblem`): whole numbers only, up to 10,000 of a
  row, only rows the question has, and the least and the most in all ("The least is 12 shirts in all. You have 8.").

## Building a form from a picture or a link

Asked for on 2026-11-24 ("build Sherri's order form from a screenshot, or from a link to the page"). Both go through
the Assistant's `build_form`, which always makes a new form for a page and drafts it with the AI builder.

**A picture.** The Assistant's picture button (web: the button, paste or drop; phone: Take a photo or Choose a
picture) adds up to `ASSISTANT_PICTURES_MAX` (3) to a question. Each is shrunk on the device, then made an upright JPEG
no longer than `ASSISTANT_PICTURE_EDGE` (1568px) by the worker (`picturesForModel` in `assistant/routes.ts`; one that
won't open is refused as `picture_unreadable`, naming which). The newest question's pictures go to the model before
its words (`modelMessages` in `assistant/runtime.ts`), and with `fromPictures` they go to the form builder too. A
question with pictures is never read as a yes or no to a card waiting for an OK.

**A link.** `fromLink` reads the page in `apps/worker/src/forms/page-forms.ts` through the worker's safe fetch (10
seconds, 3 MB), then opens up to 3 forms framed on it (a JotForm or Google Form pasted into a page). Core's
`formsOnPage` (`packages/core/src/forms/page-forms.ts`) turns each into a plain outline the builder reads:

- every box, its kind, its name and whether it's required, in brackets: `[dropdown, name "color", required: Black |
White & Gray | Neon: Pink]`, with every choice of a dropdown, even the ones only seen when it's opened;
- choices to pick one of as `(pick one)`, and tick boxes as `[tick box]`;
- steps as `--- Step 2 (shows after Next is pressed) ---`, and parts that show later as `{Shows only when an earlier
answer fits: …}` or `{Hidden until something on the form shows it: …}`;
- a Google Form from its own data (`FB_PUBLIC_LOAD_DATA_`), sections as steps.

A site search, a sign-in, hidden fields and robot traps are left out, and boxes with no form tag around them are read
as one form when there are two or more. When a page has several forms and no `formNumber` was given, `build_form`
lists them and builds nothing, so the Assistant asks which (or builds each one asked for).

**What a link can't read says so, and asks for a screenshot instead** (`link_unreadable`): a robot check, a page that
won't open or isn't there, an address that isn't public, and a form drawn by code after the page loads (Typeform,
Wix), since the worker reads the page's HTML and runs none of its code. The screenshot advice says to open each
dropdown first, so every choice is in the picture.

## Files on a public form (designs and photos)

The second step for businesses that sell things (2026-11-20, the owner's pick 5a: "photos and files land in the
customer's files"). An **Upload** question (`type: 'file'`) on the public page is a box to add a design, a photo of
what they want, or a document, from a phone's camera roll or a computer, each file showing its progress and an X to
take it back. Its settings say what it takes (photos; documents and photos; anything a business's files take), how many
(1 to 10) and how big (1 to 25 MB). `forms/uploads.ts` holds the rules the page and the server share.

- **A file is uploaded as soon as it's picked, onto that answer sheet only.** `form_response.upload_begin` (the
  sheet's key, the question, the name, type and size) keeps its place as a pending file on the form (`record_type`
  form) in the sheet's own folder, `<workspace>/form/<form>/responses/<sheet>/<question>/<file>/<name>`; the worker
  hands the browser a two-hour link to put it there (`POST /public/form/<site>/<form>/<sheet>/uploads`). Then
  `form_response.upload_confirm` (`…/uploads/<file>/confirm`) checks what Storage says arrived against the question,
  marks it ready, or removes it and says why. Picking a file starts the sheet if nothing was typed yet.
- **On sending, each file is copied onto the customer** (`form_response.submit` files a pending copy on them and emits
  `file.received`, which the worker copies as it does a file a customer texts in; `file.finish_copy` marks it ready
  and puts it on their timeline and Files). The answer sheet keeps its own copy, so deleting one never takes the
  other; with nobody to put them on (an anonymous form), the sheet's copy is all there is.
- **Only the sheet that uploaded a file can send it.** Submit takes a file only from that sheet's folder for that
  question, finished; anything else is "didn't finish uploading" beside the question. The answer keeps Storage's name
  and size, never the page's. Files the sheet uploaded and didn't send (taken back, or on a question that ended up
  hidden) are removed then.
- **It takes what the business's files take** (`ATTACHMENT_TYPES`: photos, PDFs, Word and Excel, text, short videos and
  voice notes; 25 MB), because it's the same bucket. An Illustrator, Photoshop, SVG or CorelDRAW file is refused with
  "Save it as a PDF or a PNG and add that"; taking them would mean widening the bucket in a migration.
- **The answer is the files** (`AnswerFile[]`: `fileId`, `name`, `bytes`), kept in words too ("2 files: front.png,
  back.pdf") for the phone, the Assistant, search and the export. **Results → the answers sheet** lists them, each
  opening from a five-minute link (`form.response_get`'s `files`). Deleting the answers removes the sheet's copies
  (for someone with `files.delete`); the customer's stay.
- **The phone still sends a form with a file question to the web** (below).

## The public page

`/f/<site>/<form>`, served by the worker as the booking page is, and never the draft. What protects it:

- per-address rate limits and a honeypot field, which is answered with a sheet that writes nothing;
- the key handed back when a sheet is started — knowing a response's id is not enough to write to it;
- the form's own closing rules, checked again inside the transaction;
- a frame rule built from the sites the business listed, so an embedded form is framed by them and nobody
  else (`apps/web/src/lib/forms/frame.ts`).

Embedding is an iframe with `?embed=1` and one script line (`/embed/v1/form.js`, `lib/forms/embed-script.ts`): the
page drops our frame and padding, says how tall it is whenever that changes, and the script fits the iframe to it. A
calendar's embed (its Booking link → **Embed**, "A calendar on the business's own website" in `docs/operations.md`)
loads the same script as `/embed/v1/book.js`, with its own sites list on the calendar. A
snippet pasted before the script existed keeps its fixed height. The sites list takes sites typed any way and adds
each one's `www` twin, as the website chat's does (`normalizeChatOrigins`).

## How a form looks

A form's `design` (`forms/design.ts`, the editor's **Design** tab) holds its colours, font, text size, corners, the
style of its boxes and buttons, the space between questions, where the question words go, how wide it gets, and
whether the business's logo and the form's name are at the top. A colour can be picked or typed as a hex code. The owner's picks (2026-11-02, 1a 2a 3a 4a): each form has its own design,
starting from the business's; **Use on all my forms** copies one form's design to the rest; **Match my website**
copies a site's colours, font and corners; and there's no box for custom CSS, which could hide the texting consent
words.

**What rules here:**

- **The design is part of the definition,** so it changes through `set_design` ops (Undo works, the Assistant and
  the AI form builder can set it) and goes live with Publish like the questions. **Use on all my forms**
  (`form.use_design_everywhere`) is the one exception: it's its own act, behind a confirmation, and puts the design
  on the other forms' drafts and live versions straight away, changing nothing else about them.
- **Unset colours follow the business.** The buttons take the business's colour (Settings → Workspace), darkened for
  white words as on its booking page; every other colour is worked out from the background. `formLook` sets every
  colour token the form's parts use, so a visitor's own dark mode never turns a form on a light site dark.
- **A form on a website is see-through** unless its design gives it a background, so it sits on whatever part of the
  site it's in. Its page is always in the light colour scheme there, because a browser paints a solid backdrop behind
  a frame whose scheme differs from the page around it.
- **The public page and the preview are worked out the same way** (`FormLookFrame`), so the preview is what goes live.
- **Match my website** is read by the worker, never the API (`apps/worker/src/http/website-style.ts`, signed in, with
  `forms.manage`): the page and up to six stylesheets, as robots.txt allows. `look/style.ts` finds the buttons in the
  HTML first, so builders that style everything with made-up class names (GoDaddy's `.c1-a4`) are read as well as
  hand-written `.btn` rules. A paid font is stood in for by the closest free one, and it says so. Nothing is kept: the
  design lands in the draft as one edit.
- **HandsFreeOS's own permission boxes match the form.** The texting box (and the offers and calls boxes) are drawn
  like a single checkbox question, in the form's corners, colours and text size, with their words always showing. They
  can't be hidden or reworded on a form: they're what a carrier reads. A form's own "I agree to texts" question is
  the same ask twice, and requiring it would make texting a condition of sending the form, which carriers refuse.
- **Cloudflare's "are you a person" check stays out of sight** unless Cloudflare needs a click, and then shows in the
  form's light or dark. If it can't run, the form says so above the send button.
- **A hidden name stays for screen readers.** With no logo, name or intro showing, the form starts at its first
  question.
- **A calendar's booking page uses the same design** (its **Design** section, `config.design` in its settings, saved
  with Save rather than Publish), drawn by the same `FormLookFrame`. Its buttons carry `data-form-action` like a
  form's. "A calendar on the business's own website" in `docs/operations.md` says what differs.
- **Site builders that wrap pasted code in a frame of their own** (GoDaddy's HTML section: an `srcdoc` frame sized
  once, when the page loads) get that frame grown with the form by `/embed/v1/form.js` too. The script also asks each
  form for its height when it starts, so a form that loaded first isn't left at the snippet's height.

## Videos and steps (funnels)

A form can walk somebody through a funnel: a video, their details, a longer video, a few questions
(`HANDSFREEOS_FUNNELS_IMPLEMENTATION_PLAN.md`).

- **One page at a time** (`settings.onePageAtATime`) gives each page its own screen with Back and Next. Next checks
  that page with `pageProblems`; the consent box and the send button are on the last page. A sheet picked up
  again starts where they left off (`pageToResume`). The editor's question list shows where each page starts,
  "Start a new page", and the switch once there is more than one page.
- **A video question** (`type: 'video'`, `forms/video.ts`) plays a YouTube, Vimeo or Loom link the business
  pasted. They host and stream it; we never upload it. Its answer is how much they watched, 0 to 100, so show-if
  rules, Results, the timeline ("Watched 85%") and the export work on it unchanged.
- **The gate** (`config.minPercent`) is `answerProblem`'s: Next waits, and the server refuses the sheet at submit,
  until they've watched that much. Loom can't be tracked, so `formProblems` refuses a gate on it.

**What rules here:**

- **No provider script runs on the page.** The page talks to the player's frame by message (`playerHello`,
  `readPlayerMessage`) and reads only messages from that player's own origin (`VIDEO_ORIGINS`). The public page
  is on the business's domain or ours, and YouTube's or Vimeo's script has no business there.
- **Watched means watched.** The furthest point moves on only while they play at the edge of what they've seen
  (`watchTick`), so dragging the bar ahead doesn't count, and the answer only goes up.
- **The gate is a nudge, not proof.** The browser reports the position, so a determined person can fake it.
- **The AI teammate doesn't ask a form with a video** in a conversation (`NOT_IN_CHAT_TYPES`), and the phone sends
  one to the web (`NOT_ON_THE_PHONE`).

## Details saved part way, and personal links (funnels)

- **A page that saves their details** (`page.savesContact`, one a form). Shown one page at a time, leaving it runs
  `form_response.save_contact`: the customer is matched or made, the blanks that page's answers fill are written,
  the lead opens, and the texting box (which sits on that page) is recorded. Sending at the end keeps that customer
  and that lead. Both go through `settleCustomer`, so the rules are the same ones sending always had. It takes the
  same "are you a person" check sending does, through `POST /public/form/<site>/<form>/<sheet>/contact`.
- **A personal link** (`app.form_links`, 20261027010900) is `/f/<site>/<form>?k=<key>`. A workflow's **Send a form**
  makes one for each customer (`form_link.create`). The key is random and only its hash is kept; it works 30 days.
  Opening it (`GET …/personal/<key>`) hands the page their first name, which contact details we have, and their
  unfinished sheet from a link; starting with it binds the sheet to them (`form_link_id`), and the key writes to
  that sheet as well as its own resume key does (`assertHolder`).
- **What a personal link changes** (`FillContext` in `forms/personal.ts`, passed to every `render.ts` function):
  a question filling a contact detail on file (first name, last name, email, phone) is skipped, and a page left
  empty isn't shown. `{{person.first_name}}` (with `| default:"there"`, as workflows write it) works in the title,
  intro, page headings, questions and text blocks, from what they typed or the link (`fillFormWords`).

**What rules here:**

- **Nothing on file is shown back.** Only the first name, for the greeting. The personal route even leaves their own
  earlier email and phone answers out of the sheet it returns: a forwarded link would show them to whoever opened it.
- **A form never writes over what's on file**, personal link or not. Asked again ("Details changed?"), a different
  phone joins their other numbers instead, so a forwarded link can't change somebody's details.
- **A link we texted needs no robot check**: the worker skips Turnstile when the page's key is a live personal key.
- **Filling a blank on a customer we already had emits `person.updated`**, and both commands declare it. Before
  this, a returning customer whose form filled in a missing detail was refused by the kernel.

## Booking a time, and stopped partway (funnels)

- **A "Book a time" question** (`type: 'booking'`, `forms/booking.ts`) shows a calendar's open times as buttons,
  read from `GET /public/form/<site>/<form>/times/<question>`. Its answer is the time, the session and how it
  reads. Sending the form books it inside the same transaction (`bookTheTime`), with the calendar's own
  `appointment.book_online`, so the confirmation, the video link and the reminders are the calendar's. The booking
  joins the form's lead rather than opening another (`leadId`), and a form can book a calendar whose booking page
  is off (`throughForm`): a presentation booked only through its funnel.
- **The link's `ref` goes on the booking.** A form opened with `?ref=` (a Social Outreach demo link, or a partner's)
  keeps it on the sheet when it starts (`form_responses.link_ref`, 20261027012200), so it holds when they stop
  partway and come back on another link. The time booked on it keeps it on the booking
  (`appointment_attendees.link_ref`), as a booking page does, so the demo or the partner's referral counts by itself.
  Anything that isn't a ref a booking keeps (`linkRefOf`) is left off.
- **A session that filled up meanwhile** refuses the whole send with `form_booking_taken` (the time in words, and
  the question in `details`), so nothing is half done; the page clears the pick and reads the times again.
- **Stopped partway.** Shown one page at a time, each save carries the page they're on (`at_page_id`,
  `last_active_at`, 20261027011000). Every five minutes the worker's `forms.stopped_sweep` finds sheets whose
  person we know, quiet for 30 minutes (and under a week), and `form_response.mark_stopped` marks that page once
  and emits `form.stopped`. A workflow starts on it with **Somebody stops partway through a form**, filtered by
  `trigger.form_id` and `trigger.page_title`, and its texts can say `{{trigger.page_title}}`.

**What rules here:**

- **A form never takes money**, so it can't book a calendar that takes a deposit or the full price (`formIssues`,
  and again when it's sent).
- **The time reads in the calendar's words.** The server writes the label again from the time and the calendar's
  zone, whatever the page sent.
- **A seat in a shared session isn't one customer's appointment**, so only a booking of their own takes the lead.
- **The AI teammate and the phone** don't ask a form with a booking question (`NOT_IN_CHAT_TYPES`,
  `NOT_ON_THE_PHONE`).

## Live polls (webinars, part 2)

A fourth kind beside form, survey and quiz (`mode = 'poll'`), picked on a call or a webinar's calendar.
`docs/video-calls.md`, "Live polls", is how a call runs one.

- **What it may ask** (`pollProblems` in `definition.ts`): pick one, pick any, yes or no, a rating, a scale, a short
  answer, and **buttons**, at most 30 items, no rules. A button (`questions.ts`) books on a calendar, opens an https
  link, or says "talk to someone"; it belongs to live polls only, so any other form with one has a problem to fix.
- **Each question's `live`** holds how long it stays up (`seconds`, 10 to 600, 60 by default), whether everyone
  sees the totals after (`showResults`, off by default), and up to eight **when-to-ask phrases** (`cues`): what the
  presenter might say just before asking it, which the AI hearing the call listens for (part 3). The AI writes them
  from the editor or the Assistant's builder, and the business changes them like any words. With the poll's slides
  (part 4: `definition.slides`, a PDF whose file's record is the form) a question can say the slide it goes with
  (`live.slide`); "Slides" in `docs/video-calls.md` is how. `liveOf` fills the defaults. The editor shows both under
  each question (**Seconds it stays up**); a poll has no Required switch, no Where it goes and no Share tab.
- **Its answers** are one response per person per call (`form_responses.video_call_id`, `source = 'video_call'`), so
  Results and the customer's record show them like any form's.
- **Points for who to follow up with** (part 5): each answer's are on its question (`live.points`, by a choice's id,
  `yes` and `no`, each number of a rating or scale, `answered`, `pressed`; -100 to 100, 0 left out), and the poll's
  own `leads` holds what staying to the end is worth, where Hot and Warm start, and what happens to the hot ones.
  `update_question` replaces `live.points` whole, so a point taken off stays off, and undo puts the old ones back.
  The AI suggests them (**Suggest points for every question**) or drafts the whole poll from the webinar's goal and
  slides (**Draft the questions with AI**); both land as edits. The Assistant's form builder sets them too
  (`update_question` with `live.points`, `set_form` with `leadsJson`). "Who to follow up with" in `docs/video-calls.md` is how
  they're used.

## Answering in a conversation

A form marked "the AI teammate may ask this" (`in_chat`) becomes two teammate tools. The teammate holds no
state: the sheet is the same row the public page writes, found by customer and form, so a conversation that
stops halfway can be finished on the link and the other way round.

## Website chats on the Forms page

**Forms** also lists the business's website chats (**Website chats**, above the forms), for people who may change
them (`channels.manage`), because a chat is how most visitors leave their details. They aren't forms: each is a
`chat_widgets` row, edited by `chat_widget.update` on its own page (`forms/chats/<id>`, the same editor as
**Settings** → **Website chat**), and the texting registration's chat is one of them, not a kind of its own. A chat
keeps its name, its look, where its button sits on computers and phones, and what happens while nobody is answering
(`20261027021600_website_chat_look_and_place.sql`). The operator's side is "Set up the website chat for a client" in
`docs/operations.md`.

## On the phone (M17)

Built, and nothing in `forms/` had to change — the engine really was ready.

- **`app.forms` and `app.form_versions` are published; `app.form_responses` is not.** Its
  `resume_token_hash` is a secret column by `packages/db/test/sync-secrets.test.ts`'s rule, and PowerSync's
  first copy of a table reads every column whatever the stream selects. A phone filling a form in needs the
  questions, not a row.
- **`form_versions.is_active`** is a stored flag meaning _a phone should hold this one_: the form's active
  version, while the form is live. A stream cannot join, which is the same reason `sync_window` is stored.
- **`form_response.record`** makes the answer sheet and sends it in one go, with an id from the phone, then
  hands over to `form_response.submit` so every consequence — the customer, the lead, the workflows — is the
  form's own behaviour and not a second set of rules.
- **It runs as the teammate, so 0109 lets a teammate write that sheet.** With `records.write`, a person may
  start a sheet from the app (`source = 'app'`, no key, nobody on it yet), send it while it is open, and
  write its answers and the form's count for the day. A sheet from the link, the embed, a QR code or a
  conversation is still the worker's alone, a sent sheet is never edited, and the key's and the visitor's
  hashes stay unreadable, so a sheet is read through `READABLE_SHEET`. A teammate's send doesn't count
  against Lead intake's day, which measures what arrives on its own. Until 0109 every one was refused, and
  nothing had run the command against a database.
- **`apps/mobile/src/forms/`** and `app/.../forms/[formId].tsx` render it with core's `formState` and
  `answerProblem`, so what the phone accepts is what the server accepts.
- **A file, a signature or a card payment stops the whole form** with "open this one on the web", rather
  than rendering the other questions and quietly dropping that one.

## What is not built yet

**Agency templates for forms.** M6's template mechanism pushes workflows to client businesses; forms would
use the same one, and `diffForms` already describes what an update would do.
