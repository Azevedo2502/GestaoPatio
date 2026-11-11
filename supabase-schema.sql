-- Gestão Pátio: execute uma vez no SQL Editor do seu projeto Supabase.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.mechanics (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  queue_position integer not null check (queue_position > 0),
  status text not null default 'available'
    check (status in ('available', 'maintenance', 'pause', 'absent')),
  vehicle_model text,
  vehicle_plate text,
  current_vehicle_id uuid,
  updated_at timestamptz not null default now()
);

alter table public.mechanics add column if not exists vehicle_plate text;

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  model text not null check (length(trim(model)) between 1 and 100),
  plate text,
  status text not null default 'waiting' check (status in ('waiting', 'in_service', 'completed')),
  mechanic_id uuid references public.mechanics(id) on delete set null,
  entered_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.vehicles add column if not exists plate text;

alter table public.mechanics drop constraint if exists mechanics_queue_position_key;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.mechanics'::regclass
      and conname = 'mechanics_queue_position_unique'
  ) then
    alter table public.mechanics
      add constraint mechanics_queue_position_unique
      unique (queue_position) deferrable initially deferred;
  end if;
end $$;

alter table public.mechanics
  drop constraint if exists mechanics_current_vehicle_id_fkey;
alter table public.mechanics
  add constraint mechanics_current_vehicle_id_fkey
  foreign key (current_vehicle_id) references public.vehicles(id) on delete set null;

create table if not exists public.daily_metrics (
  business_date date primary key,
  entries_count integer not null default 0 check (entries_count >= 0),
  completed_count integer not null default 0 check (completed_count >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_openings (
  work_date date primary key,
  confirmed_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid not null references auth.users(id),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.system_state (
  singleton boolean primary key default true check (singleton),
  updated_at timestamptz not null default now()
);
insert into public.system_state(singleton) values (true) on conflict do nothing;

insert into public.mechanics(name, queue_position) values
  ('Yago', 1), ('Vitor', 2), ('Rodrigo', 3), ('José', 4)
on conflict (name) do nothing;

alter table public.admin_users enable row level security;
alter table public.mechanics enable row level security;
alter table public.vehicles enable row level security;
alter table public.daily_metrics enable row level security;
alter table public.daily_openings enable row level security;
alter table public.audit_log enable row level security;
alter table public.system_state enable row level security;

drop policy if exists "Public can read mechanics" on public.mechanics;
create policy "Public can read mechanics" on public.mechanics for select to anon, authenticated using (true);
drop policy if exists "Public can read daily metrics" on public.daily_metrics;
create policy "Public can read daily metrics" on public.daily_metrics for select to anon, authenticated using (true);
drop policy if exists "Admins can read own admin record" on public.admin_users;
create policy "Admins can read own admin record" on public.admin_users for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Admins can manage vehicles" on public.vehicles;
create policy "Admins can manage vehicles" on public.vehicles for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = (select auth.uid())));
drop policy if exists "Admins can read openings" on public.daily_openings;
create policy "Admins can read openings" on public.daily_openings for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = (select auth.uid())));
drop policy if exists "Admins can read audit log" on public.audit_log;
create policy "Admins can read audit log" on public.audit_log for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = (select auth.uid())));

grant select on public.mechanics, public.daily_metrics to anon, authenticated;
grant select on public.vehicles, public.daily_openings, public.audit_log, public.admin_users to authenticated;
revoke insert, update, delete on public.mechanics, public.vehicles, public.daily_metrics,
  public.daily_openings, public.audit_log, public.system_state, public.admin_users from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.require_admin()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Acesso administrativo não autorizado' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.require_admin() from public;

create or replace function public.lock_patio()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.system_state where singleton = true for update;
end;
$$;
revoke all on function public.lock_patio() from public;

create or replace function public.require_open_workday()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.daily_openings
    where work_date = (now() at time zone 'America/Sao_Paulo')::date
  ) then
    raise exception 'Confirme a abertura do expediente antes de alterar a operação';
  end if;
end;
$$;
revoke all on function public.require_open_workday() from public;

create or replace function public.register_vehicle(p_model text, p_plate text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_plate text := upper(regexp_replace(coalesce(trim(p_plate), ''), '[^A-Za-z0-9]', '', 'g'));
begin
  perform public.require_admin();
  perform public.lock_patio();
  perform public.require_open_workday();
  if p_model is null or length(trim(p_model)) not between 1 and 100 then
    raise exception 'Informe um modelo de veículo válido';
  end if;
  insert into public.vehicles(model, plate) values (trim(p_model), case when v_plate = '' then null else v_plate end) returning id into v_id;
  insert into public.daily_metrics(business_date, entries_count)
    values (v_today, 1)
    on conflict (business_date) do update
      set entries_count = public.daily_metrics.entries_count + 1, updated_at = now();
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'vehicle_registered', jsonb_build_object('model', trim(p_model), 'plate', case when v_plate = '' then null else v_plate end, 'vehicle_id', v_id));
  return v_id;
end;
$$;

create or replace function public.start_service(p_mechanic_id uuid, p_model text, p_plate text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_name text;
  v_status text;
  v_current_vehicle_id uuid;
  v_plate text := upper(regexp_replace(coalesce(trim(p_plate), ''), '[^A-Za-z0-9]', '', 'g'));
begin
  perform public.require_admin();
  perform public.lock_patio();
  perform public.require_open_workday();
  if p_model is null or length(trim(p_model)) not between 1 and 100 then
    raise exception 'Informe o modelo do veículo';
  end if;
  select name, status, current_vehicle_id into v_name, v_status, v_current_vehicle_id
    from public.mechanics where id = p_mechanic_id for update;
  if not found then raise exception 'Mecânico não encontrado'; end if;
  if v_status = 'maintenance' then raise exception 'O mecânico já está em manutenção'; end if;
  if v_current_vehicle_id is not null then
    if not exists (
      select 1 from public.vehicles
      where id = v_current_vehicle_id and status = 'in_service' and model = trim(p_model)
    ) then
      raise exception 'O mecânico já possui outro veículo associado';
    end if;
    update public.mechanics set status = 'maintenance', vehicle_model = trim(p_model), vehicle_plate = v_plate, updated_at = now()
      where id = p_mechanic_id;
    insert into public.audit_log(actor_id, action, details)
      values (auth.uid(), 'service_resumed', jsonb_build_object('mechanic', v_name, 'model', trim(p_model), 'plate', v_plate));
    return v_current_vehicle_id;
  end if;
  insert into public.vehicles(model, plate, status, mechanic_id)
    values (trim(p_model), case when v_plate = '' then null else v_plate end, 'in_service', p_mechanic_id) returning id into v_id;
  update public.mechanics set status = 'maintenance', vehicle_model = trim(p_model), vehicle_plate = v_plate,
    current_vehicle_id = v_id, updated_at = now() where id = p_mechanic_id;
  insert into public.daily_metrics(business_date, entries_count)
    values (v_today, 1)
    on conflict (business_date) do update
      set entries_count = public.daily_metrics.entries_count + 1, updated_at = now();
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'service_started', jsonb_build_object('mechanic', v_name, 'model', trim(p_model), 'plate', v_plate));
  return v_id;
end;
$$;

create or replace function public.assign_waiting_vehicle(p_mechanic_id uuid, p_vehicle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_current_vehicle_id uuid;
  v_vehicle public.vehicles%rowtype;
begin
  perform public.require_admin();
  perform public.lock_patio();
  perform public.require_open_workday();
  select status, current_vehicle_id into v_status, v_current_vehicle_id
    from public.mechanics where id = p_mechanic_id for update;
  if not found then raise exception 'Mecânico não encontrado'; end if;
  if v_status = 'maintenance' then raise exception 'Finalize o serviço atual antes de atribuir outro veículo'; end if;
  if v_current_vehicle_id is not null then raise exception 'Resolva o veículo atualmente associado antes de atribuir outro'; end if;
  select * into v_vehicle from public.vehicles where id = p_vehicle_id and status = 'waiting' for update;
  if not found then raise exception 'Veículo não está mais aguardando'; end if;
  update public.vehicles set status = 'in_service', mechanic_id = p_mechanic_id, plate = coalesce(v_vehicle.plate, null) where id = p_vehicle_id;
  update public.mechanics set status = 'maintenance', vehicle_model = v_vehicle.model,
    vehicle_plate = coalesce(v_vehicle.plate, null), current_vehicle_id = p_vehicle_id, updated_at = now() where id = p_mechanic_id;
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'vehicle_assigned', jsonb_build_object('mechanic_id', p_mechanic_id, 'vehicle_id', p_vehicle_id));
end;
$$;

create or replace function public.set_mechanic_status(p_mechanic_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_vehicle_id uuid;
begin
  perform public.require_admin();
  perform public.lock_patio();
  perform public.require_open_workday();
  if p_status not in ('available', 'pause', 'absent') then
    raise exception 'Use iniciar serviço para o status em manutenção';
  end if;
  select name, current_vehicle_id into v_name, v_vehicle_id
    from public.mechanics where id = p_mechanic_id for update;
  if not found then raise exception 'Mecânico não encontrado'; end if;
  if p_status = 'available' and v_vehicle_id is not null then
    update public.vehicles set status = 'waiting', mechanic_id = null
      where id = v_vehicle_id and status = 'in_service';
  end if;
  update public.mechanics
    set status = p_status,
        vehicle_model = case when p_status = 'available' then null else vehicle_model end,
        vehicle_plate = case when p_status = 'available' then null else vehicle_plate end,
        current_vehicle_id = case when p_status = 'available' then null else current_vehicle_id end,
        updated_at = now()
    where id = p_mechanic_id;
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'status_changed', jsonb_build_object('mechanic', v_name, 'status', p_status));
end;
$$;

create or replace function public.finish_service(p_mechanic_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vehicle_id uuid;
  v_name text;
  v_model text;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_old_position integer;
  v_last_position integer;
begin
  perform public.require_admin();
  perform public.lock_patio();
  perform public.require_open_workday();
  select current_vehicle_id, name, vehicle_model, queue_position
    into v_vehicle_id, v_name, v_model, v_old_position
    from public.mechanics where id = p_mechanic_id for update;
  if not found then raise exception 'Mecânico não encontrado'; end if;
  if v_vehicle_id is null then raise exception 'Não há veículo associado para finalizar'; end if;
  select coalesce(max(queue_position), 0) into v_last_position from public.mechanics;
  update public.vehicles set status = 'completed', completed_at = now(), plate = coalesce(plate, (select vehicle_plate from public.mechanics where id = p_mechanic_id))
    where id = v_vehicle_id and status = 'in_service';
  if not found then raise exception 'O veículo não está em manutenção'; end if;
  update public.mechanics set status = 'available', vehicle_model = null,
    vehicle_plate = null, current_vehicle_id = null, queue_position = v_last_position + 1, updated_at = now()
    where id = p_mechanic_id;
  update public.mechanics set queue_position = queue_position + v_last_position + 1
    where id <> p_mechanic_id;
  update public.mechanics
    set queue_position = queue_position - (v_last_position + 1)
      - case when queue_position - (v_last_position + 1) > v_old_position then 1 else 0 end
    where id <> p_mechanic_id;
  update public.mechanics set queue_position = v_last_position
    where id = p_mechanic_id;
  update public.daily_metrics set completed_count = completed_count + 1, updated_at = now()
    where business_date = v_today;
  if not found then
    insert into public.daily_metrics(business_date, completed_count) values (v_today, 1);
  end if;
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'service_finished', jsonb_build_object('mechanic', v_name, 'model', v_model));
end;
$$;

create or replace function public.reorder_mechanics(p_mechanic_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_unique_count integer;
begin
  perform public.require_admin();
  perform public.lock_patio();
  select count(*), count(distinct id) into v_count, v_unique_count
    from unnest(p_mechanic_ids) as ids(id);
  if v_count <> (select count(*) from public.mechanics)
     or v_unique_count <> v_count
     or exists (
       select 1 from unnest(p_mechanic_ids) as ids(id)
       where not exists (select 1 from public.mechanics m where m.id = ids.id)
     ) then
    raise exception 'A lista deve conter cada mecânico cadastrado exatamente uma vez';
  end if;
  update public.mechanics set queue_position = queue_position + v_count
    where id in (select id from public.mechanics);
  update public.mechanics m set queue_position = ordering.position, updated_at = now()
  from unnest(p_mechanic_ids) with ordinality as ordering(id, position)
  where m.id = ordering.id;
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'queue_reordered', jsonb_build_object('mechanic_ids', to_jsonb(p_mechanic_ids)));
end;
$$;

create or replace function public.open_workday(p_attendance jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_count integer;
  v_distinct integer;
begin
  perform public.require_admin();
  perform public.lock_patio();
  if jsonb_typeof(p_attendance) <> 'array' then raise exception 'Confirmação de presença inválida'; end if;
  select count(*), count(distinct a.mechanic_id)
    into v_count, v_distinct
    from jsonb_to_recordset(p_attendance) as a(mechanic_id uuid, attendance text)
    where a.attendance in ('present', 'late', 'absent');
  if v_count <> (select count(*) from public.mechanics)
     or v_distinct <> v_count
     or exists (
       select 1 from jsonb_to_recordset(p_attendance) as a(mechanic_id uuid, attendance text)
       where a.attendance not in ('present', 'late', 'absent')
          or not exists (select 1 from public.mechanics m where m.id = a.mechanic_id)
     ) then
    raise exception 'Informe a presença de cada mecânico exatamente uma vez';
  end if;
  insert into public.daily_openings(work_date, confirmed_by) values (v_today, auth.uid());
  with attendance as (
    select a.mechanic_id, a.attendance
    from jsonb_to_recordset(p_attendance) as a(mechanic_id uuid, attendance text)
  ), ordered as (
    select m.id,
      row_number() over (
        order by case when a.attendance = 'present' then 0 else 1 end, m.queue_position
      )::integer as new_position,
      case
        when a.attendance = 'absent' then 'absent'
        when m.status = 'absent' then 'available'
        else m.status
      end as new_status
    from public.mechanics m join attendance a on a.mechanic_id = m.id
  )
  update public.mechanics m set queue_position = o.new_position,
    status = o.new_status, updated_at = now()
  from ordered o where m.id = o.id;
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'workday_opened', jsonb_build_object('work_date', v_today));
end;
$$;

revoke all on function public.register_vehicle(text, text) from public;
revoke all on function public.start_service(uuid, text, text) from public;
revoke all on function public.assign_waiting_vehicle(uuid, uuid) from public;
revoke all on function public.set_mechanic_status(uuid, text) from public;
revoke all on function public.finish_service(uuid) from public;
revoke all on function public.reorder_mechanics(uuid[]) from public;
revoke all on function public.open_workday(jsonb) from public;
grant execute on function public.register_vehicle(text, text) to authenticated;
grant execute on function public.start_service(uuid, text, text) to authenticated;
grant execute on function public.assign_waiting_vehicle(uuid, uuid) to authenticated;
grant execute on function public.set_mechanic_status(uuid, text) to authenticated;
grant execute on function public.finish_service(uuid) to authenticated;
grant execute on function public.reorder_mechanics(uuid[]) to authenticated;
grant execute on function public.open_workday(jsonb) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mechanics'
  ) then alter publication supabase_realtime add table public.mechanics; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daily_metrics'
  ) then alter publication supabase_realtime add table public.daily_metrics; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vehicles'
  ) then alter publication supabase_realtime add table public.vehicles; end if;
end $$;
