import express from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { supabaseAdmin } from '../services/supabase.service.js'
import {
  deriveChildAddress,
  getNextDerivationIndex,
} from '../services/hdwallet.service.js'

const router = express.Router()

router.post('/wallet/create', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data: existing, error: existingError } = await supabaseAdmin
      .from('user_wallets')
      .select('id, user_id, deposit_address, unique_tag, network')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) {
      return res.status(400).json({ error: existingError.message })
    }

    if (existing) {
      return res.json({
        message: 'Dirección ya existe',
        wallet: existing,
      })
    }

    const network = process.env.DEPOSIT_NETWORK ?? 'BEP20-USDT'

    for (let attempt = 0; attempt < 5; attempt++) {
      const nextIndex = await getNextDerivationIndex(supabaseAdmin)
      const { address, index } = deriveChildAddress(nextIndex)

      const { data, error } = await supabaseAdmin
        .from('user_wallets')
        .insert({
          user_id: userId,
          deposit_address: address,
          unique_tag: String(index),
          network,
        })
        .select('id, user_id, deposit_address, unique_tag, network')
        .single()

      if (!error) {
        return res.json({
          message: 'Dirección generada exitosamente',
          wallet: data,
        })
      }

      const code = String(error.code ?? '')
      if (code === '23505') continue
      return res.status(500).json({ error: error.message })
    }

    return res.status(500).json({ error: 'No se pudo generar dirección' })
  } catch (error) {
    console.error('❌ Error en POST /wallet/create:', error)
    return res.status(500).json({ error: 'Error interno del servidor' })
  }
})

router.get('/wallet/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data, error } = await supabaseAdmin
      .from('movimientos')
      .select('id, usuario_id, monto, creado_en, tipo, descripcion')
      .eq('usuario_id', userId)
      .order('creado_en', { ascending: false })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    return res.json(data)
  } catch (error) {
    console.error('❌ Error en /wallet/history:', error)
    return res.status(500).json({ error: 'Error interno del servidor' })
  }
})

export default router
