-- app_user cannot read sessions through the tenant policy until it already
-- knows the customer id. The lookup compares the hashed session cookie,
-- which only the server sets, and does not accept a client-supplied customer id.
create policy sessions_token_lookup on sessions
  for select to app_user
  using (
    token_hash = current_setting('app.session_token_hash', true)
    and expires_at > now()
  );
