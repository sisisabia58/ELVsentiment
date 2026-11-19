create table scheduled_provider_calls (
  id uuid primary key,
  job_id uuid not null,
  platform text not null check (platform in ('threads','tiktok','instagram')),
  reserved_at timestamptz not null default clock_timestamp(),
  outcome text not null default 'reserved' check (outcome in ('reserved','success','partial','failed')),
  credits_charged bigint check (credits_charged >= 0),
  http_status integer
);
create index scheduled_provider_calls_window on scheduled_provider_calls (reserved_at);
alter table scheduled_provider_calls enable row level security;
alter table scheduled_provider_calls force row level security;
grant select, insert, update on scheduled_provider_calls to worker_role;
create policy scheduled_provider_calls_worker on scheduled_provider_calls
  for all to worker_role using (true) with check (true);
