create table instant_search_continuations (
  search_id uuid not null,
  customer_id uuid not null,
  platform text not null,
  route text not null,
  cursor text check (octet_length(cursor) between 1 and 4096),
  companion text check (octet_length(companion) between 1 and 1024),
  available boolean generated always as (cursor is not null) stored,
  generation integer not null default 0 check (generation between 0 and 3),
  expires_at timestamptz not null,
  collected_at timestamptz not null default now(),
  primary key (search_id, platform),
  foreign key (search_id, customer_id) references instant_searches (id, customer_id) on delete cascade,
  foreign key (search_id, platform) references instant_search_sources (search_id, platform) on delete cascade
);

create index instant_search_continuations_expiry_idx
  on instant_search_continuations (expires_at) where available;

create table instant_search_more_jobs (
  id uuid primary key,
  search_id uuid not null,
  customer_id uuid not null,
  platform text not null,
  generation integer not null check (generation between 0 and 2),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  new_result_count integer check (new_result_count >= 0),
  safe_detail text,
  cursor_hash text,
  unique (search_id, platform, generation),
  foreign key (search_id, customer_id) references instant_searches (id, customer_id) on delete cascade,
  foreign key (search_id, platform) references instant_search_continuations (search_id, platform) on delete cascade
);

create index instant_search_more_queue_idx on instant_search_more_jobs (created_at) where status in ('queued','running');
create index instant_search_more_customer_idx on instant_search_more_jobs (customer_id, created_at desc);

-- Preserve provider receipts even when the parent search and page job expire.
alter table search_credit_ledger add column more_job_id uuid;
create unique index search_credit_ledger_more_job_idx on search_credit_ledger (more_job_id);

alter table instant_search_continuations enable row level security;
alter table instant_search_continuations force row level security;
alter table instant_search_more_jobs enable row level security;
alter table instant_search_more_jobs force row level security;

grant select (search_id, customer_id, platform, available, generation, expires_at)
  on instant_search_continuations to app_user;
grant select (id, search_id, customer_id, platform, generation, status, created_at, new_result_count)
  on instant_search_more_jobs to app_user;
grant insert (id, search_id, customer_id, platform, generation) on instant_search_more_jobs to app_user;
grant select, insert, update on instant_search_continuations, instant_search_more_jobs to worker_role;

create policy instant_search_continuations_tenant on instant_search_continuations
  for select to app_user using (customer_id = current_setting('app.customer_id', true)::uuid);
create policy instant_search_more_jobs_tenant on instant_search_more_jobs
  for select to app_user using (customer_id = current_setting('app.customer_id', true)::uuid);
create policy instant_search_more_jobs_request on instant_search_more_jobs
  for insert to app_user with check (
    customer_id = current_setting('app.customer_id', true)::uuid and exists (
      select 1
      from instant_search_continuations c
      join instant_searches s on s.id = c.search_id and s.customer_id = c.customer_id
      where c.search_id = instant_search_more_jobs.search_id
        and c.customer_id = instant_search_more_jobs.customer_id
        and c.platform = instant_search_more_jobs.platform and c.generation = instant_search_more_jobs.generation
        and c.available and c.expires_at > now() and s.retention_expires_at > now()
        and s.status in ('succeeded','partial') and s.finished_at is not null
    )
  );
create policy instant_search_continuations_worker on instant_search_continuations
  for all to worker_role using (true) with check (true);
create policy instant_search_more_jobs_worker on instant_search_more_jobs
  for all to worker_role using (true) with check (true);
