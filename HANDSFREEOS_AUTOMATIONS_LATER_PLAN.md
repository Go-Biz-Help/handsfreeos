# Automations — what waits for its own feature

These automations were on the list, but each one watches something HandsFreeOS doesn't have yet. They join
Settings → Automations when the feature they watch ships, not before, so the page never has a switch that does
nothing. ([The main plan](HANDSFREEOS_AUTOMATIONS_IMPLEMENTATION_PLAN.md).)

## Marketing and content

Needs social posting, a blog, email campaigns and customer-facing promotions. Today messaging is one conversation
at a time, and "offers" only means waitlist offers.

| Automation                                  | What it needs first                                                   |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Nothing scheduled on social / planner empty | A social planner connected to the business's accounts                 |
| No email going out                          | Email campaigns (bulk email with an unsubscribe flow)                 |
| Blog going quiet                            | A blog, or a connection to the business's own                         |
| Pre-publish content check                   | Any of the above: a daily read of everything due out in the next 24 h |

"Offer lapsing" shipped as **Offer ending** on top of Knowledge → Offers, which already had start and end dates, and
campaigns can now be about an offer. "Drafts awaiting review" is already live: it covers AI drafts and approvals, and campaigns join it in stage 5.

## Ads

Needs Meta Ads and Google Ads connections, and tying leads to the ad that brought them. Today leads carry only a
free-text `source`, with no UTM fields.

| Automation                     | What it needs first                                  |
| ------------------------------ | ---------------------------------------------------- |
| Cost per enquiry moved         | Daily ad spend per platform, and leads matched to it |
| One ad platform costs far more | The same, for two or more platforms                  |
| Spend with no enquiries        | Daily ad spend, and leads by source                  |

"Revenue moved" doesn't need ads. It comes from payments and ships in stage 4a.

## Outbound calls

Needs an AI voice agent. Today calls ring people or go to voicemail and get transcribed, and the AI teammate
works by text, email and chat only. When voice arrives, "Outbound calls" slots into Appointments. It follows the
same training rule: calls wait for approval while the teammate is training.

## When each one ships

Each automation follows the main plan's checklist: a catalog row, a switch, an Adjust panel, and an Action
Center kind or a job. Customer-facing ones follow training mode, and money always asks first.
