create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.device_access (
  device_id uuid primary key references auth.users (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  paired_at timestamptz not null default now(),
  constraint device_access_not_self check (device_id <> owner_id)
);

create table if not exists public.device_pairings (
  code text primary key check (code ~ '^[0-9a-f]{48}$'),
  owner_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

delete from public.device_pairings older
using public.device_pairings newer
where older.owner_id = newer.owner_id
  and older.ctid < newer.ctid;

create unique index if not exists device_pairings_owner_id_uidx
  on public.device_pairings (owner_id);

alter table public.user_data enable row level security;
alter table public.device_access enable row level security;
alter table public.device_pairings enable row level security;

revoke all on public.device_access, public.device_pairings from public, anon, authenticated;
revoke all on public.user_data from public, anon;
grant select, insert, update on public.user_data to authenticated;

create or replace function public.can_access_user_data(p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() = p_owner_id
    or exists (
      select 1
      from public.device_access
      where device_id = auth.uid()
        and owner_id = p_owner_id
    );
$$;

revoke all on function public.can_access_user_data(uuid) from public;
grant execute on function public.can_access_user_data(uuid) to authenticated;

drop policy if exists "Users can read their own data" on public.user_data;
drop policy if exists "Users can insert their own data" on public.user_data;
drop policy if exists "Users can update their own data" on public.user_data;
drop policy if exists "Paired devices can read shared data" on public.user_data;
drop policy if exists "Paired devices can insert shared data" on public.user_data;
drop policy if exists "Paired devices can update shared data" on public.user_data;

create policy "Paired devices can read shared data"
  on public.user_data for select
  to authenticated
  using (public.can_access_user_data(user_id));

create policy "Paired devices can insert shared data"
  on public.user_data for insert
  to authenticated
  with check (public.can_access_user_data(user_id));

create policy "Paired devices can update shared data"
  on public.user_data for update
  to authenticated
  using (public.can_access_user_data(user_id))
  with check (public.can_access_user_data(user_id));

drop function if exists public.create_device_pairing(text);

create function public.create_device_pairing(p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Perangkat belum terhubung.';
  end if;
  if p_code is null or p_code !~ '^[0-9a-f]{48}$' then
    raise exception 'Format kode perangkat tidak valid.';
  end if;

  select user_id into v_owner_id
  from public.user_data
  where user_id = auth.uid();

  if v_owner_id is null then
    select access.owner_id into v_owner_id
    from public.device_access as access
    join public.user_data as data on data.user_id = access.owner_id
    where access.device_id = auth.uid();
  end if;

  if v_owner_id is null then
    raise exception 'Data perangkat belum tersimpan di Supabase. Tunggu sampai penyimpanan selesai, lalu coba lagi.';
  end if;

  insert into public.device_pairings (code, owner_id, expires_at, consumed_at)
  values (p_code, v_owner_id, 'infinity', null)
  on conflict (owner_id) do nothing;

  select code into v_code
  from public.device_pairings
  where owner_id = v_owner_id;

  return v_code;
end;
$$;

create or replace function public.claim_device_pairing(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Perangkat belum terhubung.';
  end if;
  if p_code is null or p_code !~ '^[0-9a-f]{48}$' then
    raise exception 'Format kode perangkat tidak valid.';
  end if;
  if exists (select 1 from public.user_data where user_id = auth.uid()) then
    raise exception 'Perangkat ini sudah memiliki data. Gunakan perangkat baru untuk menyambungkan kode.';
  end if;

  select owner_id into v_owner_id
  from public.device_pairings
  where code = p_code;

  if v_owner_id is null then
    raise exception 'Kode perangkat tidak valid.';
  end if;
  if v_owner_id = auth.uid() then
    raise exception 'Kode harus dimasukkan dari perangkat yang berbeda.';
  end if;

  insert into public.device_access (device_id, owner_id)
  values (auth.uid(), v_owner_id)
  on conflict (device_id) do update
    set owner_id = excluded.owner_id,
        paired_at = now();

  return v_owner_id;
end;
$$;

revoke all on function public.create_device_pairing(text) from public;
revoke all on function public.claim_device_pairing(text) from public;
grant execute on function public.create_device_pairing(text) to authenticated;
grant execute on function public.claim_device_pairing(text) to authenticated;
