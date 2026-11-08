-- Allow worker_role to upsert source health. app_user policies are unchanged.
-- No delete grant is added.
grant select, insert, update on source_status to worker_role;

create policy source_status_worker_select on source_status
  for select to worker_role using (true);

create policy source_status_worker_insert on source_status
  for insert to worker_role with check (true);

create policy source_status_worker_update on source_status
  for update to worker_role using (true) with check (true);
