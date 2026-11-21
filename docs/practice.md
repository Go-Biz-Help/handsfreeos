# Practice businesses: Admin → Try onboarding

HandsFreeOS's admins go through every onboarding as a brand-new customer would, on the real screens, and nothing is kept. The owner asked for it on 14 November 2026 and picked how it works (migrations `20261027027400_practice_businesses.sql` and `20261027027500_practice_more_flows.sql`).

## What it is

A **practice business** is a real organization and business, owned by the staff member who started it, and marked with `app.organizations.practice_ends_at` (when it goes) and `practice_by` (who's practising). Everything in it works as it does for a customer: the screens, the commands, the events, the AI. What would reach the outside world is pretended.

The flows are listed in `packages/core/src/practice/words.ts` (`PRACTICE_FLOWS`). The ones marked `ready` start from the page; any others say "Coming next". Each starts like this (`apps/web/src/components/practice/try-starts.tsx`):

| Onboarding                    | Starts                                                                                       | Practice business                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| New business, start to finish | the practice sign-up, `/try/sign-up`                                                         | made on the setup's first screen, yours                             |
| From an offer link            | the practice sign-up with the link's `?plan=`, `?code=`, `?ref=`, `?business=`, `?industry=` | the same; the plan and code ride on in the address to the plan page |
| An add-on's setup             | its Add-ons page, `?addon=` the one picked                                                   | ready (its plan on), yours                                          |
| The Main offer builder        | the builder, once Content Creator is on                                                      | ready, yours, Content Creator turned on                             |
| An agency setting up a client | the client's setup, as Add a business opens it                                               | an agency's client: you own the agency, you're not on its team      |
| Joining from a team invite    | the invitation email                                                                         | ready, nobody in it, you invited at the role picked                 |
| Signing up as an affiliate    | the practice sign-up, then `/try/affiliate`                                                  | none: the application is checked and never sent                     |

## The owner's picks

1. **Real screens and real AI; the outside world is pretended.** Payments, phone numbers, texts and calls, connections and sending domains use the stand-ins local development uses.
2. **Deleted when you press End practice, or 24 hours after it starts** (`PRACTICE_HOURS`).
3. **Email goes only to the staff member**, marked "[Practice]", with a line at the top saying who it would have gone to. Campaign email doesn't go at all.
4. **Add-ons still in development can be practised.**
5. **The founder and staff admins only** (`platform.practice.use`, held by `staff_admin`). Anyone else gets the 404 page.

## Rules worth knowing before changing anything

- **The mark is set once, by `private.start_practice_as`, and never changed.** A person's own insert or update may not touch `practice_ends_at` or `practice_by` (`private.guard_practice_mark`), so a real business never becomes a practice one, or the other way round. `private.start_practice` is its first way, kept for code from before.
- **Three ways to make one** (`practice.start`'s `as`): `owner`, yours as a new customer's, optionally `ready` with its plan on; `agency`, a client's business under an agency you own, without you on its team, so its setup ends by handing it to the owner; `invited`, ready with nobody in it and you invited from your own address as a member or admin, never owner (an owner joins through an agency's handover). For `invited`, practice.start records what it made while you're briefly a member, since only someone in a business records its events, then steps you out (`private.practice_step_out`).
- **Every invitation into a practice business is the practising staff member's to take**, whatever address it went to (`private.practice_invitation_for`, in `private.invitation_preview` and `private.accept_invitation`). Its email came to them anyway. A real business's invitations still work only for the address they went to.
- **Every add-on is offered in a practice business**, the ones still being built too (pick 4): `loadGrants` adds `EVERY_ADDON_GRANT` for one, and `capabilityContextOf` turns it into every add-on, each marked Testing as a staff grant is.
- **Ending one is the practising staff member's**, whatever role they hold in it (`private.end_practice`): a teammate who joined from an invitation holds none that deletes. `practice.end` is a platform command, and refuses anyone else practising.
- **Five at once per person.** Each one is a whole business until it goes.
- **Practice businesses are counted nowhere.** Admin → Businesses, its totals and Admin → Getting started's counts leave them out. Nothing is credited for one: no affiliate, no Opinly sign-up.
- **Paying is `practice.pay`, never `founding.buy`.** The plan goes on the business with no founding spot held, no grant and no card, so nothing counts or bills it. The plan page sends a practice business to the stand-in checkout (`/try/checkout/<id>`), and shows each plan's own free trial whatever the staff member bought before.
- **The worker decides what's pretended, at its three doors.** The outbox (`outbox.ts`), the jobs (`jobs.ts`) and the HTTP routes (`http/server.ts`) each ask `practiceRunFor` whether the work is for a practice organization. If it is, they run it with `forPractice(deps, run)` inside `inPractice(run, …)`, and the routes' `deps` come from `practiceAware`. The swaps are in `apps/worker/src/practice/kit.ts`. Anything new that reaches outside HandsFreeOS needs a stand-in there.
- **Connecting a provider stops at a page saying it's pretended** (`http/oauth.ts`), since the stand-in consent pages aren't served in production.
- **Ending one is deleting it, as Delete business does.** `practice.end` records `workspace.deletion_requested` and marks the business. The worker's deletion job takes it out, then queues `practice.purge`, which removes the organization and its own history (`private.purge_practice_organization`). The hourly `practice.sweep` does the same for one whose time is up. The purge is the only thing allowed to delete from the event and audit logs outside a business's own purge, and only for a practice organization.
- **The Assistant never starts, pays for or ends one.** `practice.start`, `practice.pay` and `practice.end` are in `NEVER_FOR_THE_ASSISTANT`. Inside a practice business it works as in any other.

## Where things are

| Part                                             | Where                                                                                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The mark, starting, paying, the sweep, the purge | `supabase/migrations/20261027027400_practice_businesses.sql`                                                                                                                                                   |
| The other ways, invitations, ending, the list    | `supabase/migrations/20261027027500_practice_more_flows.sql`                                                                                                                                                   |
| Commands and the list                            | `packages/core/src/commands/practice.ts`, `packages/core/src/queries/practice.ts`                                                                                                                              |
| Words, flows, how long and how many              | `packages/core/src/practice/words.ts`                                                                                                                                                                          |
| The stand-ins and the email swap                 | `apps/worker/src/practice/`                                                                                                                                                                                    |
| Admin → Try onboarding                           | `apps/web/src/app/admin/try/`, `apps/web/src/components/practice/`                                                                                                                                             |
| The practice sign-up and checkout                | `apps/web/src/app/try/`; `practice` on `SignUpForm`, `CreateBusiness` and `PickPlan`                                                                                                                           |
| An offer link's details, the affiliate one       | `apps/web/src/lib/practice-link.ts`; `practice` on `AffiliateSelf`                                                                                                                                             |
| The banner with End practice                     | `PracticeBanner`, in the business's layout and the setup's layout                                                                                                                                              |
| Tests                                            | `packages/db/test/practice-businesses.test.ts`, `practice-more-flows.test.ts`, `packages/core/test/practice-commands.test.ts`, `apps/worker/test/practice-kit.test.ts`, `apps/web/e2e/try-onboarding*.spec.ts` |

## Not yet

- **The stand-ins live in the worker's memory.** A worker restart forgets a "bought" number or a "connected" calendar; the business itself is kept.
- **GoHighLevel imports aren't pretended.** One reads from the real account you connect, which changes nothing there.
- **A discount code's price** shows on the stand-in checkout, but its trial is the one the plan page worked out.
- **An affiliate's link credits nobody**, and nothing on a customer's screens shows it, so practising one only says what a real sign-up would credit.
- **The agency's own sign-up** (the agency switch on the setup's first screen) isn't practised: the agency flow starts where Add a business opens a client's setup.
