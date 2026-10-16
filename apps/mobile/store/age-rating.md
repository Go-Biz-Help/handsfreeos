# Age rating and content rating

Both consoles ask a questionnaire and work the rating out themselves. The answers below are the app's honest ones;
where a question turns on judgement rather than fact, it says so and says what to answer and why. **The console's own
wording wins** — Apple rewrote its questionnaire in 2025 and Google's IARC form changes too, so read each question as
it appears and match it to the fact, not to a remembered label.

## The facts a questionnaire needs

| Fact                                                                                                 | True of this app                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Violence, sex, nudity, profanity, horror, gambling, contests, alcohol, tobacco, drugs, weapons, hate | None. Nothing of the kind appears anywhere                                                                                                                                                                                                   |
| Medical or treatment information                                                                     | None                                                                                                                                                                                                                                         |
| Real-money gambling, loot boxes, in-app purchases                                                    | None. The app sells nothing                                                                                                                                                                                                                  |
| An in-app browser that can reach any site                                                            | No. Desk work opens **specific** HandsFreeOS pages in the system browser (`src/lib/open-web.ts`); there is no address bar anywhere in the app                                                                                                |
| Messaging                                                                                            | Yes, but not between strangers: a signed-in member of a business texts or emails **that business's own customers**. There is no directory, no discovery, no user-to-user social feature, and nothing is public                               |
| User-generated content shown to other users                                                          | Only within one business, to teammates who already share its records                                                                                                                                                                         |
| Location shared with other users                                                                     | Yes, by the person's own choice: a check-in tells the safety contacts they picked, and the business's safety person, where they are (`src/safety/`). On my way sends only an arrival time to the customer, never the spot. Nothing is public |
| Who the app is for                                                                                   | Business owners and their crews. It is useless without a HandsFreeOS account                                                                                                                                                                 |

## App Store — Age Rating

Answer **None** to every content question (violence, sexual content, profanity, horror, gambling, contests,
alcohol/tobacco/drugs, medical information, mature themes).

For the capability questions:

| Question (whatever it is called this year) | Answer    | Why                                                                                                   |
| ------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------- |
| Unrestricted web access                    | No        | No in-app browser and no address bar. Links open specific HandsFreeOS pages in Safari                 |
| Gambling                                   | No        | —                                                                                                     |
| Contests                                   | No        | —                                                                                                     |
| Messaging, chat, or user-generated content | **Yes**   | The inbox. Say yes: it is a messaging feature, even though both sides are the business's own contacts |
| Moderation of that content                 | See below | —                                                                                                     |
| Made for Kids                              | No        | —                                                                                                     |

Apple's follow-up to the messaging question asks how that content is moderated, and it is the one answer Chris should
give himself, because it is about how Go Biz Help runs the service rather than about the code. The true answer is that
each business's conversations are private to that business and its customers, that there is no public or
stranger-to-stranger surface to moderate, and that a business can close or hand over any conversation. Apps like this
are normally rated **4+**; if Apple's wording pushes the rating up because of the messaging answer, take the higher
rating rather than shading the answer.

**Expected outcome:** 4+, possibly 13+ depending on how the messaging question is worded.

## Google Play — Content rating (IARC)

| Question                                                                             | Answer                                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Category                                                                             | Utility, Productivity, Communication or Other                                                              |
| Violence, sexuality, language, controlled substances, crude humour, horror, gambling | No to all                                                                                                  |
| Does the app allow users to interact or exchange content with other users?           | **Yes** — the inbox, and teammates sharing one business's records                                          |
| Can users interact with people they don't know?                                      | No. Everyone in a business is invited by that business, and every customer is one the business already has |
| Does the app let users share their location with other users?                        | **Yes** — a check-in shares where the person is with the safety contacts they chose, until they check out  |
| Does the app allow the purchase of digital goods?                                    | No                                                                                                         |
| Does the app contain unrestricted internet access (a browser or search engine)?      | No                                                                                                         |
| Does the app share user-provided personal information with third parties?            | No — see [`privacy-play.md`](privacy-play.md)                                                              |
| Is the app a news app?                                                               | No                                                                                                         |
| Is the app designed for children?                                                    | No. Target audience is 18 and over                                                                         |

**Expected outcome:** Everyone (ESRB) / PEGI 3 / Rated for 3+, with the "Users Interact" and "Shares Location" notices on
the listing, which are correct and should be kept.
