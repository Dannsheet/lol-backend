import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middlewares/auth.js";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

async function getActivePlansForUser(userId) {
  const nowSql = new Date().toISOString().slice(0, 19).replace("T", " ");

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, user_id, plan_id, is_active, expires_at, created_at")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw error;

  const rawRows = Array.isArray(data) ? data : [];
  const rows = rawRows.filter((r) => {
    const expiresAt = r?.expires_at != null ? String(r.expires_at) : "";
    if (!expiresAt) return true;
    return expiresAt >= nowSql;
  });

  // Regla: 1 video por PLAN cada 24h. Si un usuario compra el mismo plan 2 veces,
  // sigue contando como 1 plan para videos. Por eso deduplicamos por plan_id.
  const bestByPlan = new Map();
  for (const r of rows) {
    const pid = Number(r?.plan_id);
    if (!Number.isFinite(pid)) continue;
    if (!bestByPlan.has(pid)) bestByPlan.set(pid, r);
  }

  const uniqueRows = Array.from(bestByPlan.values());
  const planIds = [...new Set(uniqueRows.map((r) => Number(r?.plan_id)).filter((id) => Number.isFinite(id)))];
  if (!planIds.length) return [];

  const { data: plans, error: plansError } = await supabaseAdmin
    .from("planes")
    .select("*")
    .in("id", planIds);

  if (plansError) throw plansError;

  const byId = new Map((Array.isArray(plans) ? plans : []).map((p) => [Number(p?.id), p]));
  return uniqueRows
    .map((row) => ({
      ...row,
      planes: byId.get(Number(row?.plan_id)) ?? null,
    }))
    .filter((row) => Boolean(row?.planes));
}

router.get("/videos/status", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const active = await getActivePlansForUser(userId);
    if (!active.length) {
      return res.json({
        puede_ver: false,
        videos_vistos_hoy: 0,
        limite_diario: 0,
        recompensa: 0,
        planes: [],
      });
    }

    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const planes = [];
    for (const row of active) {
      const plan = row?.planes;
      const planId = row?.plan_id;

      const limiteDiario = 1;

      const seedHex = crypto
        .createHash("sha256")
        .update(`${userId}:${dateKey}:${planId}`)
        .digest("hex")
        .slice(0, 12);
      const dailySeed = Number.parseInt(seedHex, 16);

      const { data: recentViews, error: viewsError } = await supabaseAdmin
        .from("videos_vistos")
        .select("visto_en")
        .eq("usuario_id", userId)
        .eq("plan_id", planId)
        .gte("visto_en", windowStart.toISOString())
        .order("visto_en", { ascending: false })
        .limit(Math.max(1, limiteDiario));

      if (viewsError) throw viewsError;

      const rows = Array.isArray(recentViews) ? recentViews : [];
      const vistosHoy = rows.length;

      let nextAvailableAt = null;
      let puedeVer = vistosHoy < limiteDiario;

      if (!puedeVer && rows.length) {
        const earliestIso = rows[rows.length - 1]?.visto_en ? String(rows[rows.length - 1].visto_en) : "";
        const earliest = earliestIso ? new Date(earliestIso) : null;
        const next = earliest && Number.isFinite(earliest.getTime())
          ? new Date(earliest.getTime() + 24 * 60 * 60 * 1000)
          : null;
        if (next && Number.isFinite(next.getTime())) {
          nextAvailableAt = next.toISOString();
          if (now.getTime() >= next.getTime()) {
            puedeVer = true;
          }
        }
      }

      planes.push({
        plan_id: planId,
        puede_ver: puedeVer,
        videos_vistos_hoy: vistosHoy,
        limite_diario: limiteDiario,
        recompensa: plan?.ganancia_diaria ?? plan?.recompensa ?? 0,
        date_key: dateKey,
        daily_seed: Number.isFinite(dailySeed) ? dailySeed : null,
        next_available_at: nextAvailableAt,
      });
    }

    const first = planes[0] || {};

    const anyCan = planes.some((p) => Boolean(p?.puede_ver));

    return res.json({
      puede_ver: Boolean(anyCan),
      videos_vistos_hoy: Number(first?.videos_vistos_hoy ?? 0),
      limite_diario: Number(first?.limite_diario ?? 0),
      recompensa: Number(first?.recompensa ?? 0),
      date_key: dateKey,
      daily_seed: first?.daily_seed ?? null,
      next_available_at: first?.next_available_at ?? null,
      planes,
    });
  } catch (error) {
    console.error("❌ Error en GET /videos/status:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.post("/videos/ver", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { video_id, videoId, calificacion, plan_id } = req.body ?? {};
    const resolvedVideoId = video_id ?? videoId;

    if (!resolvedVideoId) return res.status(400).json({ error: "Falta video_id" });

    const active = await getActivePlansForUser(userId);
    if (!active.length) {
      return res.status(403).json({ error: "Usuario sin suscripción activa" });
    }

    const chosenPlanId = plan_id != null ? Number(plan_id) : null;
    if (chosenPlanId != null && !active.some((r) => Number(r?.plan_id) === chosenPlanId)) {
      return res.status(403).json({ error: "Plan no activo" });
    }

    // Enforce 24h exactas (rolling window) antes del RPC.
    let planIdToUse = chosenPlanId;
    {
      const now = new Date();
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const candidates = chosenPlanId != null ? active.filter((r) => Number(r?.plan_id) === chosenPlanId) : active;

      let canWatchAny = false;
      let nextAvailableAt = null;
      let firstEligiblePlanId = null;

      for (const row of candidates) {
        const pid = Number(row?.plan_id);
        if (!Number.isFinite(pid)) continue;

        const { data: recentViews, error: viewsError } = await supabaseAdmin
          .from("videos_vistos")
          .select("visto_en")
          .eq("usuario_id", userId)
          .eq("plan_id", pid)
          .gte("visto_en", windowStart.toISOString())
          .order("visto_en", { ascending: false })
          .limit(1);

        if (viewsError) throw viewsError;

        const rows = Array.isArray(recentViews) ? recentViews : [];
        if (rows.length < 1) {
          canWatchAny = true;
          if (firstEligiblePlanId == null) firstEligiblePlanId = pid;
          break;
        }

        if (rows.length) {
          const earliestIso = rows[rows.length - 1]?.visto_en ? String(rows[rows.length - 1].visto_en) : "";
          const earliest = earliestIso ? new Date(earliestIso) : null;
          const next = earliest && Number.isFinite(earliest.getTime())
            ? new Date(earliest.getTime() + 24 * 60 * 60 * 1000)
            : null;
          if (next && Number.isFinite(next.getTime())) {
            if (nextAvailableAt == null || next.toISOString() < nextAvailableAt) {
              nextAvailableAt = next.toISOString();
            }
            if (now.getTime() >= next.getTime()) {
              canWatchAny = true;
              break;
            }
          }
        }
      }

      if (!canWatchAny) {
        return res.status(422).json({
          error: "Debes esperar 24 horas para ver otro video",
          next_available_at: nextAvailableAt,
        });
      }

      if (planIdToUse == null) planIdToUse = firstEligiblePlanId;
      if (planIdToUse == null) {
        return res.status(403).json({ error: "Plan no activo" });
      }
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

    let rpcError = null;
    let rpcData = null;

    // Preferred signature (multi-plan): registrar_video_visto(p_video_id text, p_calificacion int, p_plan_id int default null)
    {
      const { data, error } = await supabaseUser.rpc("registrar_video_visto", {
        p_video_id: resolvedVideoId,
        p_calificacion: calificacion ?? null,
        p_plan_id: planIdToUse,
      });
      rpcError = error ?? null;
      rpcData = data ?? null;
    }

    // Backward-compatible fallback: some DBs still have registrar_video_visto(p_calificacion int, p_video_id text)
    if (rpcError && String(rpcError.code ?? "") === "PGRST202") {
      const { data, error } = await supabaseUser.rpc("registrar_video_visto", {
        p_calificacion: calificacion ?? null,
        p_video_id: resolvedVideoId,
      });
      rpcError = error ?? null;
      rpcData = data ?? null;
    }

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

      if (lower.includes("24") && lower.includes("hora")) {
        return res.status(422).json({ error: "Debes esperar 24 horas" });
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

    const selected = active.find((r) => Number(r?.plan_id) === Number(planIdToUse)) || active[0];
    const montoRaw = selected?.planes?.ganancia_diaria ?? selected?.planes?.recompensa ?? 0;
    const monto = Number(montoRaw ?? 0);

    const { data: cuenta, error: cuentaError } = await supabaseAdmin
      .from("cuentas")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();

    if (cuentaError) throw cuentaError;
    const balance = Number(cuenta?.balance ?? 0);

    return res.json({
      ok: true,
      monto: Number.isFinite(monto) ? monto : 0,
      plan_id: selected?.plan_id ?? null,
      balance: Number.isFinite(balance) ? balance : 0,
    });
  } catch (error) {
    console.error("❌ Error en POST /videos/ver:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
