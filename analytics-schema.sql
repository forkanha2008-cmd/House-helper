-- ═══════════════════════════════════════════════════════════
-- House Helper — Analytics & Customer Profile Schema
-- Run this once in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- ── 1. ANALYTICS EVENTS ────────────────────────────────────
create table if not exists public.analytics_events (
  id              bigserial primary key,
  event_name      text not null,
  user_id         text,               -- customer phone or UUID
  session_id      text,
  properties      jsonb default '{}',
  platform        text default 'web', -- 'web' | 'android'
  session_duration_s integer default 0,
  created_at      timestamptz default now()
);

-- Index for fast lookups
create index if not exists idx_analytics_user    on public.analytics_events(user_id);
create index if not exists idx_analytics_event   on public.analytics_events(event_name);
create index if not exists idx_analytics_session on public.analytics_events(session_id);
create index if not exists idx_analytics_created on public.analytics_events(created_at desc);

-- RLS: anyone can insert events (anon key), only service role can read
alter table public.analytics_events enable row level security;

drop policy if exists "Anyone can insert analytics events" on public.analytics_events;
create policy "Anyone can insert analytics events"
  on public.analytics_events for insert to public with check (true);

drop policy if exists "Anyone can read analytics events" on public.analytics_events;
create policy "Anyone can read analytics events"
  on public.analytics_events for select to public using (true);

-- ── 2. CUSTOMER PROFILES ───────────────────────────────────
create table if not exists public.customer_profiles (
  id              bigserial primary key,
  user_id         text unique not null,  -- phone number used as ID
  name            text,
  email           text,
  phone           text,
  city            text,
  avatar_url      text,
  registered_at   timestamptz default now(),
  last_active     timestamptz default now(),
  total_bookings  int default 0,
  total_spent     numeric(10,2) default 0,
  recently_viewed text[] default '{}',   -- array of service IDs
  favourite_services text[] default '{}',
  notes           text,                  -- admin notes about customer
  tags            text[] default '{}',   -- e.g. ['vip', 'repeat']
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists idx_profiles_user on public.customer_profiles(user_id);
create index if not exists idx_profiles_last_active on public.customer_profiles(last_active desc);

alter table public.customer_profiles enable row level security;

drop policy if exists "Anyone can read profiles" on public.customer_profiles;
create policy "Anyone can read profiles"
  on public.customer_profiles for select to public using (true);

drop policy if exists "Anyone can upsert profiles" on public.customer_profiles;
create policy "Anyone can upsert profiles"
  on public.customer_profiles for insert to public with check (true);

drop policy if exists "Anyone can update profiles" on public.customer_profiles;
create policy "Anyone can update profiles"
  on public.customer_profiles for update to public using (true);

-- Auto-update updated_at
create or replace function update_updated_at_column()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists update_customer_profiles_updated_at on public.customer_profiles;
create trigger update_customer_profiles_updated_at
  before update on public.customer_profiles
  for each row execute function update_updated_at_column();

-- ── 3. ENABLE REALTIME FOR ANALYTICS ───────────────────────
-- (So admin dashboard updates live)
alter publication supabase_realtime add table public.analytics_events;
alter publication supabase_realtime add table public.customer_profiles;

-- ── 4. USEFUL VIEWS FOR ADMIN DASHBOARD ───────────────────

-- Daily event counts (for charts)
create or replace view public.analytics_daily as
  select
    date_trunc('day', created_at) as day,
    event_name,
    count(*) as event_count,
    count(distinct user_id) as unique_users
  from public.analytics_events
  group by 1, 2;

-- Top searches
create or replace view public.analytics_top_searches as
  select
    properties->>'query' as query,
    count(*) as search_count
  from public.analytics_events
  where event_name = 'search'
    and properties->>'query' is not null
    and created_at > now() - interval '30 days'
  group by 1
  order by 2 desc
  limit 20;

-- Top services viewed
create or replace view public.analytics_top_services as
  select
    properties->>'service_name' as service_name,
    properties->>'service_id'   as service_id,
    count(*) as view_count,
    count(distinct user_id) as unique_viewers
  from public.analytics_events
  where event_name = 'service_viewed'
    and created_at > now() - interval '30 days'
  group by 1, 2
  order by 3 desc
  limit 20;

-- Session stats per user
create or replace view public.analytics_user_sessions as
  select
    user_id,
    count(distinct session_id) as total_sessions,
    count(*) as total_events,
    min(created_at) as first_seen,
    max(created_at) as last_seen,
    bool_or(event_name = 'booking_completed') as has_converted
  from public.analytics_events
  where user_id is not null
  group by 1;

-- Grant access to views
grant select on public.analytics_daily to anon, authenticated;
grant select on public.analytics_top_searches to anon, authenticated;
grant select on public.analytics_top_services to anon, authenticated;
grant select on public.analytics_user_sessions to anon, authenticated;

-- ── DONE ────────────────────────────────────────────────────
do $$ begin
  raise notice 'Analytics schema created successfully.';
  raise notice 'Tables: analytics_events, customer_profiles';
  raise notice 'Views: analytics_daily, analytics_top_searches, analytics_top_services, analytics_user_sessions';
end $$;
