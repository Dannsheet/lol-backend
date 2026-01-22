import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { buyVipController, createVipIntentController } from "../controllers/vip.controller.js";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

router.get("/current", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const nowIso = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan_id, expires_at, is_active, planes(*)")
      .eq("user_id", userId)
      .eq("is_active", true)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : null;
    if (!row?.planes) {
      return res.json({ is_active: false });
    }

    const plan = row.planes;

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
