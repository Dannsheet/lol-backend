import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

router.get("/suscripcion/mi-plan", authMiddleware, async (req, res) => {
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

router.get("/suscripcion/mis-planes", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const nowSql = new Date().toISOString().slice(0, 19).replace("T", " ");

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan_id, expires_at, is_active, created_at")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    const rawRows = Array.isArray(data) ? data : [];
    const rows = rawRows.filter((r) => {
      const expiresAt = r?.expires_at != null ? String(r.expires_at) : "";
      if (!expiresAt) return true;
      return expiresAt >= nowSql;
    });

    const planIds = [...new Set(rows.map((r) => Number(r?.plan_id)).filter((id) => Number.isFinite(id)))];
    if (!planIds.length) {
      return res.json({ ok: true, planes: [] });
    }

    const { data: plans, error: planError } = await supabaseAdmin
      .from("planes")
      .select("*")
      .in("id", planIds);

    if (planError) throw planError;

    const byId = new Map((Array.isArray(plans) ? plans : []).map((p) => [Number(p?.id), p]));

    return res.json({
      ok: true,
      planes: rows
        .map((row) => {
          const p = byId.get(Number(row?.plan_id));
          if (!p) return null;
          return {
            subscription_id: row.id,
            plan_id: p.id,
            nombre: p.nombre ?? p.name ?? null,
            limite_tareas: p.limite_tareas ?? null,
            ganancia_diaria: p.ganancia_diaria ?? null,
            expira_en: row.expires_at,
            created_at: row.created_at,
          };
        })
        .filter(Boolean),
    });
  } catch (error) {
    console.error("❌ Error en GET /suscripcion/mis-planes:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
