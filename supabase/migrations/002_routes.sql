-- Routen (geplante Reihenfolge von Schreinen), für beide Nutzer sichtbar und bearbeitbar.
-- Im Supabase-Dashboard unter "SQL Editor" einfügen und ausführen.
create table if not exists public.routes (
  id         text primary key,          -- "r" + uuid
  name       text not null,
  stops      text[] not null default '{}',  -- Schrein-IDs in Reihenfolge
  created_by uuid not null references auth.users(id) on delete cascade default auth.uid(),
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

drop trigger if exists touch on public.routes;
create trigger touch before insert or update on public.routes
  for each row execute function public.touch_updated_at();

alter table public.routes enable row level security;
drop policy if exists "read" on public.routes;
drop policy if exists "insert own" on public.routes;
drop policy if exists "update" on public.routes;
create policy "read" on public.routes for select to authenticated using (true);
create policy "insert own" on public.routes for insert to authenticated with check (created_by = auth.uid());
create policy "update" on public.routes for update to authenticated using (true);
