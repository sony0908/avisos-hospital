-- Intercomunicador por terminales compartidos (no usuarios personales).
-- Ejecutar una vez en Supabase > SQL Editor con un rol administrador.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code) and code ~ '^[A-Z0-9_]{2,40}$'),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.rooms (code, name) values
  ('THALAMUS', 'Thalamus'), ('SCANER', 'Scaner'), ('RAYOS_3', 'Rayos 3'),
  ('RAYOS_4', 'Rayos 4'), ('RAYOS_5', 'Rayos 5'), ('ECO_3', 'Eco 3')
-- No reactiva salas que un administrador haya deshabilitado al volver a ejecutar
-- este esquema para una actualización.
on conflict (code) do update set name = excluded.name;

create table if not exists public.terminal_activation_codes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  label text,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

-- Solo estos correos pueden usar la consola maestra. Las salas siguen usando
-- identidades anónimas y no obtienen estos privilegios.
create table if not exists public.master_operators (
  email text primary key check (email = lower(email)),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.master_operators (email) values ('ericksong4b2016@gmail.com')
on conflict (email) do update set active = true;

-- Solicitudes de emparejamiento: el QR contiene un código temporal, no una
-- sesión ni un JWT. El servidor conserva solo su hash.
create table if not exists public.terminal_pairings (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index if not exists terminal_pairings_pending_idx on public.terminal_pairings(auth_user_id, expires_at) where used_at is null;

create table if not exists public.terminals (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  label text,
  active boolean not null default true,
  activated_at timestamptz not null default now(),
  deactivated_at timestamptz
);
create index if not exists terminals_room_active_idx on public.terminals(room_id) where active;

create table if not exists public.notices (
  id uuid primary key default gen_random_uuid(),
  source_terminal_id uuid references public.terminals(id) on delete restrict,
  source_room_id uuid not null references public.rooms(id) on delete restrict,
  destination_room_id uuid references public.rooms(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 500),
  priority text not null check (priority in ('immediate', 'urgent', 'routine')),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'active' and closed_at is null) or (status = 'closed' and closed_at is not null))
);
-- Los avisos enviados desde la consola maestra no representan un PC físico.
alter table public.notices alter column source_terminal_id drop not null;
create index if not exists notices_destination_created_idx on public.notices(destination_room_id, created_at desc);
create index if not exists notices_source_created_idx on public.notices(source_room_id, created_at desc);

create table if not exists public.notice_acknowledgements (
  notice_id uuid not null references public.notices(id) on delete cascade,
  terminal_id uuid not null references public.terminals(id) on delete restrict,
  acknowledged_at timestamptz not null default now(),
  primary key (notice_id, terminal_id)
);

-- Estas funciones no reciben la sala desde el navegador: siempre la deducen del
-- terminal activado, evitando que un cliente pueda fingir ser otra sala.
create or replace function public.current_terminal_id()
returns uuid language sql stable security definer set search_path = public as $$
  select t.id from public.terminals t
  join public.rooms r on r.id = t.room_id and r.active = true
  where t.auth_user_id = (select auth.uid()) and t.active = true
  limit 1;
$$;

create or replace function public.current_terminal_room_id()
returns uuid language sql stable security definer set search_path = public as $$
  select room_id from public.terminals
  where id = public.current_terminal_id()
  limit 1;
$$;

create or replace function public.my_terminal_context()
returns table (terminal_id uuid, room_code text, room_name text, terminal_label text)
language sql stable security definer set search_path = public as $$
  select t.id, r.code, r.name, t.label
  from public.terminals t join public.rooms r on r.id = t.room_id
  where t.id = public.current_terminal_id();
$$;

create or replace function public.is_master_operator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.master_operators
    where active and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.my_master_context()
returns table (email text) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_master_operator() then raise exception 'Esta cuenta no está autorizada para la consola maestra'; end if;
  return query select lower(auth.jwt() ->> 'email');
end;
$$;

create or replace function public.create_activation_code(
  p_room_code text, p_label text default null, p_ttl interval default interval '15 minutes'
)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_room_id uuid;
  v_code text;
  v_display_code text;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  v_random_byte integer;
begin
  if p_ttl < interval '1 minute' or p_ttl > interval '24 hours' then
    raise exception 'La duración debe estar entre 1 minuto y 24 horas';
  end if;
  select id into v_room_id from public.rooms where code = upper(trim(p_room_code)) and active;
  if v_room_id is null then raise exception 'Sala no válida'; end if;

  -- 16 caracteres de un alfabeto sin I, L, O ni U: 30^16 posibilidades
  -- (~78 bits). Los guiones se agregan solo para facilitar el copiado manual.
  loop
    v_code := '';
    while char_length(v_code) < 16 loop
      v_random_byte := get_byte(extensions.gen_random_bytes(1), 0);
      -- Evita el sesgo de módulo: 240 es múltiplo exacto de 30.
      if v_random_byte < 240 then
        v_code := v_code || substr(v_alphabet, (v_random_byte % 30) + 1, 1);
      end if;
    end loop;

    begin
      insert into public.terminal_activation_codes(room_id, label, code_hash, expires_at)
      values (v_room_id, nullif(trim(p_label), ''), encode(extensions.digest(v_code, 'sha256'), 'hex'), now() + p_ttl);
      exit;
    exception when unique_violation then
      -- Una colisión es extremadamente improbable; se genera otro código.
      null;
    end;
  end loop;

  v_display_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4)
    || '-' || substr(v_code, 9, 4) || '-' || substr(v_code, 13, 4);
  return v_display_code;
end;
$$;

create or replace function public.activate_terminal(p_code text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code public.terminal_activation_codes%rowtype;
  v_normalized_code text := regexp_replace(upper(trim(p_code)), '[-[:space:]]', '', 'g');
begin
  if auth.uid() is null then raise exception 'Terminal sin identidad'; end if;
  if public.current_terminal_id() is not null then raise exception 'Este navegador ya está activado'; end if;

  -- También se aceptan los códigos hexadecimales largos emitidos antes de esta
  -- actualización, hasta que expiren, para no interrumpir activaciones en curso.
  if v_normalized_code !~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{16}$'
     and v_normalized_code !~ '^[A-F0-9]{48}$' then
    raise exception 'Formato de código de activación inválido';
  end if;
  select * into v_code from public.terminal_activation_codes
  where code_hash = encode(extensions.digest(v_normalized_code, 'sha256'), 'hex')
    and used_at is null and expires_at > now()
  for update;
  if not found then raise exception 'Código de activación inválido o vencido'; end if;
  update public.terminals
  set room_id = v_code.room_id, label = v_code.label, active = true, activated_at = now(), deactivated_at = null
  where auth_user_id = auth.uid() and active = false;
  if not found then
    insert into public.terminals(auth_user_id, room_id, label) values (auth.uid(), v_code.room_id, v_code.label);
  end if;
  update public.terminal_activation_codes set used_at = now() where id = v_code.id;
end;
$$;

create or replace function public.request_terminal_pairing()
returns table (pairing_code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  v_random_byte integer;
  v_expires_at timestamptz := now() + interval '10 minutes';
begin
  if auth.uid() is null then raise exception 'Terminal sin identidad'; end if;
  if public.is_master_operator() then raise exception 'La consola maestra no puede solicitar un QR de sala'; end if;
  if public.current_terminal_id() is not null then raise exception 'Este navegador ya está activado'; end if;

  -- Al renovar el QR, el anterior queda inutilizable de inmediato.
  update public.terminal_pairings p set used_at = now()
  where p.auth_user_id = auth.uid() and p.used_at is null and p.expires_at > now();

  loop
    v_code := '';
    while char_length(v_code) < 16 loop
      v_random_byte := get_byte(extensions.gen_random_bytes(1), 0);
      if v_random_byte < 240 then v_code := v_code || substr(v_alphabet, (v_random_byte % 30) + 1, 1); end if;
    end loop;
    begin
      insert into public.terminal_pairings(auth_user_id, code_hash, expires_at)
      values (auth.uid(), encode(extensions.digest(v_code, 'sha256'), 'hex'), v_expires_at);
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;

  return query select substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4) || '-' || substr(v_code, 13, 4), v_expires_at;
end;
$$;

create or replace function public.approve_terminal_pairing(p_code text, p_room_code text, p_label text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_pairing public.terminal_pairings%rowtype;
  v_room_id uuid;
  v_code text := regexp_replace(upper(trim(p_code)), '[-[:space:]]', '', 'g');
begin
  if not public.is_master_operator() then raise exception 'Solo un operador maestro puede asignar salas'; end if;
  if v_code !~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{16}$' then raise exception 'Formato de QR inválido'; end if;
  select id into v_room_id from public.rooms where code = upper(trim(p_room_code)) and active;
  if v_room_id is null then raise exception 'Sala no válida'; end if;
  select * into v_pairing from public.terminal_pairings
  where code_hash = encode(extensions.digest(v_code, 'sha256'), 'hex') and used_at is null and expires_at > now()
  for update;
  if not found then raise exception 'QR inválido, usado o vencido'; end if;

  update public.terminals set room_id = v_room_id, label = nullif(trim(p_label), ''), active = true, activated_at = now(), deactivated_at = null
  where auth_user_id = v_pairing.auth_user_id and active = false;
  if not found then
    insert into public.terminals(auth_user_id, room_id, label) values (v_pairing.auth_user_id, v_room_id, nullif(trim(p_label), ''));
  end if;
  update public.terminal_pairings set used_at = now() where id = v_pairing.id;
end;
$$;

-- Revoca el acceso del navegador sin borrar su historial ni los avisos.
-- Si se vuelve a usar ese PC, la página mostrará otro QR para asignarlo de nuevo.
create or replace function public.deactivate_terminal(p_terminal_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_master_operator() then
    raise exception 'Solo un operador maestro puede desvincular terminales';
  end if;

  update public.terminals
  set active = false, deactivated_at = now()
  where id = p_terminal_id and active = true;

  if not found then
    raise exception 'El terminal ya estaba desvinculado o no existe';
  end if;
end;
$$;

create or replace function public.create_notice(p_destination_code text, p_body text, p_priority text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_terminal uuid := public.current_terminal_id(); v_source_room uuid; v_source_code text;
declare v_destination uuid; v_notice uuid; v_body text := btrim(p_body);
begin
  if v_terminal is null then raise exception 'Terminal no activado'; end if;
  if char_length(v_body) not between 1 and 500 then raise exception 'El aviso debe tener entre 1 y 500 caracteres'; end if;
  if p_priority not in ('immediate', 'urgent', 'routine') then raise exception 'Prioridad no válida'; end if;
  select t.room_id, r.code into v_source_room, v_source_code from public.terminals t join public.rooms r on r.id = t.room_id where t.id = v_terminal;
  if upper(trim(p_destination_code)) = 'ALL' then
    if v_source_code <> 'THALAMUS' then raise exception 'Este terminal no puede enviar avisos a todas las salas'; end if;
    v_destination := null;
  else
    select id into v_destination from public.rooms where code = upper(trim(p_destination_code)) and active;
    if v_destination is null then raise exception 'Sala destinataria no válida'; end if;
  end if;
  insert into public.notices(source_terminal_id, source_room_id, destination_room_id, body, priority)
  values (v_terminal, v_source_room, v_destination, v_body, p_priority) returning id into v_notice;
  return v_notice;
end;
$$;

create or replace function public.create_master_notice(p_source_room_code text, p_destination_code text, p_body text, p_priority text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_source_room uuid;
  v_destination uuid;
  v_notice uuid;
  v_body text := btrim(p_body);
begin
  if not public.is_master_operator() then raise exception 'Solo un operador maestro puede enviar como otra sala'; end if;
  if char_length(v_body) not between 1 and 500 then raise exception 'El aviso debe tener entre 1 y 500 caracteres'; end if;
  if p_priority not in ('immediate', 'urgent', 'routine') then raise exception 'Prioridad no válida'; end if;
  select id into v_source_room from public.rooms where code = upper(trim(p_source_room_code)) and active;
  if v_source_room is null then raise exception 'Sala de origen no válida'; end if;
  if upper(trim(p_destination_code)) = 'ALL' then
    v_destination := null;
  else
    select id into v_destination from public.rooms where code = upper(trim(p_destination_code)) and active;
    if v_destination is null then raise exception 'Sala destinataria no válida'; end if;
  end if;
  insert into public.notices(source_terminal_id, source_room_id, destination_room_id, body, priority)
  values (null, v_source_room, v_destination, v_body, p_priority) returning id into v_notice;
  return v_notice;
end;

create or replace function public.acknowledge_notice(p_notice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_terminal uuid := public.current_terminal_id(); v_room uuid := public.current_terminal_room_id();
declare v_notice public.notices%rowtype;
begin
  if v_terminal is null then raise exception 'Terminal no activado'; end if;
  select * into v_notice from public.notices where id = p_notice_id and status = 'active';
  if not found then raise exception 'Aviso no disponible'; end if;
  if v_notice.source_terminal_id = v_terminal or (v_notice.destination_room_id is not null and v_notice.destination_room_id <> v_room) then
    raise exception 'Este terminal no puede confirmar ese aviso';
  end if;
  insert into public.notice_acknowledgements(notice_id, terminal_id) values (p_notice_id, v_terminal) on conflict do nothing;
end;
$$;

create or replace function public.close_notice(p_notice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.notices set status = 'closed', closed_at = now()
  where id = p_notice_id and status = 'active'
    and (public.is_master_operator() or source_terminal_id = public.current_terminal_id());
  if not found then raise exception 'Solo el terminal que originó el aviso o la consola maestra puede cerrarlo'; end if;
end;
$$;

-- El borrado está reservado para la consola maestra. Las confirmaciones de
-- recepción se eliminan automáticamente por la relación ON DELETE CASCADE.
create or replace function public.delete_notice(p_notice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_master_operator() then
    raise exception 'Solo un operador maestro puede eliminar avisos';
  end if;

  delete from public.notices where id = p_notice_id;
  if not found then
    raise exception 'El aviso no existe o ya fue eliminado';
  end if;
end;
$$;

alter table public.rooms enable row level security;
alter table public.terminals enable row level security;
alter table public.notices enable row level security;
alter table public.notice_acknowledgements enable row level security;
alter table public.terminal_activation_codes enable row level security;
alter table public.terminal_pairings enable row level security;
alter table public.master_operators enable row level security;

drop policy if exists rooms_for_activated_terminals on public.rooms;
create policy rooms_for_activated_terminals on public.rooms for select to authenticated
using (public.is_master_operator() or public.current_terminal_id() is not null);
drop policy if exists own_terminal_only on public.terminals;
create policy own_terminal_only on public.terminals for select to authenticated
using (public.is_master_operator() or auth_user_id = (select auth.uid()));
drop policy if exists notices_for_source_or_destination on public.notices;
create policy notices_for_source_or_destination on public.notices for select to authenticated
using (public.is_master_operator() or source_room_id = public.current_terminal_room_id() or destination_room_id = public.current_terminal_room_id() or destination_room_id is null);
drop policy if exists acknowledgements_for_receiver_or_sender on public.notice_acknowledgements;
create policy acknowledgements_for_receiver_or_sender on public.notice_acknowledgements for select to authenticated
using (public.is_master_operator() or terminal_id = public.current_terminal_id() or exists (select 1 from public.notices n where n.id = notice_id and n.source_terminal_id = public.current_terminal_id()));

revoke all on public.rooms, public.terminals, public.notices, public.notice_acknowledgements, public.terminal_activation_codes, public.terminal_pairings, public.master_operators from anon, authenticated;
grant select on public.rooms, public.terminals, public.notices, public.notice_acknowledgements to authenticated;
revoke all on function public.create_activation_code(text, text, interval) from public, anon, authenticated;
revoke all on function public.activate_terminal(text) from public, anon;
revoke all on function public.create_notice(text, text, text) from public, anon;
revoke all on function public.acknowledge_notice(uuid) from public, anon;
revoke all on function public.close_notice(uuid) from public, anon;
revoke all on function public.delete_notice(uuid) from public, anon;
revoke all on function public.request_terminal_pairing(), public.approve_terminal_pairing(text, text, text), public.deactivate_terminal(uuid), public.create_master_notice(text, text, text, text), public.my_master_context() from public, anon;
grant execute on function public.my_terminal_context(), public.activate_terminal(text), public.create_notice(text, text, text), public.acknowledge_notice(uuid), public.close_notice(uuid), public.delete_notice(uuid), public.request_terminal_pairing(), public.approve_terminal_pairing(text, text, text), public.deactivate_terminal(uuid), public.create_master_notice(text, text, text, text), public.my_master_context() to authenticated;

-- Realtime privado: deshabilita también "Allow public access to channels" en
-- Supabase > Realtime > Settings antes de publicar la nueva versión.
drop policy if exists terminals_join_their_private_channel on realtime.messages;
create policy terminals_join_their_private_channel on realtime.messages for select to authenticated
using (
  realtime.topic() = ('terminal:' || public.current_terminal_id()::text)
  or (realtime.topic() = 'master' and public.is_master_operator())
);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notices') then
    alter publication supabase_realtime add table public.notices;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notice_acknowledgements') then
    alter publication supabase_realtime add table public.notice_acknowledgements;
  end if;
end $$;
