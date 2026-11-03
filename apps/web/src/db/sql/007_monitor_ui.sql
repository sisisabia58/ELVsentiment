-- Owner display name, shared mention read state, which sources a project
-- collects, and whether a schedule is an interval or a daily WIB clock.
-- Existing rows keep working: names stay null, mentions stay unread, both
-- sources stay selected, and schedules stay interval-based.

alter table users add column display_name text;

alter table mentions add column read_at timestamptz;

alter table project_settings add column enabled_sources text[] not null default array['x', 'threads'];
alter table project_settings add constraint project_settings_enabled_sources_check
  check (enabled_sources <@ array['x', 'threads']::text[]);

alter table project_schedules add column cadence text not null default 'interval';
alter table project_schedules add constraint project_schedules_cadence_check
  check (cadence in ('interval', 'daily'));
alter table project_schedules add column daily_minute smallint;
alter table project_schedules add constraint project_schedules_daily_minute_check
  check (daily_minute is null or (daily_minute >= 0 and daily_minute < 1440));

-- The worker reads which sources a project actually collects. Table grants
-- from 001 cover app_user; worker_role did not have this table.
grant select on project_settings to worker_role;
create policy project_settings_worker on project_settings
  for select to worker_role using (true);
