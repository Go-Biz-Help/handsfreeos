-- =============================================================================
-- 0100 · Relationships, part 1: enum values and types.
--
--        A business keeps more than people and companies: the pets a groomer
--        sees, the cars a shop services, the properties and units a manager
--        lets. Part 2 (0101) gives them a home — kinds of records a business
--        makes up for itself — and lets any person, company or record be
--        related to any other, in both directions.
--
--        Two existing enums gain 'custom_record', so a record of a kind the
--        business made up can hold files (app.record_type) and fields of its
--        own (app.custom_field_entity). They are added in a migration of their
--        own because Postgres can't use a new enum value in the transaction
--        that adds it, exactly as 0030 and 0081 did; everything that uses them
--        follows in 0101 (20261005000200).
-- =============================================================================

alter type app.record_type add value if not exists 'custom_record';
alter type app.custom_field_entity add value if not exists 'custom_record';

-- What each end of a relationship may be: a person, a company, or a record of one kind the business made up.
create type app.relationship_end as enum ('person', 'company', 'custom_record');

-- How many on each end, read from end A to end B: one_to_many is one A with many Bs, each B with one A.
-- Nothing is assumed to be one-to-one: a new relationship type is many_to_many unless somebody says otherwise.
create type app.relationship_cardinality as enum ('one_to_one', 'one_to_many', 'many_to_one', 'many_to_many');
