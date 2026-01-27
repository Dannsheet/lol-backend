import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

router.get("/user/balance", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: cuenta, error } = await supabaseAdmin
      .from("cuentas")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    const bal = Number(cuenta?.balance ?? 0);
    return res.json({ saldo_interno: Number.isFinite(bal) ? bal : 0 });
  } catch (error) {
    console.error("❌ Error en GET /user/balance:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.get("/balance/movements", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: movimientosVideo, error: movVideoError } = await supabaseAdmin
      .from("movimientos")
      .select("id, tipo, monto, creado_en, descripcion")
      .eq("usuario_id", userId)
      .order("creado_en", { ascending: false })
      .limit(50);

    if (movVideoError) throw movVideoError;

    const { data: movimientosBalance, error: movBalanceError } = await supabaseAdmin
      .from("balance_movimientos")
      .select("id, tipo, monto, creado_en, referencia_id, referencia_tipo")
      .eq("usuario_id", userId)
      .order("creado_en", { ascending: false })
      .limit(50);

    if (movBalanceError) throw movBalanceError;

    const merged = [];

    for (const m of movimientosVideo ?? []) {
      merged.push({
        id: m.id,
        tipo: m.tipo,
        monto: m.monto,
        creado_en: m.creado_en,
        descripcion: m.descripcion ?? null,
        referencia_id: null,
        referencia_tipo: null,
      });
    }

    for (const m of movimientosBalance ?? []) {
      merged.push({
        id: m.id,
        tipo: m.tipo,
        monto: m.monto,
        creado_en: m.creado_en,
        descripcion: null,
        referencia_id: m.referencia_id ?? null,
        referencia_tipo: m.referencia_tipo ?? null,
      });
    }

    merged.sort((a, b) => {
      const at = new Date(a.creado_en ?? 0).getTime();
      const bt = new Date(b.creado_en ?? 0).getTime();
      return bt - at;
    });

    return res.json(merged.slice(0, 50));
  } catch (error) {
    console.error("❌ Error en GET /balance/movements:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.get("/cuenta/info", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: cuenta, error: cuentaError } = await supabaseAdmin
      .from("cuentas")
      .select("balance, total_ganado")
      .eq("user_id", userId)
      .maybeSingle();

    if (cuentaError) throw cuentaError;

    const balance = cuenta?.balance ?? null;

    let totalGanado = null;
    try {
      const [{ data: refAgg, error: refErr }, { data: videoAgg, error: videoErr }] = await Promise.all([
        supabaseAdmin
          .from('balance_movimientos')
          .select('monto.sum()')
          .eq('usuario_id', userId)
          .gt('monto', 0),
        supabaseAdmin
          .from('movimientos')
          .select('monto.sum()')
          .eq('usuario_id', userId)
          .gt('monto', 0)
          .ilike('descripcion', '%recompensa por ver video%'),
      ]);

      if (refErr) throw refErr;
      if (videoErr) throw videoErr;

      const refSum = Number(refAgg?.[0]?.sum ?? 0);
      const videoSum = Number(videoAgg?.[0]?.sum ?? 0);
      const computed = (Number.isFinite(refSum) ? refSum : 0) + (Number.isFinite(videoSum) ? videoSum : 0);
      totalGanado = Number.isFinite(computed) ? computed : null;
    } catch {
      totalGanado = cuenta?.total_ganado ?? null;
    }

    const { data: movimientosVideo, error: movVideoError } = await supabaseAdmin
      .from("movimientos")
      .select("id, tipo, monto, creado_en, descripcion")
      .eq("usuario_id", userId)
      .order("creado_en", { ascending: false })
      .limit(20);

    if (movVideoError) throw movVideoError;

    const { data: movimientosBalance, error: movBalanceError } = await supabaseAdmin
      .from("balance_movimientos")
      .select("id, tipo, monto, creado_en, referencia_id, referencia_tipo")
      .eq("usuario_id", userId)
      .order("creado_en", { ascending: false })
      .limit(20);

    if (movBalanceError) throw movBalanceError;

    const merged = [];

    for (const m of movimientosVideo ?? []) {
      merged.push({
        id: m.id,
        tipo: m.tipo,
        monto: m.monto,
        creado_en: m.creado_en,
        descripcion: m.descripcion ?? null,
        referencia_id: null,
        referencia_tipo: null,
      });
    }

    for (const m of movimientosBalance ?? []) {
      merged.push({
        id: m.id,
        tipo: m.tipo,
        monto: m.monto,
        creado_en: m.creado_en,
        descripcion: null,
        referencia_id: m.referencia_id ?? null,
        referencia_tipo: m.referencia_tipo ?? null,
      });
    }

    merged.sort((a, b) => {
      const at = new Date(a.creado_en ?? 0).getTime();
      const bt = new Date(b.creado_en ?? 0).getTime();
      return bt - at;
    });

    const movimientosRecientes = merged.slice(0, 20);

    return res.json({
      balance,
      total_ganado: totalGanado,
      movimientos_recientes: movimientosRecientes,
    });
  } catch (error) {
    console.error("❌ Error en GET /cuenta/info:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
