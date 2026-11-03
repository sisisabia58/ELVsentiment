create table x_read_counters (
  customer_id uuid not null,
  period_start date not null,
  posts_reserved integer not null,
  primary key (customer_id, period_start)
);

create table threads_query_log (
  id uuid primary key,
  queried_at timestamptz not null
);

grant select on x_read_counters to app_user;
grant select, insert, update on x_read_counters, threads_query_log to worker_role;

alter table x_read_counters enable row level security;
alter table x_read_counters force row level security;
alter table threads_query_log enable row level security;
alter table threads_query_log force row level security;

create policy x_read_counters_tenant on x_read_counters
  for select to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid);
create policy x_read_counters_worker on x_read_counters
  for all to worker_role using (true) with check (true);
create policy threads_query_log_worker on threads_query_log
  for all to worker_role using (true) with check (true);
