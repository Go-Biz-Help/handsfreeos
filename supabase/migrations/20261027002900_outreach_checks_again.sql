-- Social Outreach: Check everyone again (docs/outreach.md, decision 46). The person can put everyone their computer
-- has checked back on the list, so the AI reads them again with what it knows now; what it said stays on show until
-- then. Only adds a column.
alter table addon_outreach.checks add column again boolean not null default false;
