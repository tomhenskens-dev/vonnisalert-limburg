do $$
declare p record; k uuid; d uuid; n int;
begin
  for p in select * from (values
    ('Beringse veroordeelde masseur%', 'Eerder veroordeelde masseur (52)%'),
    ('Hasselaar foltert twee vriendinnen%', 'Man (33) uit Hasselt folterde%'),
    ('Peltenaar met vals Snapchat%', 'Grootvader (58) doet zich op Snapchat%'),
    ('Kempense vechtersbazen%', 'Met vier tegen één na uitstap%'),
    ('Tragisch ongeval of toch moord? Gino%', '“Ik was mijn gordel aan het vastmaken%'),
    ('Asielzoeker bidt tijdens proces%', 'Van een omhelzing naar vier messteken%')
  ) v(keep_t, drop_t) loop
    select count(*) into n from public.cases where title ilike p.keep_t and not archived;
    if n <> 1 then raise notice 'overgeslagen (keep %): %', n, p.keep_t; continue; end if;
    select count(*) into n from public.cases where title ilike p.drop_t and not archived;
    if n <> 1 then raise notice 'overgeslagen (drop %): %', n, p.drop_t; continue; end if;
    select id into k from public.cases where title ilike p.keep_t and not archived;
    select id into d from public.cases where title ilike p.drop_t and not archived;
    update public.cases kc set extra_links = coalesce(kc.extra_links,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('url', dc.article_url, 'title', dc.title, 'published_at', dc.published_at))
      from public.cases dc where kc.id = k and dc.id = d;
    update public.articles set case_id = k where case_id = d;
    delete from public.case_events where case_id = d;
    delete from public.cases where id = d;
    insert into public.case_events (case_id, kind, message) select k, 'handmatig', 'Samengevoegd met een artikel over dezelfde zaak: ' || p.drop_t;
  end loop;
end $$;
select count(*) as zonder_datum from public.cases where verdict_date is null and not archived;
