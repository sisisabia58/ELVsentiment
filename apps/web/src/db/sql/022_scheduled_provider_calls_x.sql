alter table scheduled_provider_calls drop constraint scheduled_provider_calls_platform_check;
alter table scheduled_provider_calls add constraint scheduled_provider_calls_platform_check
  check (platform in ('threads', 'tiktok', 'instagram', 'x'));
