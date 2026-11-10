-- Correção pontual: substitui a função de abertura sem a atualização em duas etapas.
-- Execute no SQL Editor do projeto Supabase conectado ao Gestão Pátio.
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
  if jsonb_typeof(p_attendance) <> 'array' then
    raise exception 'Confirmação de presença inválida';
  end if;

  select count(*), count(distinct a.mechanic_id)
    into v_count, v_distinct
    from jsonb_to_recordset(p_attendance) as a(mechanic_id uuid, attendance text)
    where a.attendance in ('present', 'late', 'absent');

  if v_count <> (select count(*) from public.mechanics)
     or v_distinct <> v_count
     or exists (
       select 1
       from jsonb_to_recordset(p_attendance) as a(mechanic_id uuid, attendance text)
       where a.attendance not in ('present', 'late', 'absent')
          or not exists (
            select 1 from public.mechanics m where m.id = a.mechanic_id
          )
     ) then
    raise exception 'Informe a presença de cada mecânico exatamente uma vez';
  end if;

  insert into public.daily_openings(work_date, confirmed_by)
    values (v_today, auth.uid());

  with attendance as (
    select a.mechanic_id, a.attendance
    from jsonb_to_recordset(p_attendance) as a(mechanic_id uuid, attendance text)
  ), ordered as (
    select m.id,
      row_number() over (
        order by case when a.attendance = 'present' then 0 else 1 end,
          m.queue_position
      )::integer as new_position,
      case
        when a.attendance = 'absent' then 'absent'
        when m.status = 'absent' then 'available'
        else m.status
      end as new_status
    from public.mechanics m
    join attendance a on a.mechanic_id = m.id
  )
  update public.mechanics m
    set queue_position = o.new_position,
        status = o.new_status,
        updated_at = now()
    from ordered o
    where m.id = o.id;

  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'workday_opened', jsonb_build_object('work_date', v_today));
end;
$$;
