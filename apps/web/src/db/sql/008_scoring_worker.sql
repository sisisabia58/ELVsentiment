-- Scoring pass for worker_role. app_user tenant policies are unchanged.
-- Lease columns let a later run reclaim a dead claim. This file is unapplied;
-- 001-007 stay byte-identical. Table-level grants already cover the new columns.
alter table mentions add column if not exists scoring_claimed_at timestamptz;
alter table mentions add column if not exists scoring_attempts integer not null default 0;

grant select on projects to worker_role;
grant select, insert on jev_results to worker_role;

create policy projects_worker on projects
  for select to worker_role
  using (true);

create policy mentions_worker_read on mentions
  for select to worker_role
  using (true);

create policy mentions_worker_update on mentions
  for update to worker_role
  using (true)
  with check (true);

create policy jev_results_worker_read on jev_results
  for select to worker_role
  using (true);

create policy jev_results_worker_insert on jev_results
  for insert to worker_role
  with check (true);
