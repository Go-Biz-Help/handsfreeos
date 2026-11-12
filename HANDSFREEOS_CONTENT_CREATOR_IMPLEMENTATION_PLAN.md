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

## A schedule it learns, and setting up on its own (the owner, 2026-11-12)

The owner asked (06:17 UTC): "i want a fully editable schedule but also i want the ability to set a number of weekly
posts and/or how many posts a day and the AI smartly schedules them but it learns and adapts over time ... if it learns
that posting at a certain time gets more activity then it leans closer to posting at that time. also the initial setup
should be more autonomous, finds the creators, determines which are the closest to exactly what we do and have a good
following and good engagement then chooses those to learn from, reads their profile and makes the notes etc and then
starts filling the calendar, this should all be adjustable by the user." Thirteen questions went back, and the owner
answered "1a 2a 3b 4a 5a 6a 7b 8a 9a 10a 11a 12a (also waits for the main offer and the for your content section) 13a"
at 06:34 UTC. Creator research stays on Instagram.

| Question                           | Answer                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 21. How each network is planned    | **Each network picks one: I pick** (tick the days, and any times on each, up to 3 a day) **or AI picks** (you give how many, it picks the days and times).                                       |
| 22. What AI picks is given         | **Posts a week, and a most a day if wanted.** Without one, it spreads them out, one a day until there are more posts than days.                                                                  |
| 23. What "more activity" means     | **Views where the network shows them** (Instagram), **otherwise likes plus comments**, against the business's own normal, as standouts are (decision 7).                                         |
| 24. When it may post               | **Between the hours set for each network** (7 AM to 8 PM to start). Posts go up from the reading computer, so a time only works while Chrome is open there.                                      |
| 25. Before its own posts have told | **It starts from the times the studied creators' best posts went up**, in the business's time zone.                                                                                              |
| 26. Still learning                 | **About 1 in 5 of the AI's times are a new hour**, the one it knows least about, so it keeps learning.                                                                                           |
| 27. When it learns a better time   | **Every post that hasn't gone up moves to it, OK'd ones too** (on the same day), unless a person set that post's time.                                                                           |
| 28. When setup starts              | **On its own, once the add-on is on and the reading computer is picked.**                                                                                                                        |
| 29. Niches                         | **It ticks the business's own niche and the 2 closest**; the rest wait for a person.                                                                                                             |
| 30. Which creators                 | **The best 10 on each network**: the closest match (the AI reads their bio and recent posts), 5,000+ followers, posted in the last 30 days, and the best likes and comments for their followers. |
| 31. Keeping the list fresh         | **Once a month it swaps out creators who stopped posting or rarely stand out**, never ones a person ticked or added.                                                                             |
| 32. When it starts writing         | **Once the Playbook is written, or after 3 days anyway, and only once the main offer is live and its For your content lists are filled.**                                                        |
| 33. The OK                         | **Posts still wait for an OK**, as now (decision 15).                                                                                                                                            |

### The parts

13. **The schedule (this part).** I pick or AI picks on each network in Settings → Posting, on the web and the phone;
    the AI's times from the creators' best posts and then the business's own, with about 1 in 5 tried at a new hour;
    and posts not up yet moved when it learns a better time.
14. **Setting up on its own (this part).** Niches, the best 10 creators, their notes and the Playbook without a press,
    then the calendar filling, each step shown and each one a person can change. It needs extension 0.136.0 for each
    creator's latest likes and comments, and migration 026300.

## Variety, news and facts, and pictures that don't look alike (the owner, 2026-11-12)

The owner asked (17:58 UTC): "currently the AI social media creator calendar is mostly the same topic, missed call
text. why is that? i feel we need more variety no?" Its ideas had run out, so every post was written alone from the
same Playbook and the offer's first line. Four questions went back, and the owner answered "1a 2a 3a 4a, also it should
do research online for news or interesting facts about the niche and/or look at posts from other creators that match
things the user would posts" (18:06 UTC), then "it looks like the system is only using the claude design and the
designs always look the same currently, also it needs to throw in some open ai images too when it's appropriate but
make sure to have it look like a user created it in canva or photoshop or something" (18:09 UTC). Every one of the
owner's 42 AI posts was a designed carousel in one of 3 layouts. Eight more questions went back, and the owner picked
"1a 2a 3a 4a 5a&b depending on results as open ai doesn’t misspell words much anymore (the system should have built in
quality control though to make sure things look right) 6a 7a 8a" (19:00 UTC): the recommended answers, plus OpenAI's
whole graphics and a check on every picture (decision 40).

| Question                        | Answer                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 34. What each post is about     | **Its own line from the main offer's For your content lists**, the lists taking turns, the line used longest ago first; the AI sees the business's last 20 posts and never repeats a hook.            |
| 35. Ideas                       | **10 more on their own whenever fewer than 5 wait**, each planned as a kind and a line before the AI writes it.                                                                                       |
| 36. The weekly mix              | **Of every 10 posts, about 4 tips, 2 customer problems, 2 stories and 2 about the offer**, never the same kind twice in a row.                                                                        |
| 37. The drafts from before      | **Written again** with the variety, on the same days and times, unless a person touched them.                                                                                                         |
| 38. News and facts found online | **Once a week, about 5 web searches**, keeping up to 10 news items or facts as ideas, each with its page; a post names its source in plain words; 2 of the 4 tips in every 10 use one when one waits. |
| 38. Creators' posts that match  | **The studied creators' posts closest to each post's topic** are shown to the writer as examples, never copied.                                                                                       |
| 39. Pictures                    | **12 layouts, 4 fonts and colours from the brand colour**, never starting the way the last two did; about half carousels and half single pictures; words alone now and then on Facebook and LinkedIn. |
| 39. OpenAI's photos             | **About 3 in 10 posts with pictures have a photo OpenAI makes under the words**, like a Canva design, never two in a row (9¢ each); on a carousel it goes under the first slide.                      |
| 40. Checking every picture      | **Claude looks at each picture beside its words before it's kept**; a drawn design that fails is designed once more, told what to fix.                                                                |
| 40. OpenAI's whole graphics     | **OpenAI makes a single photo picture words and all, every other time while the last ones passed the check**; one that fails is never kept, and after 2 of 4 fail it waits 4 photo posts.             |

### The parts

15. **Variety (this part).** The mix, topics, ideas that refill, recent posts shown, the old drafts written again,
    the weekly look online (`socialcontent.research`, charged 2¢ a search as `ai.web_search`), creators' posts as
    examples, the pictures' layouts, fonts, colours, formats and photos, the check on every picture and OpenAI's
    whole graphics (`check-ai.ts`). Migration 026500 adds the kind and topic
    to posts and ideas, an idea's source, the search's price, and runs the calendar half an hour later so the drafts
    are written again.
