-- A null sample marks cached output from a worker without evidence tracking.
alter table instant_search_ai
  add column evidence_ids jsonb,
  add column overall_supporting_ids jsonb;

alter table instant_search_questions
  add column evidence_ids jsonb;

alter table instant_searches
  drop constraint instant_searches_summary_status_check,
  add constraint instant_searches_summary_status_check
    check (summary_status in ('pending','running','done','failed','skipped','insufficient'));
