import express from "express";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middlewares/auth.js";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

async function getActivePlanForUser(userId) {
  const nowIso = new Date().toISOString().slice(0, 19);

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, user_id, plan_id, is_active, expires_at, planes(*)")
    .eq("user_id", userId)
    .eq("is_active", true)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  return row?.planes ? { subscription: row, plan: row.planes } : null;
}

router.get("/videos/status", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const active = await getActivePlanForUser(userId);
    if (!active) {
      return res.json({
        puede_ver: false,
        videos_vistos_hoy: 0,
        limite_diario: 0,
        recompensa: 0,
      });
    }

    const plan = active.plan;

    const limiteDiario = 1;
    const recompensa = plan?.ganancia_diaria ?? plan?.recompensa ?? 0;

    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
    );
    const startOfNextDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
    );

    const { count, error: countError } = await supabaseAdmin
      .from("videos_vistos")
      .select("id", { count: "exact", head: true })
      .eq("usuario_id", userId)
      .gte("visto_en", startOfDay.toISOString())
      .lt("visto_en", startOfNextDay.toISOString());

    if (countError) throw countError;

    const vistosHoy = Number(count ?? 0);

    return res.json({
      puede_ver: vistosHoy < limiteDiario,
      videos_vistos_hoy: vistosHoy,
      limite_diario: limiteDiario,
      recompensa,
    });
  } catch (error) {
    console.error("❌ Error en GET /videos/status:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.post("/videos/ver", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { video_id, calificacion } = req.body ?? {};

    if (!video_id) return res.status(400).json({ error: "Falta video_id" });

    const active = await getActivePlanForUser(userId);
    if (!active) {
      return res.status(403).json({ error: "Usuario sin suscripción activa" });
    }

    const token = req.user?.access_token;
    if (!token) {
      return res.status(401).json({ error: "Usuario no autenticado" });
    }

    const supabaseKey =
      process.env.SUPABASE_ANON_KEY ??
      process.env.SUPABASE_PUBLIC_ANON_KEY ??
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!process.env.SUPABASE_URL || !supabaseKey) {
      return res.status(500).json({ error: "Configuración Supabase incompleta" });
    }

    const supabaseUser = createClient(
      process.env.SUPABASE_URL,
      supabaseKey,
      {
        auth: { persistSession: false },
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      }
    );

    const { error: rpcError } = await supabaseUser.rpc("registrar_video_visto", {
      p_video_id: video_id,
      p_calificacion: calificacion ?? null,
    });

    if (rpcError) {
      const msg = String(rpcError.message ?? "");
      const lower = msg.toLowerCase();
      const code = String(rpcError.code ?? "");

      if (code === "23505") {
        return res.status(422).json({ error: "Video ya fue visto" });
      }

      if (lower.includes("usuario no autenticado")) {
        return res.status(401).json({ error: "Usuario no autenticado" });
      }

      if (lower.includes("usuario sin suscripción activa") || lower.includes("usuario sin suscripcion activa")) {
        return res.status(403).json({ error: "Usuario sin suscripción activa" });
      }

      if (lower.includes("límite diario") || lower.includes("limite diario")) {
        return res.status(422).json({ error: "Límite diario alcanzado" });
      }
      if (lower.includes("ya fue visto") || lower.includes("video repetido")) {
        return res.status(422).json({ error: "Video ya fue visto" });
      }

      if (
        lower.includes("relation") &&
        (lower.includes("suscripciones") || lower.includes("calificacion") || lower.includes("created_at"))
      ) {
        return res
          .status(500)
          .json({ error: "RPC registrar_video_visto desalineada con las tablas actuales" });
      }

      throw rpcError;
    }

    const monto = active?.plan?.ganancia_diaria ?? null;
    return res.json({ ok: true, monto });
  } catch (error) {
    console.error("❌ Error en POST /videos/ver:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
