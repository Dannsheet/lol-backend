import express from 'express';
import { supabaseAdmin } from '../services/supabase.service.js';

const router = express.Router();

router.post('/tatum', async (req, res) => {
  try {
    const expected = String(process.env.TATUM_WEBHOOK_SECRET || '').trim();
    if (expected) {
      const got = String(req.headers['x-webhook-secret'] || '').trim();
      if (!got || got !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { txId } = req.body;

    if (!txId || txId === 'null') {
      console.log('⛔ Webhook ignorado: txId inválido');
      return res.json({ ok: true });
    }

    console.log('🔔 Webhook Tatum recibido:', txId);

    const { data: retiro } = await supabaseAdmin
      .from('retiros')
      .select('*')
      .eq('tx_hash', txId)
      .maybeSingle();

    if (!retiro) {
      console.log('⏭️ No existe retiro con ese tx_hash');
      return res.json({ ok: true });
    }

    if (retiro.estado === 'confirmado') {
      return res.json({ ok: true });
    }

    if (!['enviado', 'aprobado'].includes(String(retiro.estado || '').toLowerCase())) {
      return res.json({ ok: true });
    }

    await supabaseAdmin
      .from('retiros')
      .update({
        estado: 'confirmado',
        confirmado_en: new Date().toISOString()
      })
      .eq('id', retiro.id);

    console.log('✅ Retiro confirmado:', retiro.id);
    res.json({ ok: true });

  } catch (err) {
    console.error('❌ Webhook error', err);
    res.status(500).json({ error: 'Webhook error' });
  }
});


export default router;
