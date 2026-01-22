alter table public.videos_vistos
add column if not exists calificacion integer;

create or replace function public.registrar_video_visto(
  p_video_id text,
  p_calificacion integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_plan record;
  v_videos_hoy integer;
  v_ganancia numeric;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select p.*
  into v_plan
  from public.subscriptions s
  join public.planes p on p.id = s.plan_id
  where s.user_id = v_user_id
    and s.is_active = true
    and s.expires_at > localtimestamp
  limit 1;

  if not found then
    raise exception 'Usuario sin suscripción activa';
  end if;

  if exists (
    select 1
    from public.videos_vistos
    where usuario_id = v_user_id
      and video_id = p_video_id
  ) then
    raise exception 'Video ya fue visto';
  end if;

  select count(*)
  into v_videos_hoy
  from public.videos_vistos
  where usuario_id = v_user_id
    and visto_en::date = current_date;

  if v_videos_hoy >= coalesce(v_plan.limite_tareas, 1) then
    raise exception 'Límite diario alcanzado';
  end if;

  insert into public.videos_vistos (usuario_id, video_id, calificacion)
  values (v_user_id, p_video_id, p_calificacion);

  v_ganancia := coalesce(v_plan.ganancia_diaria, 0);

  insert into public.movimientos (usuario_id, tipo, monto, descripcion)
  values (v_user_id, 'ingreso', v_ganancia, 'Recompensa por ver video');

  insert into public.cuentas (user_id, balance, total_ganado)
  values (v_user_id, v_ganancia, v_ganancia)
  on conflict (user_id) do update
  set balance = cuentas.balance + excluded.balance,
      total_ganado = cuentas.total_ganado + excluded.total_ganado;
end;
$$;

grant execute on function public.registrar_video_visto(text, integer) to authenticated;
grant execute on function public.registrar_video_visto(text, integer) to service_role;
