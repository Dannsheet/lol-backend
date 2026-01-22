import { supabaseAdmin } from "./supabase.service.js";
import { processReferralCommissions } from "./referral.service.js";

const normalizePlanId = (planId) => {
  const n = Number.parseInt(String(planId ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
};

export async function createVipPurchaseIntent(userId, planId) {
  const normalizedPlanId = normalizePlanId(planId);
  if (!userId) throw new Error("Usuario no encontrado");
  if (!normalizedPlanId) throw new Error("Plan no existe");

  const { error: cancelError } = await supabaseAdmin
    .from("vip_purchase_intents")
    .update({
      status: "canceled",
      updated_at: new Date().toISOString(),
      last_error: "Reemplazado por un nuevo intento",
    })
    .eq("user_id", userId)
    .eq("status", "pending");

  if (cancelError) throw cancelError;

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("vip_purchase_intents")
    .insert({
      user_id: userId,
      plan_id: normalizedPlanId,
      status: "pending",
      attempts: 0,
    })
    .select("id, user_id, plan_id, status, created_at")
    .single();

  if (insertError) throw insertError;
  return inserted;
}

export async function tryAutoActivateVipForUser(userId, context = {}) {
  if (!userId) return { attempted: false };

  const enabled = String(process.env.VIP_AUTO_ACTIVATE_ENABLED || "true").toLowerCase();
  if (enabled === "false" || enabled === "0") return { attempted: false, disabled: true };

  const { data: pending, error: pendingError } = await supabaseAdmin
    .from("vip_purchase_intents")
    .select("id, plan_id, status")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingError) throw pendingError;
  if (!pending?.id) return { attempted: false, reason: "no_intent" };

  const nowIso = new Date().toISOString();

  const { data: locked, error: lockError } = await supabaseAdmin
    .from("vip_purchase_intents")
    .update({
      status: "processing",
      updated_at: nowIso,
      attempts: (pending.attempts ?? 0) + 1,
      last_context: context,
    })
    .eq("id", pending.id)
    .eq("status", "pending")
    .select("id, plan_id")
    .maybeSingle();

  if (lockError) throw lockError;
  if (!locked?.id) return { attempted: false, reason: "locked" };

  const planId = normalizePlanId(locked.plan_id);
  if (!planId) {
    await supabaseAdmin
      .from("vip_purchase_intents")
      .update({ status: "failed", updated_at: nowIso, last_error: "Plan inválido" })
      .eq("id", locked.id);
    return { attempted: true, ok: false, reason: "invalid_plan" };
  }

  const { data: rpcRows, error: rpcError } = await supabaseAdmin.rpc("buy_vip", {
    p_user_id: userId,
    p_plan_id: planId,
  });

  if (rpcError) {
    const msg = String(rpcError.message ?? "");

    const revertToPending = msg.includes("Saldo insuficiente");
    const nextStatus = revertToPending ? "pending" : "failed";

    await supabaseAdmin
      .from("vip_purchase_intents")
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString(),
        last_error: msg,
      })
      .eq("id", locked.id);

    return { attempted: true, ok: false, error: msg, status: nextStatus };
  }

  const row = Array.isArray(rpcRows) ? rpcRows[0] : null;
  const subscriptionId = row?.subscription_id ?? null;

  await supabaseAdmin
    .from("vip_purchase_intents")
    .update({
      status: "completed",
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      subscription_id: subscriptionId,
      last_error: null,
    })
    .eq("id", locked.id);

  try {
    const { data: plan, error: planError } = await supabaseAdmin
      .from("planes")
      .select("*")
      .eq("id", planId)
      .single();

    if (planError) throw planError;

    await processReferralCommissions(userId, row?.plan_precio ?? null, plan, {
      referenciaId: subscriptionId,
      referenciaTipo: "vip",
    });
  } catch (e) {
    console.error("❌ Error procesando comisiones VIP (auto):", e?.message || e);
  }

  return { attempted: true, ok: true, subscriptionId, planId };
}
