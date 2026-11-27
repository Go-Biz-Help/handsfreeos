# Design tools: one brand kit, pictures, and more design everywhere

The owner, 27 Nov 2026, on the list of 20 ideas: "all of the above, also need to be able to add pictures and move them
around and center them etc". The list is `/mnt/project-files/design-ideas/ideas.md`; the numbers below are its numbers.

## What's there today

| Tool                         | What it can change today                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The business's look          | Logo and one colour (Settings → Workspace), found on the website or picked                                                                      |
| Forms                        | Colours, font, text size, corners, box and button style, spacing, labels, width, logo and name on or off, Match my website, Use on all my forms |
| Booking pages                | The form's choices, minus spacing, labels and width                                                                                             |
| Website chat                 | Button, words and top bar colours, logo on or off, corner, lift, label or icon on each kind of screen                                           |
| Content Creator pictures     | Nothing: the AI picks layout, font and colours each time, from the one colour                                                                   |
| Emails                       | Nothing: plain text, the logo on top, links in the colour                                                                                       |
| Invoices, estimates, signing | Nothing: the logo and the colour                                                                                                                |

## Decisions (mine, from the owner's "all of the above"; the owner can change any)

1. **The brand kit is the business's look, grown** (Settings → Workspace → Brand kit): logo, main colour, font and
   corners, with **Your pictures** in its own card below. Match my website fills the colour, font and corners at once.
   Kept in `workspaces.settings.look` beside the logo and colour, written only by the look commands, as now. (Button
   style stays each page's own: filled or outline reads differently on a form than in an email.)
2. **Everything starts from the kit, and what's left unset follows it.** A form, booking page, chat, email, post or
   invoice that hasn't picked its own font, corners or colours uses the kit's, so changing the kit changes them all.
   One that has picked its own keeps it until **Use your brand kit’s** (beside the font or corners) or **Start over from your brand kit** on its Design tab puts it back. Forms saved before the kit hold slightly round corners, so they keep them until then. Nothing that looks a
   certain way today changes until the kit gets a font or corners: an unset kit is today's look.
3. **Your pictures is one library per business.** Upload once, use on forms, booking pages, emails, the chat and
   invoices. The worker makes a web copy of each (largest side 2000 pixels, WebP, the camera's hidden details such as
   where it was taken taken out) in a new public bucket, so a picture shows on a client's website and in an email.
   The original upload isn't kept. Anyone in the business sees the library; whoever may change the business, its
   forms, calendars or channels adds, renames and removes. Removing keeps the file, so what already shows it stays
   whole. Apple's HEIC photos are refused with how to save one as a JPG (the worker's image library can't open them).
4. **A picture on a form is an item in the list, like a question.** It has a size (small, medium, large, full width), a
   place (left, centre, right), words under it if wanted, and a link if wanted. It moves like a question: drag it, or
   the arrows, which stay for keyboards and phones.
5. **Lining things up.** A form's logo, name and intro, and its send button, line up on the left or in the centre
   (Design → Line up). A words-only item lines up on its own too.
6. **Two boxes side by side** is a question's **Half width** switch: two halves in a row share it on a computer and
   stack on a phone.
7. **Pop-ups are a second way to embed** (Share → Pop-up): a button on the site opens the form or booking page in a
   centred window, or it opens by itself after a number of seconds or when a visitor on a computer goes to leave. A
   visitor who closes it isn't shown it again for 7 days. Same script, same "Sites allowed" list.
8. **Emails get a layout** (Settings → Email → How your emails look): a colour band or not, the logo on the left or in
   the centre, and a footer with the address, phone, website and social links. Automatic emails and campaigns both use
   it. A campaign email is written in blocks (words, picture, button, line, space) that move and line up like a form's.
9. **Content Creator** puts the logo on pictures (a corner, the last page only, or never), designs words over your own
   photos when you add one (you can still post it plain), lets you fix a picture's words by hand and draws it again
   at no AI cost, and lets you pick which fonts and layouts it uses. It takes its colours and font from the kit.
10. **The customer's pages** (invoice, estimate, document to sign, their appointment) follow the kit's font, corners and
    colours, and get a footer with the license number, address and social links.

## Build order (one pull request each)

1. **The brand kit and Your pictures** (1, and the library under 2 to 4): core, worker, Settings, Match my website
   fills the kit, forms and booking pages follow it. Migration: the pictures bucket.
2. **Pictures and layout on forms** (2, 3, 4, 5, plus pictures that move and line up): picture items, pictures on
   choices, a cover and a background picture, Half width, dragging, Line up, and a phone and computer preview. The
   phone app shows the pictures too.
3. **Pop-ups and booking pages** (6, 7, 8, 9): the pop-up embed for forms and calendars, Use on all my calendars,
   photos on the booking page (each person's, and a cover), and the width and spacing forms have.
4. **Website chat** (10, 11, 12): Match my website, font and corners, a greeting bubble, and a face in the top bar.
   Migration: chat columns.
5. **Emails** (17, 18, 19): the layout, real buttons, and campaign emails in blocks with pictures.
6. **Content Creator** (13, 14, 15, 16).
7. **The customer's pages** (20).

Each part: the Assistant can do what the screen does (`assistant/coverage.ts` and the ledger), docs, tests, and the
phone where the phone shows it.
