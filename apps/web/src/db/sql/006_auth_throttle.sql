-- Sign-in and sign-up share a small failure counter. The key is a hash the
-- server sets, not an email and not a customer id, so one tenant cannot read
-- another's attempts. There is no SECURITY DEFINER function.
create table auth_throttle (
  attempt_key text primary key,
  failures integer not null check (failures > 0),
  window_started_at timestamptz not null
);

alter table auth_throttle enable row level security;
alter table auth_throttle force row level security;

revoke all on auth_throttle from public;
grant select, insert, update, delete on auth_throttle to app_user;

create policy auth_throttle_key on auth_throttle
  for all to app_user
  using (attempt_key = current_setting('app.throttle_key', true))
  with check (attempt_key = current_setting('app.throttle_key', true));
