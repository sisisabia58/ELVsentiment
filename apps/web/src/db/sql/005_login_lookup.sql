-- Sign-in does not know customer_id yet. The server sets app.login_email
-- inside the transaction from the submitted email. This is the same idea as
-- sessions_token_lookup: the GUC is not a client-supplied customer id.
create policy users_email_lookup on users
  for select to app_user
  using (email = nullif(current_setting('app.login_email', true), ''));
