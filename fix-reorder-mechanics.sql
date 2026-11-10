-- Correção pontual: reorganiza toda a fila em uma única atualização atômica.
-- Execute no SQL Editor do projeto Supabase conectado ao Gestão Pátio.
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

  select count(*), count(distinct ids.id)
    into v_count, v_unique_count
    from unnest(p_mechanic_ids) as ids(id);

  if v_count <> (select count(*) from public.mechanics)
     or v_unique_count <> v_count
     or exists (
       select 1
       from unnest(p_mechanic_ids) as ids(id)
       where not exists (
         select 1 from public.mechanics m where m.id = ids.id
       )
     ) then
    raise exception 'A lista deve conter cada mecânico cadastrado exatamente uma vez';
  end if;

  update public.mechanics m
    set queue_position = ordering.position,
        updated_at = now()
    from unnest(p_mechanic_ids) with ordinality as ordering(id, position)
    where m.id = ordering.id;

  insert into public.audit_log(actor_id, action, details)
    values (auth.uid(), 'queue_reordered', jsonb_build_object('mechanic_ids', to_jsonb(p_mechanic_ids)));
end;
$$;
