import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

router.get("/suscripcion/mi-plan", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const nowIso = new Date().toISOString().slice(0, 19);

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan_id, expires_at, is_active")
      .eq("user_id", userId)
      .eq("is_active", true)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : null;
    const planId = row?.plan_id != null ? Number(row.plan_id) : null;
    if (!row?.id || !Number.isFinite(planId)) {
      return res.json({ plan_activo: false });
    }

    const { data: plan, error: planError } = await supabaseAdmin
      .from("planes")
      .select("*")
      .eq("id", planId)
      .maybeSingle();

    if (planError) throw planError;
    if (!plan) {
      return res.json({ plan_activo: false });
    }

    return res.json({
      plan_activo: true,
      plan_id: plan.id,
      nombre: plan.nombre ?? plan.name ?? null,
      limite_tareas: plan.limite_tareas ?? null,
      ganancia_diaria: plan.ganancia_diaria ?? null,
      expira_en: row.expires_at,
    });
  } catch (error) {
    console.error("❌ Error en GET /suscripcion/mi-plan:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
