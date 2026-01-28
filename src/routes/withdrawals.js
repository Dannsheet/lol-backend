import express from "express";
import bcrypt from "bcrypt";
import { supabaseAdmin } from "../services/supabase.service.js";
import { authMiddleware } from "../middlewares/auth.js";

const router = express.Router();

const isAdminUser = (userId) => {
  const raw = String(process.env.ADMIN_USER_IDS || '').trim();
  if (!raw) return false;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(String(userId || '').trim());
};

const validateAddressByNetwork = (red, direccion) => {
  const net = String(red || '').trim().toUpperCase();
  const addr = String(direccion || '').trim();
  if (!addr) return 'Dirección inválida';

  const evmNets = ['BEP20-USDT', 'ETH-USDT', 'POLYGON-USDT', 'BEP20', 'ETH', 'POLYGON'];
  if (evmNets.some((n) => net.includes(n))) {
    if (!/^0x[a-f0-9]{40}$/i.test(addr)) return 'Dirección inválida para la red seleccionada';
    return '';
  }

  if (net.includes('TRC20')) {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return 'Dirección inválida para la red seleccionada';
    return '';
  }

  return '';
};

/**
 * ===========================================
 * 1) VALIDAR DATOS DEL RETIRO
 * ===========================================
 */
router.post("/withdraw/validate", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { monto, red, pin } = req.body;

    if (!userId) return res.status(401).json({ error: "No autenticado" });
    if (!monto || !red || !pin)
      return res.status(400).json({ error: "Faltan parámetros" });

    const montoNum = Number(monto);
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    // 1. Obtener usuario completo
    const { data: usuario, error: usuarioError } = await supabaseAdmin
      .from("usuarios")
      .select("pin_retiro_hash, pin_intentos, pin_bloqueado_hasta")
      .eq("id", userId)
      .single();

    if (usuarioError) {
      console.error("❌ Error consultando usuario:", usuarioError);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });
    if (!usuario.pin_retiro_hash)
      return res.status(403).json({ error: "PIN de retiro no configurado" });

    // 2. Si está bloqueado temporalmente
    const ahora = new Date();

    if (
      usuario.pin_bloqueado_hasta &&
      new Date(usuario.pin_bloqueado_hasta) > ahora
    ) {
      const minutos = Math.ceil(
        (new Date(usuario.pin_bloqueado_hasta) - ahora) / 60000
      );

      return res.status(403).json({
        error: "PIN bloqueado temporalmente",
        desbloqueo_en_minutos: minutos,
      });
    }

    // 3. Validar PIN con hash
    const pinCorrecto = await bcrypt.compare(String(pin), usuario.pin_retiro_hash);

    if (!pinCorrecto) {
      const intentosActuales = Number(usuario.pin_intentos ?? 0);
      const nuevosIntentos = intentosActuales + 1;

      // Si excede límite (3 fallos)
      if (nuevosIntentos >= 3) {
        const bloqueoMin = 10;
        const desbloqueo = new Date(Date.now() + bloqueoMin * 60000);

        const { error: bloqueoError } = await supabaseAdmin
          .from("usuarios")
          .update({
            pin_intentos: 0,
            pin_bloqueado_hasta: desbloqueo.toISOString(),
          })
          .eq("id", userId);

        if (bloqueoError) {
          console.error("❌ Error bloqueando PIN:", bloqueoError);
          return res.status(500).json({ error: "Error interno del servidor" });
        }

        return res.status(403).json({
          error: "PIN incorrecto. Usuario bloqueado temporalmente.",
          bloqueo_minutos: bloqueoMin,
        });
      }

      // Registrar intento fallido
      const { error: intentosError } = await supabaseAdmin
        .from("usuarios")
        .update({ pin_intentos: nuevosIntentos })
        .eq("id", userId);

      if (intentosError) {
        console.error("❌ Error actualizando intentos PIN:", intentosError);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      return res.status(401).json({
        error: "PIN incorrecto",
        intentos_restantes: 3 - nuevosIntentos,
      });
    }

    // 4. PIN correcto → resetear intentos
    const { error: resetError } = await supabaseAdmin
      .from("usuarios")
      .update({
        pin_intentos: 0,
        pin_bloqueado_hasta: null,
      })
      .eq("id", userId);

    if (resetError) {
      console.error("❌ Error reseteando intentos PIN:", resetError);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    // 2. Comisiones
    const fees = {
      "BEP20-USDT": 1,
      "TRC20-USDT": 1,
      "ETH-USDT": 8,
      "POLYGON-USDT": 0.5,
    };

    const fee = fees[red] ?? null;
    if (!fee) return res.status(400).json({ error: "Red no soportada" });

    const total = Number(montoNum);
    const neto = Number(montoNum) - Number(fee);

    if (!Number.isFinite(neto) || neto <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    if (neto < 10) {
      return res.status(400).json({
        error: `El retiro mínimo es 10 USDT (después de comisión). Debes ingresar mínimo ${(10 + Number(fee)).toFixed(2)} USDT`,
        minimo_neto: 10,
        minimo_total: 10 + Number(fee),
        fee,
      });
    }

    // 3. Verificar saldo
    const { data: usuarioSaldo, error: saldoErr } = await supabaseAdmin
      .from("usuarios")
      .select("saldo_interno")
      .eq("id", userId)
      .maybeSingle();

    if (saldoErr) throw saldoErr;
    if (!usuarioSaldo) return res.status(404).json({ error: "Usuario no encontrado" });
    const disponible = Number(usuarioSaldo?.saldo_interno ?? 0);

    if (!Number.isFinite(disponible) || disponible < total)
      return res.status(400).json({
        error: "Saldo insuficiente",
        disponible,
        requerido: total,
      });

    // 4. Verificar retiro activo
    const { data: pendiente } = await supabaseAdmin
      .from("retiros")
      .select("id")
      .eq("usuario_id", userId)
      .in("estado", ["pendiente", "aprobado", "enviado"])
      .maybeSingle();

    if (pendiente)
      return res.status(400).json({ error: "Ya tienes un retiro pendiente" });

    return res.json({
      ok: true,
      message: "Retiro validado correctamente",
      monto: neto,
      fee,
      total,
      red,
    });
  } catch (error) {
    console.error("❌ Error en /withdraw/validate:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/**
 * ===========================================
 * 2) CREAR SOLICITUD DE RETIRO
 * ===========================================
 */
router.post("/withdraw/create", authMiddleware, async (req, res) => {
  try {
    console.log("🔥 BODY RECIBIDO:", req.body);
    const userId = req.user?.id;
    const { monto, red, direccion } = req.body;

    if (!userId) return res.status(401).json({ error: "No autenticado" });

    const montoNum = Number(monto);
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    const addrErr = validateAddressByNetwork(red, direccion);
    if (addrErr) return res.status(400).json({ error: addrErr });

    const normalizedDireccion = (() => {
      const rawNet = String(red || '').trim().toUpperCase();
      const rawAddr = String(direccion || '').trim();
      const evmNets = ['BEP20-USDT', 'ETH-USDT', 'POLYGON-USDT', 'BEP20', 'ETH', 'POLYGON'];
      if (evmNets.some((n) => rawNet.includes(n)) && /^0x[a-f0-9]{40}$/i.test(rawAddr)) {
        if (rawAddr.startsWith('0X')) return `0x${rawAddr.slice(2)}`;
      }
      return rawAddr;
    })();

    const fees = {
      "BEP20-USDT": 1,
      "TRC20-USDT": 1,
      "ETH-USDT": 8,
      "POLYGON-USDT": 0.5,
    };

    const fee = fees[red] ?? null;
    if (!fee) return res.status(400).json({ error: "Red no soportada" });

    const total = Number(montoNum);
    const neto = Number(montoNum) - Number(fee);

    if (!Number.isFinite(neto) || neto <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    if (neto < 10) {
      return res.status(400).json({
        error: `El retiro mínimo es 10 USDT (después de comisión). Debes ingresar mínimo ${(10 + Number(fee)).toFixed(2)} USDT`,
        minimo_neto: 10,
        minimo_total: 10 + Number(fee),
        fee,
      });
    }

    // Evitar múltiples retiros activos incluso si llaman /create directo
    const { data: active } = await supabaseAdmin
      .from("retiros")
      .select("id")
      .eq("usuario_id", userId)
      .in("estado", ["pendiente", "aprobado", "enviado"])
      .maybeSingle();

    if (active) {
      return res.status(400).json({ error: "Ya tienes un retiro pendiente" });
    }

    // restar saldo mediante RPC (fallback a increment_user_balance)
    let saldoError = null;
    {
      const { error } = await supabaseAdmin.rpc("restar_balance", {
        p_user_id: userId,
        p_cantidad: total,
      });
      saldoError = error ?? null;
    }

    if (saldoError && String(saldoError.code ?? "") === "PGRST202") {
      const { error } = await supabaseAdmin.rpc("increment_user_balance", {
        userid: userId,
        amountdelta: -Number(total),
      });
      saldoError = error ?? null;
    }

    if (saldoError) {
      return res.status(400).json({ error: saldoError.message || "Saldo insuficiente o error RPC" });
    }

    // crear registro en retiros
    const { data: retiro, error: retiroError } = await supabaseAdmin
      .from("retiros")
      .insert({
        usuario_id: userId,
        monto: neto,
        red,
        direccion: normalizedDireccion,
        fee,
        total,
        estado: "pendiente",
      })
      .select()
      .single();

    if (retiroError) {
      console.error("❌ SUPABASE INSERT ERROR:", retiroError);

      // best-effort rollback (requiere RPC sumar_balance)
      try {
        let refundError = null;
        {
          const { error } = await supabaseAdmin.rpc("sumar_balance", { p_user_id: userId, p_cantidad: total });
          refundError = error ?? null;
        }
        if (refundError && String(refundError.code ?? "") === "PGRST202") {
          await supabaseAdmin.rpc("increment_user_balance", {
            userid: userId,
            amountdelta: Number(total),
          });
        }
      } catch {
        // ignore
      }

      return res.status(400).json({ error: retiroError.message });
    }

    // Registrar movimiento visible para el usuario
    try {
      await supabaseAdmin.from("movimientos").insert({
        usuario_id: userId,
        tipo: "retiro",
        monto: -Number(total),
        descripcion: "Retiro pendiente",
      });
    } catch {
      // ignore
    }

    return res.json({
      ok: true,
      message: "Solicitud de retiro creada",
      retiro,
    });
  } catch (error) {
    console.error("❌ Error en /withdraw/create:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/**
 * ===========================================
 * 3) LISTAR RETIROS PENDIENTES (ADMIN)
 * ===========================================
 */
router.get("/withdraw/pending", authMiddleware, async (req, res) => {
  try {
    if (!isAdminUser(req.user?.id)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { data, error } = await supabaseAdmin
      .from("retiros")
      .select("id, usuario_id, monto, red, direccion, estado, tx_hash")
      .eq("estado", "pendiente");

    if (error) return res.status(400).json({ error });

    return res.json(data);
  } catch (error) {
    console.error("❌ Error en /withdraw/pending:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/**
 * ===========================================
 * 4) CONFIRMAR RETIRO
 * ===========================================
 */
router.post("/withdraw/confirm", authMiddleware, async (req, res) => {
  try {
    if (!isAdminUser(req.user?.id)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id, tx_hash } = req.body;

    if (!id) return res.status(400).json({ error: "Falta ID del retiro" });
    if (!tx_hash) return res.status(400).json({ error: "Falta tx_hash" });

    const { data, error } = await supabaseAdmin
      .from("retiros")
      .update({
        estado: "confirmado",
        tx_hash,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ error });

    return res.json({
      ok: true,
      message: "Retiro confirmado",
      retiro: data,
    });
  } catch (error) {
    console.error("❌ Error en /withdraw/confirm:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
