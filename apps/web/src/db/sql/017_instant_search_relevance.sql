-- Version 0 searches may contain ungated provider results and AI generated
-- from them. Version 1 means the collecting worker applied the relevance gate.
-- Existing workers leave the default in place, including after a rollback.
alter table instant_searches
  add column relevance_version smallint not null default 0;
