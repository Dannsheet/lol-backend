create or replace function public.credit_deposit(
  p_user_id uuid,
  p_tx_hash text,
  p_amount numeric,
  p_symbol text
)
returns table(
  ok boolean,
  duplicated boolean,
  deposit_id uuid,
  credited numeric,
  new_balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deposit_id uuid;
  v_new_balance numeric;
  v_symbol text;
begin
  if p_user_id is null then
    raise exception 'Falta userId';
  end if;

  if p_tx_hash is null or length(trim(p_tx_hash)) = 0 then
    raise exception 'Falta txHash';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount inválido';
  end if;

  v_symbol := coalesce(nullif(trim(p_symbol), ''), 'USDT');

  -- Lock user row to avoid concurrent balance updates causing unexpected results
  perform 1
  from public.usuarios u
  where u.id = p_user_id
  for update;

  if not found then
    raise exception 'Usuario no encontrado';
  end if;

  begin
    insert into public.depositos (usuario_id, tx_hash, monto, moneda, confirmado)
    values (p_user_id, p_tx_hash, p_amount, v_symbol, true)
    returning id into v_deposit_id;
  exception
    when unique_violation then
      ok := true;
      duplicated := true;
      deposit_id := null;
      credited := 0;
      new_balance := null;
      return next;
      return;
  end;

  update public.usuarios
  set saldo_interno = coalesce(saldo_interno, 0) + p_amount
  where id = p_user_id
  returning saldo_interno into v_new_balance;

  begin
    insert into public.balance_movimientos (
      usuario_id,
      tipo,
      referencia_id,
      monto,
      referencia_tipo
    )
    values (
      p_user_id,
      'deposito',
      v_deposit_id,
      p_amount,
      'deposito'
    );
  exception
    when unique_violation then
      -- Should not happen since referencia_id is unique per deposit, but keep safe.
      null;
  end;

  ok := true;
  duplicated := false;
  deposit_id := v_deposit_id;
  credited := p_amount;
  new_balance := v_new_balance;
  return next;
end;
$$;

grant execute on function public.credit_deposit(uuid, text, numeric, text) to authenticated;
grant execute on function public.credit_deposit(uuid, text, numeric, text) to service_role;
