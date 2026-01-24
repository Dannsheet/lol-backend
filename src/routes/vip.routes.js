import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { buyVipController, createVipIntentController } from "../controllers/vip.controller.js";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

router.get("/current", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const nowSql = new Date().toISOString().slice(0, 19).replace("T", " ");

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan_id, expires_at, is_active")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const row = rows.find((r) => {
      const expiresAt = r?.expires_at != null ? String(r.expires_at) : "";
      if (!expiresAt) return true;
      return expiresAt >= nowSql;
    });
    const planId = row?.plan_id != null ? Number(row.plan_id) : null;
    if (!row?.id || !Number.isFinite(planId)) {
      return res.json({ is_active: false });
    }

    const { data: plan, error: planError } = await supabaseAdmin
      .from("planes")
      .select("*")
      .eq("id", planId)
      .maybeSingle();

    if (planError) throw planError;
    if (!plan) {
      return res.json({ is_active: false });
    }

    return res.json({
      is_active: true,
      expires_at: row.expires_at,
      plan: {
        id: plan.id,
        nombre: plan.nombre ?? plan.name ?? null,
        porcentaje: plan.porcentaje ?? plan.porcentaje_ganancia ?? null,
        limite_tareas: plan.limite_tareas ?? null,
        ganancia_diaria: plan.ganancia_diaria ?? null,
      },
    });
  } catch (err) {
    console.error("❌ Error en GET /vip/current:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

router.post("/activate", authMiddleware, buyVipController);

router.post("/buy", authMiddleware, buyVipController);

router.post("/intent", authMiddleware, createVipIntentController);

export default router;
