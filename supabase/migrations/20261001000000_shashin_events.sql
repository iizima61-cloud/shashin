-- 写真診断アプリの利用回数（個人情報・写真・IP・端末情報は保存しない）
create table if not exists public.shashin_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event text not null check (event in ('page_view','photo_selected','shindan_done','line_click','mitsumori_click')),
  source text not null check (source ~ '^[A-Za-z0-9_-]{1,40}$'),
  session_id text not null check (char_length(session_id) between 8 and 64)
);

-- 同じ session_id × 同じ event は1回だけ
create unique index if not exists shashin_events_session_event_uq
  on public.shashin_events (session_id, event);
create index if not exists shashin_events_created_idx
  on public.shashin_events (created_at);

-- 匿名ユーザーは直接読み書きできない（ポリシーを作らない＝全拒否。Edge Functionだけがservice_roleで操作）
alter table public.shashin_events enable row level security;
revoke all on public.shashin_events from anon, authenticated;

-- 集計用（件数のみ）。service_roleだけ実行可。source='test' は集計から除外
create or replace function public.shashin_event_counts(since timestamptz)
returns table(source text, event text, n bigint)
language sql
security definer
set search_path = public
as $$
  select e.source, e.event, count(*)::bigint
  from public.shashin_events e
  where e.source <> 'test' and (since is null or e.created_at >= since)
  group by e.source, e.event
$$;
revoke all on function public.shashin_event_counts(timestamptz) from public, anon, authenticated;
grant execute on function public.shashin_event_counts(timestamptz) to service_role;
