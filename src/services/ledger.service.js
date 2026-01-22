import { supabase } from '../config/supabase.js'

export async function acreditarSaldo({
  userId,
  monto,
  descripcion
}) {
  return supabase.rpc('registrar_movimiento', {
    p_usuario_id: userId,
    p_tipo: 'ingreso',
    p_monto: monto,
    p_descripcion: descripcion
  })
}
