alter table mentions drop constraint if exists mentions_source_check;
alter table mentions add constraint mentions_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table source_status drop constraint if exists source_status_source_check;
alter table source_status add constraint source_status_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table source_cursors drop constraint if exists source_cursors_source_check;
alter table source_cursors add constraint source_cursors_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table project_settings drop constraint if exists project_settings_enabled_sources_check;
alter table project_settings add constraint project_settings_enabled_sources_check
  check (
    enabled_sources <@ array['x', 'threads', 'instagram', 'tiktok']::text[]
  );

alter table project_settings alter column enabled_sources
  set default array['x', 'threads', 'instagram', 'tiktok'];
