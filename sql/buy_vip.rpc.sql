create or replace function public.buy_vip(
  p_user_id uuid,
  p_plan_id integer
)
returns table(
  subscription_id uuid,
  expires_at timestamp without time zone,
  new_balance numeric,
  plan_precio numeric,
  nivel1_pct numeric,
  nivel2_pct numeric,
  nivel3_pct numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan record;
  v_user record;
  v_expires timestamp without time zone;
  v_precio numeric;
begin
  if p_user_id is null then
    raise exception 'Usuario no encontrado';
  end if;

  if p_plan_id is null then
    raise exception 'Plan no existe';
  end if;

  select
    p.precio,
    p.duracion_dias,
    p.nivel1_pct,
    p.nivel2_pct,
    p.nivel3_pct
  into v_plan
  from public.planes p
  where p.id = p_plan_id;

  if not found then
    raise exception 'Plan no existe';
  end if;

  v_precio := v_plan.precio;
  if v_precio is null or v_precio <= 0 then
    raise exception 'Plan no existe';
  end if;

  select u.saldo_interno
  into v_user
  from public.usuarios u
  where u.id = p_user_id
  for update;

  if not found then
    raise exception 'Usuario no encontrado';
  end if;

  perform 1
  from public.subscriptions s
  where s.user_id = p_user_id
    and s.is_active = true;

  if found then
    raise exception 'Ya tienes una suscripción activa';
  end if;

  if coalesce(v_user.saldo_interno, 0) < v_precio then
    raise exception 'Saldo insuficiente';
  end if;

  update public.usuarios
  set saldo_interno = coalesce(saldo_interno, 0) - v_precio
  where id = p_user_id
  returning saldo_interno into new_balance;

  v_expires := localtimestamp + (coalesce(v_plan.duracion_dias, 90)::text || ' days')::interval;

  begin
    insert into public.subscriptions (user_id, plan_id, is_active, expires_at)
    values (p_user_id, p_plan_id, true, v_expires)
    returning id into subscription_id;
  exception
    when unique_violation then
      raise exception 'Ya tienes una suscripción activa';
  end;

  insert into public.balance_movimientos (
    usuario_id,
    tipo,
    referencia_id,
    monto,
    referencia_tipo
  )
  values (
    p_user_id,
    'compra_vip',
    subscription_id,
    v_precio,
    'vip'
  );

  expires_at := v_expires;
  plan_precio := v_precio;
  nivel1_pct := v_plan.nivel1_pct;
  nivel2_pct := v_plan.nivel2_pct;
  nivel3_pct := v_plan.nivel3_pct;

  return next;
end;
$$;

grant execute on function public.buy_vip(uuid, integer) to authenticated;
grant execute on function public.buy_vip(uuid, integer) to service_role;
