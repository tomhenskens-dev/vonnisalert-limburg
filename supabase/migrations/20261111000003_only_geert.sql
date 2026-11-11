-- Filter: alleen artikels waarvan Geert Houben (mee-)auteur is
insert into public.app_state (key, value) values ('only_geert', 'true'::jsonb) on conflict (key) do nothing;
drop policy if exists state_update on public.app_state;
create policy state_update on public.app_state for update to authenticated
  using (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled','only_geert'))
  with check (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled','only_geert'));
