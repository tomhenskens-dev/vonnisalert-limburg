-- Aanpasbare stijlgids voor de artikelhulp (lege tekst = standaardstijlgids uit de app)
insert into public.app_state (key, value) values ('style_guide', '""'::jsonb)
on conflict (key) do nothing;

drop policy if exists state_update on public.app_state;
create policy state_update on public.app_state for update to authenticated
  using (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled','only_geert','followed_authors','style_guide'))
  with check (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled','only_geert','followed_authors','style_guide')
    and (key <> 'style_guide' or (jsonb_typeof(value) = 'string' and length(value #>> '{}') <= 20000)));
