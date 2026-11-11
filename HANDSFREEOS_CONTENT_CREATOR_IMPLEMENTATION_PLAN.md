# AI Social Media Content Creator: the plan

A new add-on, **AI Social Media Content Creator** (id `socialcontent`, in Marketing), that helps a business plan its own
social media content from what already works for others. Its first feature, asked for by Chris on 8 Nov 2026:

> It finds other creators in the same niche and/or similar niches that have done well, then researches their best
> performing content, current and historical. Followers and engagement grow over time, so we don't only look at what
> has the most engagement: we look at what did better than the content around it (5 posts, one with 100 likes or
> comments and the other 4 between 20 and 50: focus on the one with 100). Then it works out why it did well and
> writes down the key notes, techniques and methods, so we can plan our own content from them.

The rules and what's built are in `docs/socialcontent.md`. The questions and their answers are in the project's
`content-creator/questions.md`.

## Decisions (Chris, 2026-11-08)

| Question                                | Answer                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The extension                        | **One extension, "HandsFreeOS Social", for both add-ons.** It already reads the networks' pages, and one extension keeps one pace per account, so research and outreach together don't trip a network's blocks. Still loaded by hand, never on the Chrome Web Store.                                                        |
| 2. Which networks first                 | **Instagram, Facebook and LinkedIn first** (the extension reads them already), **then TikTok and YouTube**.                                                                                                                                                                                                                 |
| 3. How it reads other creators' posts   | **Everything through the extension**, YouTube too: no API, no paid data service.                                                                                                                                                                                                                                            |
| 4. Finding creators                     | **The AI suggests 3 to 5 similar niches** from the business's profile, finds creators in its niche and those, and **a person ticks who to study**. Anyone can add a creator themselves too.                                                                                                                                 |
| 5. What "done well" means for a creator | **At least 5,000 followers, posted in the last 30 days, and has posts that clearly beat their own normal.**                                                                                                                                                                                                                 |
| 6. What makes a post a standout         | **Compare it with the 10 posts before it and the 10 after it: at least 2 times their middle number** (the median). Posts under 7 days old wait, since they're still growing.                                                                                                                                                |
| 7. Which number it compares             | **Either: views (for videos, where the site shows them) or likes plus comments.** A post that stands out on either counts, and says which.                                                                                                                                                                                  |
| 8. How far back                         | **The last 12 months in full, plus their all-time most popular posts** where the site sorts by popular (TikTok and YouTube).                                                                                                                                                                                                |
| 9. What the AI looks at                 | **The caption, the numbers, the cover image, the top comments and the spoken words where the site shows captions; and watching the video itself (what's on screen and the sound) as an option the business turns on**, with a notice that it uses more AI, and **a way to try watching on a few videos** before a full run. |
| 10. What you get                        | **Notes on each standout** (hook, topic, format, length, how it's built, call to action, why it worked), **one Playbook page** that sums up what keeps working, **and a short list of content ideas** built from it.                                                                                                        |
| 11. How often                           | **Each creator studied once a week** for new standouts, **new creators once a month**, with **Find creators now** and **Read again now**.                                                                                                                                                                                   |
| 12. Whose list                          | **One list of creators and one Playbook for the whole business.** Reading runs on the computer of whoever turns it on.                                                                                                                                                                                                      |

## How it fits

- **Its own add-on.** A business can want content help without outreach, or outreach without content help, so each
  turns on by itself. It was on the planned list under the same id, so its votes carry over.
- **The extension works for both, and never mixes them.** It signs in where either add-on is on, does each add-on's
  work only where that add-on is on, and sends this add-on's work only through `socialcontent.*` operations. Add-ons
  never touch each other's data, so the pace on each network and a network's "stopped for the day" are the
  extension's own (the same browser and the same account), not a row in either add-on's tables.
- **Its own tables, not records.** Creators and their posts are research about people outside the business, many rows
  of mostly numbers: they live in `addon_socialcontent`, not as records of a kind it manages. A creator never becomes
  a customer.
- **The standout math lives once, in core** (`standouts.ts`), so the web, the phone and the worker show the same. It's
  worked out again for a creator's posts every time their posts are saved, since each post's neighbours change.
- **What the computer is asked to do is a queue** (`addon_socialcontent.work`): find creators for a niche on a
  network, read a creator's profile, read a creator's posts, and later watch a video. Only the business's reading
  computer (the person picked in Settings) takes it, one at a time: a ticked or added creator first, then searches,
  then the weekly and monthly reads, each oldest first (9 Nov 2026: a queue of searches had kept ticked creators
  waiting a day).
- **The AI** writes the similar niches and the words to search each network for them, and later each standout's notes,
  the Playbook and the ideas. Its use counts under `app.ai_usage` as the add-on's.
- **Its pages** are one row in the side menu, **AI Social Media Content Creator**, with its pages popping out:
  **Creators**, **Standouts**, **Playbook** (part 3) and **Settings**. On the web, and on the phone from part 5.

## The parts

Each part is its own pull request.

1. **The add-on, its tables and the standout math (this part).** The manifest, the migration, niches (the AI suggests
   them, a person ticks them, or adds one), creators (added by link, ticked to study or skipped), the work queue the
   extension will take from, saving posts with the standout math, the weekly and monthly checks that queue reading,
   and the web's Creators, Standouts and Settings pages.
2. **Instagram, through the extension.** It signs in where either add-on is on; on the reading computer it takes the
   queue's work at a person's pace, sharing Instagram's pace and warnings with outreach's: searches the niche's
   hashtags and accounts for creators, reads each one's profile, and reads a studied creator's posts back 12 months
   with their views, likes and comments.
3. **The AI's notes, the Playbook and the ideas.** For each standout: the caption, the numbers against its neighbours,
   the cover image, the top comments and the spoken words where shown. The Playbook page sums up what keeps working,
   and the ideas list turns it into posts for the business.
4. **Watching the videos.** A switch in Settings, off to start, with the notice that it uses more AI, and **Try it on a
   few videos**: the person picks up to 5 standouts and sees what watching adds, without turning the switch on.
5. **The phone's pages.** Built (9 Nov 2026): one row under More opening a first screen of its pages, and Creators,
   Standouts, the Playbook, Ideas and Settings, each as the web's, with signal.
6. **Facebook and LinkedIn.**
7. **TikTok and YouTube**, with their popular-first sort for the all-time best.

## Numbers to start with

- A creator counts as having done well with **5,000 followers or more** and **a post in the last 30 days**
  (`DONE_WELL`). A creator someone adds themselves is studied whatever their size.
- A standout is **2 times or more** the median of up to **10 posts each side**, with at least **4** neighbours to judge
  by, and **10** likes and comments or **500** views at the least, so a post with 3 likes isn't a standout next to
  posts with 1. Posts under **7 days** old wait (`STANDOUT`).
- Reading goes back **12 months**; a weekly read takes new posts and the numbers of posts from the last 60 days, which
  still grow.
- Finding reads at most **30 profiles** for each niche on each network at a time.

## Making and posting the business's own content (Chris, 2026-11-10)

The research works (10 Nov 2026: creators read, standouts noted, a Playbook and ideas). Chris asked what's next for
"creating the content, creating a calendar of content, and then using the extension to post that content". The plan
and its eight questions are in the Claude Doc "Content Creator: write, plan and post"; Chris answered
"1a 2a&b 3a&b 4a 5c 6a 7a 8a" at 19:17 UTC, and at 19:19: "for the image ai we can use claude design technology as
well as open ai image generation depending on the image". Facebook and LinkedIn research stay off in his business
for now on purpose, and TikTok and YouTube (part 7) wait.

| Question                    | Answer                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13. Where it lives          | **Inside this add-on**, as one more page: **Calendar**. Add-ons can't share data, so the planned Social Media Scheduler couldn't see these ideas.                                                                                                                               |
| 14. Pictures                | **The person's own photos and videos, and AI pictures from the start.** **Claude designs** the pictures with words on them (carousel slides, tips, quotes, in the business's colour); **OpenAI makes** the photo-style ones. The AI picks for each post; the person can switch. |
| 15. The OK before it posts  | **Both:** every post waits for an OK, and **OK the week** OKs every finished post in the next 7 days in one go.                                                                                                                                                                 |
| 16. Instagram               | **The extension posts it** from the computer, with the photo or video.                                                                                                                                                                                                          |
| 17. Which Facebook          | **Both** the person's profile and the business's Page: Settings names the Page, and each Facebook post says where it goes.                                                                                                                                                      |
| 18. How far ahead           | **Two weeks**, topped up each week.                                                                                                                                                                                                                                             |
| 19. Learning from own posts | **Yes:** the business's own posts are read after 2 and 7 days, and its own standouts go into the Playbook beside the creators'.                                                                                                                                                 |
| 20. The phone               | **Calendar, editing and the OK on the phone too.**                                                                                                                                                                                                                              |

### How it fits

- **Each post the business makes is a record** of a kind this add-on manages, **Social post**, so its pictures are
  core files on it (the person's photos upload the way any record's files do), its history is a timeline, and search
  finds it. What only a post has (its network, words, hashtags, slides or script, when it goes, whether it's OK'd and
  where it went) is the add-on's own row about the record, `addon_socialcontent.content`.
- **The AI writes, a person OKs.** A post the AI writes waits as a draft; nothing goes up without an OK (risk 2).
  Changing an OK'd post's words or pictures takes its OK back.
- **The calendar is the plan in Settings:** how many posts a week on each network, and roughly when. Filling it takes
  ideas (saved ones first, then new), writes a post for each empty slot in the next 14 days, and marks the idea used.
  It fills on its own once a week, and on **Fill the calendar** now.
- **Pictures are made in the worker.** A designed picture is Claude's design (a layout, the words, the colours),
  drawn to a PNG by the worker; a photo-style one is OpenAI's, from the AI's description of it. Either is kept as a
  file on the post. A made photo is charged per picture on the balance (`ai.image`); a design is charged as the AI's
  words, like any other ask.

### The parts

8. **Write and plan on the web (this part).** Social posts, writing one from an idea (or again), designed and
   photo-style pictures and the person's own photos, the calendar with its plan, the OK and OK the week.
9. **Posting on Facebook and LinkedIn** through the extension, after the OK, at its time.
10. **Posting on Instagram** through the extension, with the person's videos too.
11. **Learning from the business's own posts**: their numbers after 2 and 7 days, and its standouts in the Playbook.
12. **The phone's pages** for all of it.
