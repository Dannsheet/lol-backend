import express from 'express';
import bcrypt from 'bcrypt';
import { authMiddleware } from '../middlewares/auth.js';
import { supabaseAdmin } from '../services/supabase.service.js';

const router = express.Router();

/**
 * Configurar o cambiar PIN de retiro
 */
router.post('/set-withdraw-pin', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pin } = req.body;

    if (!pin || pin.length < 4) {
      return res.status(400).json({ error: 'PIN inválido (mínimo 4 dígitos)' });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const { error } = await supabaseAdmin
      .from('usuarios')
      .update({ pin_retiro_hash: pinHash })
      .eq('id', userId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ message: 'PIN de retiro configurado correctamente' });

  } catch (err) {
    console.error('Set PIN error:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
