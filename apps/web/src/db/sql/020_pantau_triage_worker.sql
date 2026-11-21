create table pantau_triage_jobs (
  mention_id uuid primary key,
  customer_id uuid not null,
  project_id uuid not null,
  source text not null check (source in ('threads', 'instagram', 'tiktok')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retrying', 'deferred', 'failed', 'completed')),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  failure_code text check (failure_code in (
    'project_budget', 'lease_expired', 'provider_unavailable', 'provider_quota', 'invalid_response'
  )),
  unique (mention_id, customer_id, project_id),
  foreign key (mention_id, customer_id, project_id, source)
    references mentions (id, customer_id, project_id, source) on delete cascade,
  check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_token is null and lease_expires_at is null)
  )
);

create index pantau_triage_due_idx on pantau_triage_jobs (available_at, mention_id)
  where status in ('pending', 'retrying', 'deferred');
create index pantau_triage_leases_idx on pantau_triage_jobs (lease_expires_at, mention_id)
  where status = 'processing';

create table pantau_triage_attempts (
  lease_token uuid primary key,
  mention_id uuid not null,
  customer_id uuid not null,
  project_id uuid not null,
  admitted_at timestamptz not null default clock_timestamp(),
  foreign key (mention_id, customer_id, project_id)
    references pantau_triage_jobs (mention_id, customer_id, project_id) on delete cascade
);

create index pantau_triage_budget_idx on pantau_triage_attempts (project_id, admitted_at);

create table pantau_triage_judgments (
  mention_id uuid primary key,
  customer_id uuid not null,
  project_id uuid not null,
  destination text not null check (destination in ('attention', 'ambiguous', 'mention', 'excluded')),
  origin text not null check (origin in ('deterministic', 'opencode')),
  relevance_tier text not null
    check (relevance_tier in ('literal_match', 'all_words_match', 'no_match', 'insufficient_text')),
  sentiment text not null check (sentiment in ('positive', 'negative', 'neutral', 'mixed', 'unclear')),
  actionability text not null check (actionability in ('actionable', 'not_actionable', 'unclear')),
  reason text not null check (reason in (
    'firsthand_complaint', 'relevance_unclear', 'complaint_unclear',
    'non_actionable', 'no_match', 'insufficient_text'
  )),
  issue_category text check (issue_category in (
    'payment', 'stock', 'product_quality', 'order_fulfillment', 'service', 'pricing', 'other'
  )),
  verified_excerpt text check (char_length(verified_excerpt) between 1 and 280),
  model_version text check (char_length(model_version) between 1 and 80),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (mention_id, customer_id, project_id)
    references pantau_triage_jobs (mention_id, customer_id, project_id) on delete cascade,
  check ((origin = 'opencode') = (model_version is not null)),
  check (
    destination <> 'attention' or (
      origin = 'opencode' and relevance_tier = 'literal_match'
      and sentiment in ('negative', 'mixed') and actionability = 'actionable'
      and reason = 'firsthand_complaint' and verified_excerpt is not null
    )
  )
);

alter table pantau_triage_jobs enable row level security;
alter table pantau_triage_jobs force row level security;
alter table pantau_triage_attempts enable row level security;
alter table pantau_triage_attempts force row level security;
alter table pantau_triage_judgments enable row level security;
alter table pantau_triage_judgments force row level security;

grant select on pantau_triage_jobs, pantau_triage_judgments to app_user;
grant select on pantau_triage_jobs, pantau_triage_attempts, pantau_triage_judgments to worker_role;
grant insert (mention_id, customer_id, project_id, source) on pantau_triage_jobs to worker_role;
grant update (status, available_at, lease_token, lease_expires_at, attempt_count, failure_code)
  on pantau_triage_jobs to worker_role;
grant insert (lease_token, mention_id, customer_id, project_id) on pantau_triage_attempts to worker_role;
grant insert (mention_id, customer_id, project_id, destination, origin, relevance_tier,
  sentiment, actionability, reason, issue_category, verified_excerpt, model_version)
  on pantau_triage_judgments to worker_role;

create policy pantau_triage_jobs_tenant_read on pantau_triage_jobs
  for select to app_user using (customer_id = current_setting('app.customer_id', true)::uuid);
create policy pantau_triage_judgments_tenant_read on pantau_triage_judgments
  for select to app_user using (customer_id = current_setting('app.customer_id', true)::uuid);

create policy pantau_triage_jobs_worker_read on pantau_triage_jobs for select to worker_role using (true);
create policy pantau_triage_jobs_worker_insert on pantau_triage_jobs
  for insert to worker_role with check (exists (
    select 1 from projects p
    where p.id = pantau_triage_jobs.project_id and p.customer_id = pantau_triage_jobs.customer_id
      and p.pantau_filter_triage
  ));
create policy pantau_triage_jobs_worker_update on pantau_triage_jobs
  for update to worker_role using (true) with check (true);
create policy pantau_triage_attempts_worker_read on pantau_triage_attempts
  for select to worker_role using (true);
create policy pantau_triage_attempts_worker_insert on pantau_triage_attempts
  for insert to worker_role with check (exists (
    select 1 from pantau_triage_jobs j where j.mention_id = pantau_triage_attempts.mention_id
      and j.lease_token = pantau_triage_attempts.lease_token and j.status = 'processing'
  ));
create policy pantau_triage_judgments_worker_read on pantau_triage_judgments
  for select to worker_role using (true);
create policy pantau_triage_judgments_worker_insert on pantau_triage_judgments
  for insert to worker_role with check (exists (
    select 1 from pantau_triage_jobs j
    where j.mention_id = pantau_triage_judgments.mention_id and j.status = 'completed'
  ));
