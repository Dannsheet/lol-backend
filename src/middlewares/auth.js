import { supabase } from '../config/supabase.js'
import { supabaseAdmin } from '../services/supabase.service.js'
import { linkReferral } from '../services/referrals.service.js'
import crypto from 'crypto'

async function ensureUsuarioRow({ id, email }) {
  if (!id) return

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('usuarios')
    .select('id, invite_code')
    .eq('id', id)
    .maybeSingle()

  if (existingErr) {
    throw existingErr
  }

  const generateInviteCode = () => crypto.randomBytes(4).toString('hex').toUpperCase()

  const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim() : null
  let insertEmail = normalizedEmail
  if (insertEmail) {
    const { data: existingByEmail, error: existingByEmailErr } = await supabaseAdmin
      .from('usuarios')
      .select('id')
      .eq('email', insertEmail)
      .maybeSingle()

    if (existingByEmailErr) throw existingByEmailErr
    if (existingByEmail?.id && String(existingByEmail.id) !== String(id)) {
      insertEmail = null
    }
  }

  if (!existing?.id) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const invite_code = generateInviteCode()
      const { error: insertErr } = await supabaseAdmin.from('usuarios').insert({
        id,
        email: insertEmail,
        invite_code,
      })

      if (!insertErr) return

      const code = String(insertErr.code ?? '')
      const msg = String(insertErr.message ?? '').toLowerCase()
      const isUniqueViolation = code === '23505' || msg.includes('duplicate') || msg.includes('unique')
      if (!isUniqueViolation) throw insertErr
    }

    throw new Error('No se pudo generar un invite_code único')
  }

  if (!existing.invite_code) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const invite_code = generateInviteCode()
      const { error: updateErr } = await supabaseAdmin
        .from('usuarios')
        .update({ invite_code })
        .eq('id', id)
        .is('invite_code', null)

      if (!updateErr) return

      const code = String(updateErr.code ?? '')
      const msg = String(updateErr.message ?? '').toLowerCase()
      const isUniqueViolation = code === '23505' || msg.includes('duplicate') || msg.includes('unique')
      if (!isUniqueViolation) throw updateErr
    }

    throw new Error('No se pudo asignar un invite_code único')
  }

  if (normalizedEmail && !insertEmail) {
    const { error: updateEmailErr } = await supabaseAdmin
      .from('usuarios')
      .update({ email: normalizedEmail })
      .eq('id', id)
      .is('email', null)

    if (updateEmailErr) {
      const code = String(updateEmailErr.code ?? '')
      const msg = String(updateEmailErr.message ?? '').toLowerCase()
      const isUniqueViolation = code === '23505' || msg.includes('duplicate') || msg.includes('unique')
      if (!isUniqueViolation) throw updateEmailErr
    }
  }
}

export async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader) {
      return res.status(401).json({ error: 'Falta Authorization header' })
    }

    const token = authHeader.replace('Bearer ', '')

    const { data, error } = await supabase.auth.getUser(token)

    if (error || !data?.user) {
      return res.status(401).json({ error: 'Token inválido o expirado' })
    }

    // Usuario autenticado
    req.user = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.role, // puede servir luego
      access_token: token
    }

    await ensureUsuarioRow({ id: req.user.id, email: req.user.email })

    try {
      const md = data?.user?.user_metadata || {}
      const rawInvite =
        md.invitation_code ||
        md.invite_code ||
        md.ref_code ||
        md.referral_code ||
        md.codigo_invitacion ||
        null
      const code = typeof rawInvite === 'string' ? rawInvite.trim() : ''
      if (code) {
        await linkReferral({ userId: req.user.id, invite_code: code })
      }
    } catch {
      // ignore
    }

    next()
  } catch (err) {
    console.error('Auth error:', err)
    return res.status(401).json({ error: 'Error de autenticación' })
  }
}
