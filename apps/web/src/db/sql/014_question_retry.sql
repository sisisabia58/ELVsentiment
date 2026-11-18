-- A failed question can be requeued by the same customer without inserting a
-- second row or charging another user credit.
grant update on instant_search_questions to app_user;
create policy instant_search_questions_update on instant_search_questions
  for update to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
