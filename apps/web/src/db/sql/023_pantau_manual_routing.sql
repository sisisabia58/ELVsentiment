create table pantau_manual_routes (
  mention_id uuid primary key,
  customer_id uuid not null,
  project_id uuid not null,
  source text not null,
  destination text check (destination in ('attention', 'ambiguous')),
  routed_at timestamptz,
  previous_destination text check (previous_destination in ('attention', 'ambiguous')),
  previous_routed_at timestamptz,
  revision uuid not null,
  undoable boolean not null,
  unique (mention_id, customer_id),
  foreign key (mention_id, customer_id, project_id, source)
    references mentions (id, customer_id, project_id, source) on delete cascade,
  check ((destination is null) = (routed_at is null)),
  check ((previous_destination is null) = (previous_routed_at is null))
);

-- Keep accepted request identities across later writes so a delayed retry
-- returns the current choice even after another tab has changed it.
create table pantau_manual_route_requests (
  mention_id uuid not null,
  customer_id uuid not null,
  request_id uuid not null,
  primary key (mention_id, request_id),
  foreign key (mention_id, customer_id)
    references pantau_manual_routes (mention_id, customer_id) on delete cascade
);

alter table pantau_manual_routes enable row level security;
alter table pantau_manual_routes force row level security;
alter table pantau_manual_route_requests enable row level security;
alter table pantau_manual_route_requests force row level security;

create policy pantau_manual_routes_tenant on pantau_manual_routes to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy pantau_manual_requests_tenant on pantau_manual_route_requests to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);

grant select, insert on pantau_manual_routes, pantau_manual_route_requests to app_user;
grant update (destination, routed_at, previous_destination, previous_routed_at, revision, undoable)
  on pantau_manual_routes to app_user;
