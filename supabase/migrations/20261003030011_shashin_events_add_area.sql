-- shindan_done イベントで、画面の「どこが気になりますか？」の回答(area)も任意で記録できるようにする。
-- 個人情報ではなく、決まった選択肢のみ（shashin-logが未知の値は弾く）。
alter table public.shashin_events add column if not exists area text;

do $$
begin
  alter table public.shashin_events
    add constraint shashin_events_area_check
    check (area is null or area in ('外壁・屋根','ベランダ・屋上（防水）','両方','わからない','未回答'));
exception
  when duplicate_object then null;
end $$;
