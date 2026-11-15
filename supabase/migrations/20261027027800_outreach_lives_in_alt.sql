-- Decision 169 (docs/outreach.md): beside a "Lives in" on someone's profile, a second country is kept only when the AI's
-- look says they really live there (`lookedCountry`). Until now the AI's second country was kept beside a "Lives in" it
-- agreed with too, and that was mostly where they're from ("Lives in Brookings, South Dakota; originally from
-- Honduras"), which put them on the Not sure where they live list. Which of the kept ones the AI agreed with isn't
-- known, so each is let go: their "Lives in" decides, as it does for anyone a look agreed with.
update addon_outreach.profiles
   set country_alt = null
 where country_how = 'seen'
   and country_alt is not null;
