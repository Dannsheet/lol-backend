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

    const { data: userRow, error: userErr } = await supabaseAdmin
      .from("usuarios")
      .select("saldo_ganancias")
      .eq("id", userId)
      .maybeSingle();

    if (cuentaError) throw cuentaError;
    if (userErr) throw userErr;

    const balance = cuenta?.balance ?? null;
    const saldoGanancias = userRow?.saldo_ganancias ?? null;

    let totalGanado = null;
    let ganadoReferidos = null;
    let ganadoVideos = null;
    let totalGanadoSource = 'fallback';
    let totalGanadoError = null;
    try {
      const [{ data: refRows, error: refErr }, { data: videoRows, error: videoErr }] = await Promise.all([
        supabaseAdmin
          .from('balance_movimientos')
          .select('monto')
          .eq('usuario_id', userId)
          .ilike('tipo', 'comision_%')
          .gt('monto', 0)
          .limit(10_000),
        supabaseAdmin
          .from('movimientos')
          .select('monto')
          .eq('usuario_id', userId)
          .gt('monto', 0)
          .ilike('descripcion', '%recompensa por ver video%')
          .limit(10_000),
      ]);

      if (refErr) throw refErr;
      if (videoErr) throw videoErr;

      const refList = Array.isArray(refRows) ? refRows : [];
      const videoList = Array.isArray(videoRows) ? videoRows : [];

      const refSum = refList.reduce((acc, r) => acc + (Number(r?.monto) || 0), 0);
      const videoSum = videoList.reduce((acc, r) => acc + (Number(r?.monto) || 0), 0);

      ganadoReferidos = Number.isFinite(refSum) ? refSum : 0;
      ganadoVideos = Number.isFinite(videoSum) ? videoSum : 0;

      const computed = ganadoReferidos + ganadoVideos;
      totalGanado = Number.isFinite(computed) ? computed : null;
      totalGanadoSource = 'computed';
    } catch (e) {
      totalGanado = cuenta?.total_ganado ?? null;
      ganadoReferidos = null;
      ganadoVideos = null;
      totalGanadoSource = 'fallback';
      totalGanadoError = e?.message ? String(e.message) : String(e || 'unknown error');
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
      saldo_ganancias: saldoGanancias,
      total_ganado: totalGanado,
      ganado_referidos: ganadoReferidos,
      ganado_videos: ganadoVideos,
      total_ganado_source: totalGanadoSource,
      total_ganado_error: totalGanadoError,
      movimientos_recientes: movimientosRecientes,
    });
  } catch (error) {
    console.error("❌ Error en GET /cuenta/info:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
