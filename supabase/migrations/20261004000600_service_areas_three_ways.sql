-- =============================================================================
-- 0097 · Service areas, three ways (M18 step 2). A service area (a territory)
--        was a list of ZIP codes. Now it can also be:
--          · radius  — so many miles from an address (its point kept, found
--                      once on the map when the area is saved);
--          · polygon — a shape drawn on the map, as its corners.
--        A business can have several, each with the people who cover it, and
--        a calendar that routes by service area checks the customer against
--        them: their ZIP for ZIP areas, where their address is for the others.
--
--        app.geocodes keeps each address the worker looked up (hashed), so an
--        address is looked up once and kept.
-- =============================================================================

alter table app.territories
  add column kind text not null default 'zip' check (kind in ('zip', 'radius', 'polygon')),
  add column center_address text check (center_address is null or length(center_address) <= 300),
  add column center_lat double precision check (center_lat is null or center_lat between -90 and 90),
  add column center_lng double precision check (center_lng is null or center_lng between -180 and 180),
  add column radius_miles numeric(6, 2) check (radius_miles is null or radius_miles between 0.1 and 250),
  -- [[lat, lng], …]: at least three corners, at most 200.
  add column polygon jsonb check (
    polygon is null or (jsonb_typeof(polygon) = 'array' and jsonb_array_length(polygon) between 3 and 200)
  ),
  add constraint territories_kind_shape check (
    case kind
      when 'zip' then center_lat is null and center_lng is null and radius_miles is null and polygon is null
      when 'radius' then center_lat is not null and center_lng is not null and radius_miles is not null
        and polygon is null and cardinality(postal_codes) = 0
      when 'polygon' then polygon is not null and center_lat is null and center_lng is null
        and radius_miles is null and cardinality(postal_codes) = 0
    end
  );

create table app.geocodes (
  -- sha256 of the address as asked, trimmed and lower-cased.
  query_hash text primary key check (length(query_hash) = 64),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  postal_code text check (postal_code is null or postal_code ~ '^[0-9]{5}$'),
  created_at timestamptz not null default now()
);

alter table app.geocodes enable row level security;
-- Not a business's data: a public place for an address. Only the worker reads and writes it.
create policy geocodes_service_all on app.geocodes for all to service_actor using (true) with check (true);
grant select, insert on app.geocodes to service_actor;
revoke all on app.geocodes from anon, authenticated;
