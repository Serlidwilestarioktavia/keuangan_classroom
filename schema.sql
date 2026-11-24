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

create or replace function public.create_device_pairing(p_code text)
returns void
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

  select owner_id into v_owner_id
  from public.device_access
  where device_id = auth.uid();
  v_owner_id := coalesce(v_owner_id, auth.uid());

  delete from public.device_pairings
  where owner_id = v_owner_id or expires_at <= now();

  insert into public.device_pairings (code, owner_id, expires_at)
  values (p_code, v_owner_id, now() + interval '10 minutes');
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

  update public.device_pairings
  set consumed_at = now()
  where code = p_code
    and expires_at > now()
    and consumed_at is null
  returning owner_id into v_owner_id;

  if v_owner_id is null then
    raise exception 'Kode tidak valid, kedaluwarsa, atau sudah digunakan.';
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
