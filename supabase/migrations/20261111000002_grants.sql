-- Nieuwe Supabase-projecten geven niet meer automatisch rechten op nieuwe tabellen.
-- De geplande taak (service_role) krijgt volledige toegang; de gebruiker (authenticated)
-- alleen wat de RLS-regels toelaten. Anonieme bezoekers krijgen niets.
grant usage on schema public to service_role, authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public._migrations from authenticated, anon;
