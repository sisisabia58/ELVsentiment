-- The migration runner wraps this file in a transaction. The table owner
-- needs owner bypass for the data migration; the ALTER holds its lock until commit.
alter table provider_settings no force row level security;

update provider_settings
set provider = case when provider = 'off' or platform = 'web' then 'off' else 'scrapeatlas' end,
    fallback_provider = null, fallback_on_failure = false, updated_at = now()
where provider in ('scrapecreators', 'official_x')
   or (platform = 'web' and provider <> 'off')
   or fallback_provider is not null or fallback_on_failure;

alter table provider_settings
  drop constraint provider_settings_provider_check,
  drop constraint provider_settings_fallback_check,
  add constraint provider_settings_provider_check
    check (provider = 'off' or (provider = 'scrapeatlas' and platform <> 'web')),
  add constraint provider_settings_fallback_check
    check (fallback_provider is null and not fallback_on_failure);

alter table provider_settings force row level security;
