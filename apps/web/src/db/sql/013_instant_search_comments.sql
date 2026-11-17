-- Comment phase for an instant search. The search status stays independent:
-- a skipped or failed comment pass never fails the search.
alter table instant_searches
  add column comment_status text not null default 'pending'
    check (comment_status in ('pending', 'running', 'done', 'skipped'));

alter table instant_searches
  add column comment_detail text;
