-- Execute no SQL Editor para habilitar o cadastro de mecânicos em um projeto existente.
alter table public.mechanics add column if not exists vehicle_plate text;
alter table public.vehicles add column if not exists plate text;

drop function if exists public.start_service(uuid, text);
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
revoke all on function public.start_service(uuid, text, text) from public;
grant execute on function public.start_service(uuid, text, text) to authenticated;

create or replace function public.add_mechanic(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_mechanic_id uuid;
  v_position integer;
begin
  perform public.require_admin();
  perform public.lock_patio();
  if v_name is null or length(v_name) > 80 then
    raise exception 'Informe um nome de mecânico com até 80 caracteres';
  end if;
  if exists (select 1 from public.mechanics where lower(name) = lower(v_name)) then
    raise exception 'Já existe um mecânico com esse nome';
  end if;
  select coalesce(max(queue_position), 0) + 1 into v_position from public.mechanics;
  insert into public.mechanics(name, queue_position)
    values (v_name, v_position) returning id into v_mechanic_id;
  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'mechanic_added', jsonb_build_object('name', v_name, 'mechanic_id', v_mechanic_id));
  return v_mechanic_id;
end;
$$;

revoke all on function public.add_mechanic(text) from public;
grant execute on function public.add_mechanic(text) to authenticated;

notify pgrst, 'reload schema';
