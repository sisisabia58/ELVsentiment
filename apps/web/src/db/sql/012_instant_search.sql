-- PROPOSED DEFAULT — FOR USER REVIEW.
-- Cari sekarang storage. Separate from mentions so JEV scoring is untouched.
-- All instant-search tables ship with M0; later milestones only add code.

create table provider_settings (
  platform text primary key,
  provider text not null,
  fallback_provider text,
  fallback_on_failure boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint provider_settings_platform_check check (platform in
    ('threads','tiktok','instagram','youtube','reddit','facebook','linkedin','x','web','comments')),
  constraint provider_settings_provider_check check (provider in
    ('scrapecreators','scrapeatlas','official_x','off')),
  constraint provider_settings_fallback_check check (fallback_provider is null or fallback_provider in
    ('scrapecreators','scrapeatlas','official_x')),
  constraint provider_settings_fallback_requires_provider check
    (fallback_on_failure = false or fallback_provider is not null)
);

create table provider_settings_audit (
  id uuid primary key,
  platform text not null,
  old_provider text,
  new_provider text not null,
  old_fallback_provider text,
  new_fallback_provider text,
  old_fallback_on_failure boolean,
  new_fallback_on_failure boolean,
  actor_email text not null,
  created_at timestamptz not null default now()
);

create table instant_searches (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  query_text text not null,
  keyword_intent text not null check (keyword_intent in ('phrase','hashtag')),
  date_window text not null check (date_window in ('all','24h','7d','30d','12m')),
  sort_mode text not null check (sort_mode in ('relevance','newest','popular')),
  language_filter text not null check (language_filter in ('all','id','en')),
  status text not null check (status in ('queued','running','partial','succeeded','failed')),
  summary_status text not null default 'pending'
    check (summary_status in ('pending','running','done','failed','skipped')),
  overall_stance text check (overall_stance in ('positif','campuran','negatif','netral','faktual')),
  user_credits integer not null default 1 check (user_credits >= 0),
  credits_used integer not null default 0 check (credits_used >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  deadline_at timestamptz not null,
  retention_expires_at timestamptz not null default now() + interval '30 days'
);

create table instant_search_sources (
  search_id uuid not null references instant_searches (id) on delete cascade,
  customer_id uuid not null references customers (id),
  platform text not null,
  provider text not null,
  state text not null check (state in ('queued','searching','answered','unavailable','failed')),
  result_count integer not null default 0 check (result_count >= 0),
  latency_ms integer,
  credits_charged integer,
  attempted_providers text[] not null default '{}',
  safe_detail text not null default 'queued',
  updated_at timestamptz not null default now(),
  primary key (search_id, platform)
);

create table instant_search_results (
  id uuid primary key,
  search_id uuid not null references instant_searches (id) on delete cascade,
  customer_id uuid not null references customers (id),
  platform text not null,
  external_id text not null,
  author_name text,
  author_handle text,
  url text,
  text text not null default '',
  title text,
  published_at timestamptz,
  thumbnail_url text,
  views bigint,
  likes bigint,
  replies bigint,
  shares bigint,
  language text not null default 'other' check (language in ('id','en','other')),
  relevance text not null check (relevance in ('literal_match','all_words_match','no_match')),
  web_index boolean not null default false,
  source_provider text not null,
  routes text[] not null default '{}',
  raw_ref text not null,
  rank integer,
  collected_at timestamptz not null default now(),
  unique (search_id, platform, external_id)
);

create table instant_search_comments (
  id uuid primary key,
  search_id uuid not null references instant_searches (id) on delete cascade,
  customer_id uuid not null references customers (id),
  result_id uuid not null references instant_search_results (id) on delete cascade,
  platform text not null,
  external_id text not null,
  author_name text,
  author_handle text,
  text text not null,
  published_at timestamptz,
  likes bigint,
  replies bigint,
  source_provider text not null,
  raw_ref text not null,
  collected_at timestamptz not null default now(),
  unique (search_id, result_id, external_id)
);

create table instant_search_ai (
  search_id uuid primary key references instant_searches (id) on delete cascade,
  customer_id uuid not null references customers (id),
  overall_summary text not null,
  overall_stance text not null
    check (overall_stance in ('positif','campuran','negatif','netral','faktual')),
  platform_summaries jsonb not null default '[]'::jsonb,
  quotes jsonb not null default '[]'::jsonb,
  themes jsonb not null default '[]'::jsonb,
  model text not null,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);

create table instant_search_questions (
  id uuid primary key,
  search_id uuid not null references instant_searches (id) on delete cascade,
  customer_id uuid not null references customers (id),
  question text not null,
  status text not null check (status in ('queued','running','done','failed')),
  answer text,
  citations jsonb not null default '[]'::jsonb,
  safe_detail text,
  model text,
  user_credits integer not null default 1 check (user_credits >= 0),
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create table search_credit_ledger (
  id uuid primary key,
  search_id uuid references instant_searches (id) on delete set null,
  customer_id uuid not null references customers (id),
  provider text not null,
  platform text not null,
  route text not null,
  credits_charged integer default 0 check (credits_charged >= 0),
  http_status integer,
  safe_detail text not null default 'ok',
  body_length integer,
  latency_ms integer not null,
  created_at timestamptz not null default now()
);

create table gemini_gate (
  id integer primary key check (id = 1),
  paused_until timestamptz,
  pause_kind text,
  quota_metric text,
  quota_id text,
  quota_limit text,
  last_request_at timestamptz
);

-- Provider routing: readable by both roles; writes require the per-transaction
-- admin flag set by the server after it has checked the admin allowlist.
grant select on provider_settings to app_user;
grant select on provider_settings to worker_role;
grant insert, update on provider_settings to app_user;
alter table provider_settings enable row level security;
alter table provider_settings force row level security;
create policy provider_settings_read on provider_settings
  for select to app_user using (true);
create policy provider_settings_admin_insert on provider_settings
  for insert to app_user with check (current_setting('app.is_admin', true) = 'on');
create policy provider_settings_admin_update on provider_settings
  for update to app_user
  using (current_setting('app.is_admin', true) = 'on')
  with check (current_setting('app.is_admin', true) = 'on');
create policy provider_settings_worker_read on provider_settings
  for select to worker_role using (true);

grant select, insert on provider_settings_audit to app_user;
grant select on provider_settings_audit to worker_role;
alter table provider_settings_audit enable row level security;
alter table provider_settings_audit force row level security;
create policy provider_settings_audit_admin_read on provider_settings_audit
  for select to app_user using (current_setting('app.is_admin', true) = 'on');
create policy provider_settings_audit_admin_insert on provider_settings_audit
  for insert to app_user with check (current_setting('app.is_admin', true) = 'on');
create policy provider_settings_audit_worker_read on provider_settings_audit
  for select to worker_role using (true);

grant select, insert on instant_searches to app_user;
grant select, insert, update, delete on instant_searches to worker_role;
alter table instant_searches enable row level security;
alter table instant_searches force row level security;
create policy instant_searches_tenant on instant_searches
  for select to app_user using (customer_id = current_setting('app.customer_id', true)::uuid);
create policy instant_searches_insert on instant_searches
  for insert to app_user with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy instant_searches_worker on instant_searches
  for all to worker_role using (true) with check (true);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'instant_search_sources', 'instant_search_results', 'instant_search_comments',
    'instant_search_ai', 'instant_search_questions', 'search_credit_ledger'
  ]
  loop
    execute format('grant select on %I to app_user', table_name);
    execute format('grant select, insert, update, delete on %I to worker_role', table_name);
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I for select to app_user using (customer_id = current_setting(''app.customer_id'', true)::uuid)',
      table_name || '_tenant', table_name
    );
    execute format(
      'create policy %I on %I for all to worker_role using (true) with check (true)',
      table_name || '_worker', table_name
    );
  end loop;
end $$;

grant insert on instant_search_questions to app_user;
create policy instant_search_questions_insert on instant_search_questions
  for insert to app_user with check (customer_id = current_setting('app.customer_id', true)::uuid);

grant insert on instant_search_sources to app_user;
create policy instant_search_sources_insert on instant_search_sources
  for insert to app_user with check (customer_id = current_setting('app.customer_id', true)::uuid);

grant select, insert, update on gemini_gate to worker_role;
alter table gemini_gate enable row level security;
alter table gemini_gate force row level security;
create policy gemini_gate_worker on gemini_gate
  for all to worker_role using (true) with check (true);

create index instant_searches_customer_created_idx
  on instant_searches (customer_id, created_at desc);
create index instant_searches_status_created_idx
  on instant_searches (status, created_at);
create index instant_search_results_search_rank_idx
  on instant_search_results (search_id, rank);
create index instant_search_comments_result_likes_idx
  on instant_search_comments (result_id, likes desc);
create index search_credit_ledger_search_idx
  on search_credit_ledger (search_id);

insert into provider_settings (platform, provider, fallback_provider, fallback_on_failure)
values
  ('threads', 'scrapecreators', 'scrapeatlas', false),
  ('tiktok', 'scrapecreators', 'scrapeatlas', false),
  ('instagram', 'scrapecreators', null, false),
  ('youtube', 'scrapeatlas', null, false),
  ('reddit', 'scrapeatlas', null, false),
  ('facebook', 'scrapeatlas', null, false),
  ('linkedin', 'scrapeatlas', null, false),
  ('x', 'official_x', null, false),
  ('web', 'off', null, false),
  ('comments', 'scrapeatlas', null, false)
on conflict (platform) do nothing;
