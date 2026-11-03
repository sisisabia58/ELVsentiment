create role app_user nologin nosuperuser nobypassrls;
create role worker_role nologin nosuperuser nobypassrls;
grant usage on schema public to app_user;
grant usage on schema public to worker_role;

create table customers (
  id uuid primary key,
  customer_id uuid not null unique,
  created_at timestamptz not null,
  check (id = customer_id)
);
create table users (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null
);
create table sessions (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  user_id uuid not null references users (id),
  token_hash text not null unique,
  expires_at timestamptz not null
);
create table projects (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  brand_name text not null,
  created_at timestamptz not null
);
create table project_settings (
  project_id uuid primary key references projects (id),
  customer_id uuid not null references customers (id),
  trend_bucket text,
  trend_time_zone text,
  date_from date,
  date_to date,
  source_filter text not null default 'all'
);
create table keyword_variants (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  text text not null,
  active boolean not null,
  created_at timestamptz not null,
  unique (project_id, text)
);
create table mentions (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  source text not null check (source in ('x', 'threads')),
  external_id text not null,
  excerpt text not null,
  url text,
  author text,
  posted_at timestamptz not null,
  collected_at timestamptz not null,
  matched_variants text[] not null,
  scoring_status text not null check (scoring_status in ('pending', 'scoring', 'succeeded', 'failed')),
  source_post_unavailable boolean not null default false,
  unique (customer_id, source, external_id)
);
create table jev_results (
  mention_id uuid primary key references mentions (id),
  customer_id uuid not null references customers (id),
  provider text not null check (provider in ('typesafe', 'openrouter')),
  model text not null,
  raw_response jsonb not null,
  relevance_noul double precision,
  sentiment text,
  sentiment_confidence double precision,
  topic_nouls jsonb not null,
  created_at timestamptz not null
);
create table owner_corrections (
  mention_id uuid primary key references mentions (id),
  customer_id uuid not null references customers (id),
  action text not null check (action in ('confirm', 'correct')),
  relevance text not null check (relevance in ('relevant', 'irrelevant')),
  sentiment text,
  topics text[] not null,
  created_at timestamptz not null
);
create table attention_items (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  mention_id uuid not null unique references mentions (id),
  reason text not null check (reason = 'negative'),
  unread boolean not null,
  seen_at timestamptz,
  created_at timestamptz not null
);
create table source_status (
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  source text not null check (source in ('x', 'threads')),
  state text not null check (state in ('ready', 'unavailable', 'authorization_failed', 'rate_limited')),
  detail text not null,
  last_success_at timestamptz,
  updated_at timestamptz not null,
  primary key (customer_id, project_id, source)
);
create table collection_runs (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  source text not null,
  outcome text not null check (outcome in ('success', 'failed', 'empty_unconfirmed')),
  fetched_count integer,
  truncated boolean not null,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null
);
create table x_usage (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  account_key text not null,
  posts_returned integer not null,
  estimated_usd numeric not null,
  recorded_at timestamptz not null
);
create table analytics_events (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  name text not null,
  properties jsonb not null,
  created_at timestamptz not null
);

grant select, insert, update, delete on all tables in schema public to app_user;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'customers', 'users', 'sessions', 'projects', 'project_settings', 'keyword_variants',
    'mentions', 'jev_results', 'owner_corrections', 'attention_items', 'source_status',
    'collection_runs', 'x_usage', 'analytics_events'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I using (customer_id = current_setting(''app.customer_id'', true)::uuid) with check (customer_id = current_setting(''app.customer_id'', true)::uuid)',
      table_name || '_tenant',
      table_name
    );
  end loop;
end $$;
