-- PROPOSED DEFAULT — FOR USER REVIEW.
-- Add explicit keyword intent, project-scoped mention identity, and
-- per-keyword text-match associations. Existing rows keep working.

alter table keyword_variants
  add column intent text not null default 'phrase';

alter table keyword_variants
  add constraint keyword_variants_intent_check
  check (intent in ('phrase', 'hashtag'));

alter table mentions drop constraint if exists mentions_customer_id_source_external_id_key;

alter table mentions
  add constraint mentions_customer_id_project_id_source_external_id_key
  unique (customer_id, project_id, source, external_id);

create table mention_keyword_associations (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  mention_id uuid not null references mentions (id) on delete cascade,
  keyword_text text not null,
  intent text not null,
  route_id text not null,
  source text not null,
  status text not null,
  collected_at timestamptz not null,
  constraint mention_keyword_associations_intent_check
    check (intent in ('phrase', 'hashtag')),
  constraint mention_keyword_associations_source_check
    check (source in ('x', 'threads', 'instagram', 'tiktok')),
  constraint mention_keyword_associations_status_check
    check (status in ('literal_match', 'no_literal_match', 'unknown_text')),
  unique (mention_id, keyword_text, route_id)
);

create index mention_keyword_associations_project_status_idx
  on mention_keyword_associations (customer_id, project_id, status);

alter table mention_keyword_associations enable row level security;
alter table mention_keyword_associations force row level security;

grant select on mention_keyword_associations to app_user;
grant select, insert, update on mention_keyword_associations to worker_role;

create policy mention_keyword_associations_tenant on mention_keyword_associations
  for select to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid);

create policy mention_keyword_associations_worker_select on mention_keyword_associations
  for select to worker_role
  using (customer_id = current_setting('app.customer_id', true)::uuid);

create policy mention_keyword_associations_worker_insert on mention_keyword_associations
  for insert to worker_role
  with check (customer_id = current_setting('app.customer_id', true)::uuid);

create policy mention_keyword_associations_worker_update on mention_keyword_associations
  for update to worker_role
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
