-- Project and mention metadata inherit their existing tenant RLS policies.
alter table projects add column pantau_filter_triage boolean not null default false;
alter table mentions
  add column pantau_origin_search_id uuid,
  add column pantau_title text,
  add column pantau_hashtags text[] not null default '{}';

-- The server issues one project ID for each Cari onboarding attempt. Retries
-- use it as the project primary key. A search can expire while setup is open.
create table cari_onboarding_attempts (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  search_id uuid not null,
  expires_at timestamptz not null default now() + interval '7 days'
);

alter table cari_onboarding_attempts enable row level security;
alter table cari_onboarding_attempts force row level security;
grant select, insert on cari_onboarding_attempts to app_user;
create policy cari_onboarding_attempts_read on cari_onboarding_attempts
  for select to app_user using (customer_id = current_setting('app.customer_id', true)::uuid);
create policy cari_onboarding_attempts_insert on cari_onboarding_attempts
  for insert to app_user with check (
    customer_id = current_setting('app.customer_id', true)::uuid
    and exists (
      select 1 from instant_searches s
      where s.id = cari_onboarding_attempts.search_id and s.customer_id = cari_onboarding_attempts.customer_id
        and s.status in ('succeeded', 'partial') and s.finished_at is not null
        and s.retention_expires_at > now()
    )
  );

-- Preserve the origin identifier after Cari's retention period. Validate
-- tenant ownership when writing it, without retaining the Cari snapshot.
create policy mentions_cari_origin_insert on mentions as restrictive
  for insert to app_user with check (
    pantau_origin_search_id is null or (
      exists (
        select 1 from projects p
        where p.id = mentions.project_id and p.customer_id = mentions.customer_id
          and p.pantau_filter_triage
      )
      and exists (
        select 1 from instant_searches s
        where s.id = mentions.pantau_origin_search_id and s.customer_id = mentions.customer_id
          and s.status in ('succeeded', 'partial') and s.finished_at is not null
          and s.retention_expires_at > now()
      )
    )
  );

-- Replace the legacy table-level write grants so future columns do not
-- become writable implicitly. Collection may insert evidence, and scoring
-- may update its lease and status. The worker cannot write Cari provenance.
revoke insert, update on mentions from worker_role;
grant insert (
  id, customer_id, project_id, source, external_id, excerpt, url, author,
  posted_at, collected_at, matched_variants, scoring_status, source_post_unavailable,
  pantau_title, pantau_hashtags
) on mentions to worker_role;
grant update (matched_variants, scoring_status, scoring_claimed_at, scoring_attempts)
  on mentions to worker_role;
