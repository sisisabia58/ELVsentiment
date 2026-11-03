create table project_schedules (
  project_id uuid primary key references projects (id),
  customer_id uuid not null references customers (id),
  enabled boolean not null default false,
  interval_hours integer not null check (interval_hours >= 1),
  time_zone text not null default 'Asia/Jakarta',
  next_run_at timestamptz,
  last_collected_at timestamptz
);

create table jobs (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  kind text not null check (kind in ('scheduled', 'manual')),
  status text not null check (status in ('queued', 'claimed', 'succeeded', 'deferred', 'failed')),
  run_after timestamptz not null,
  claimed_by text,
  claimed_at timestamptz,
  status_detail text,
  created_at timestamptz not null
);

create table source_cursors (
  customer_id uuid not null references customers (id),
  query_key text not null,
  source text not null check (source in ('x', 'threads')),
  incremental_cursor text,
  incremental_since timestamptz,
  backfill_cursor text,
  backfill_complete boolean not null default false,
  last_success_at timestamptz,
  last_error text,
  primary key (query_key, source)
);

create table worker_heartbeat (
  id integer primary key check (id = 1),
  worker_id text not null,
  last_seen_at timestamptz not null
);

grant select, insert, update, delete on project_schedules, jobs, source_cursors to app_user;
grant select on worker_heartbeat to app_user;
grant select, insert, update, delete on project_schedules, jobs, source_cursors to worker_role;
grant select, insert, update on mentions, worker_heartbeat to worker_role;
grant select on keyword_variants to worker_role;

alter table project_schedules enable row level security;
alter table project_schedules force row level security;
alter table jobs enable row level security;
alter table jobs force row level security;
alter table source_cursors enable row level security;
alter table source_cursors force row level security;
alter table worker_heartbeat enable row level security;
alter table worker_heartbeat force row level security;

create policy project_schedules_tenant on project_schedules
  for all to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy jobs_tenant on jobs
  for all to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy source_cursors_tenant on source_cursors
  for all to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy worker_heartbeat_read on worker_heartbeat
  for select to app_user
  using (true);

create policy project_schedules_worker on project_schedules
  for all to worker_role using (true) with check (true);
create policy jobs_worker on jobs
  for all to worker_role using (true) with check (true);
create policy source_cursors_worker on source_cursors
  for all to worker_role using (true) with check (true);
create policy worker_heartbeat_worker on worker_heartbeat
  for all to worker_role using (true) with check (true);
create policy keyword_variants_worker on keyword_variants
  for select to worker_role using (true);
