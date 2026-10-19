-- Schema für die Jinja-Schreinkarte.
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und ausführen.

-- Anzeigenamen der Nutzer
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default ''
);

-- Besuchsstatus pro Schrein und Person
create table if not exists public.visits (
  shrine_id   text not null,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  visited     boolean not null default false,
  visited_at  date,
  goshuin     boolean not null default false,
  goshuin_at  date,
  note        text not null default '',
  -- Kopie von Name/Lage, falls sich die Schrein-ID bei einem Daten-Update ändert
  shrine_name text not null default '',
  lat         double precision,
  lon         double precision,
  updated_at  timestamptz not null default now(),
  primary key (shrine_id, user_id)
);

-- Fotos (Dateien liegen im Storage-Bucket "photos")
create table if not exists public.photos (
  id         uuid primary key,
  shrine_id  text not null,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  path       text not null,
  thumb_path text not null,
  bytes      integer not null default 0,
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists photos_shrine on public.photos (shrine_id);

-- Selbst hinzugefügte Schreine
create table if not exists public.custom_shrines (
  id         text primary key,          -- "c" + uuid
  name       text not null,
  lat        double precision not null,
  lon        double precision not null,
  pref       integer,                   -- 0–46 (Index in PREFS)
  created_by uuid not null references auth.users(id) on delete cascade default auth.uid(),
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Gemeinsames Wissen pro Schrein: gibt es hier Goshuin? Name (bei namenlosen Kartensymbolen)
create table if not exists public.goshuin_info (
  shrine_id  text primary key,
  available  boolean,                   -- null = unbekannt
  note       text not null default '',
  name       text not null default '',  -- selbst ergänzter Name
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now()
);

-- updated_at automatisch setzen (für inkrementellen Sync)
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$ declare t text; begin
  foreach t in array array['visits','photos','custom_shrines','goshuin_info'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before insert or update on public.%I
                    for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- Profil beim Anlegen eines Nutzers automatisch erzeugen
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1)) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Row Level Security ----------
-- Neue Registrierungen sind im Dashboard deaktiviert, daher gibt es nur die
-- eingeladenen Accounts. Alle angemeldeten Nutzer sehen alles, ändern aber nur
-- ihre eigenen Einträge (goshuin_info dürfen beide bearbeiten).
alter table public.profiles       enable row level security;
alter table public.visits         enable row level security;
alter table public.photos         enable row level security;
alter table public.custom_shrines enable row level security;
alter table public.goshuin_info   enable row level security;

drop policy if exists "read" on public.profiles;
drop policy if exists "own"  on public.profiles;
create policy "read" on public.profiles for select to authenticated using (true);
create policy "own"  on public.profiles for update to authenticated using (id = auth.uid());

do $$ declare t text; begin
  foreach t in array array['visits','photos'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "insert own" on public.%I', t);
    execute format('drop policy if exists "update own" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "insert own" on public.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('create policy "update own" on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

drop policy if exists "read" on public.custom_shrines;
drop policy if exists "insert own" on public.custom_shrines;
drop policy if exists "update own" on public.custom_shrines;
create policy "read" on public.custom_shrines for select to authenticated using (true);
create policy "insert own" on public.custom_shrines for insert to authenticated with check (created_by = auth.uid());
create policy "update own" on public.custom_shrines for update to authenticated using (created_by = auth.uid());

drop policy if exists "read" on public.goshuin_info;
drop policy if exists "write" on public.goshuin_info;
drop policy if exists "update" on public.goshuin_info;
create policy "read"   on public.goshuin_info for select to authenticated using (true);
create policy "write"  on public.goshuin_info for insert to authenticated with check (true);
create policy "update" on public.goshuin_info for update to authenticated using (true);

-- ---------- Storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "photos read" on storage.objects;
drop policy if exists "photos insert own" on storage.objects;
drop policy if exists "photos delete own" on storage.objects;
drop policy if exists "photos update own" on storage.objects;
create policy "photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos');
-- Pfad: <user_id>/<shrine_id>/<photo_id>.jpg
create policy "photos insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
-- nötig für upsert (erneuter Upload nach abgebrochenem Sync)
create policy "photos update own" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Für den Keepalive-Ping (GitHub Action) ohne Login
create or replace function public.ping() returns text language sql security definer as $$ select 'pong' $$;
grant execute on function public.ping() to anon;

-- Speicherverbrauch (für Anzeige in der App)
create or replace function public.storage_usage() returns bigint language sql security definer
set search_path = public as $$
  select coalesce(sum(bytes), 0)::bigint from public.photos where not deleted
$$;
grant execute on function public.storage_usage() to authenticated;
