import express from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router()

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;

    const [{ data: usuario, error: usuarioError }, { data: cuenta, error: cuentaError }] =
      await Promise.all([
        supabaseAdmin
          .from("usuarios")
          .select("id, email, invite_code, referred_by, saldo_interno, is_admin")
          .eq("id", userId)
          .maybeSingle(),
        supabaseAdmin
          .from("cuentas")
          .select("balance, total_ganado")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);

    if (usuarioError) throw usuarioError;
    if (cuentaError) throw cuentaError;

    return res.json({
      message: 'Usuario autenticado correctamente',
      user: req.user,
      usuario: usuario ?? null,
      cuenta: cuenta ?? null,
    })
  } catch (err) {
    console.error('❌ Error en GET /me:', err)
    return res.status(500).json({ error: 'Error interno del servidor' })
  }
})

export default router
