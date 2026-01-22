import { supabaseAdmin } from "../services/supabase.service.js";
import { processReferralCommissions } from "../services/referral.service.js";
import { createVipPurchaseIntent } from "../services/vip-intent.service.js";

export const buyVipController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan_id } = req.body;

    if (!plan_id) return res.status(400).json({ error: "Falta plan_id" });

    const { data: rpcRows, error: rpcError } = await supabaseAdmin.rpc("buy_vip", {
      p_user_id: userId,
      p_plan_id: plan_id,
    });

    if (rpcError) {
      const msg = String(rpcError.message ?? "");
      if (
        msg.includes("Saldo insuficiente") ||
        msg.includes("Ya tienes una suscripción activa") ||
        msg.includes("Usuario no encontrado") ||
        msg.includes("Plan no existe")
      ) {
        return res.status(400).json({ error: msg });
      }
      throw rpcError;
    }

    const row = Array.isArray(rpcRows) ? rpcRows[0] : null;
    if (!row?.subscription_id) {
      return res.status(500).json({ error: "No se pudo crear la suscripción" });
    }

    const { data: plan, error: planError } = await supabaseAdmin
      .from("planes")
      .select("*")
      .eq("id", plan_id)
      .single();

    if (planError) throw planError;

    await processReferralCommissions(userId, row.plan_precio, plan, {
      referenciaId: row.subscription_id,
      referenciaTipo: "vip",
    });

    return res.json({
      ok: true,
      message: "VIP activado correctamente",
      expires: row.expires_at,
      expires_at: row.expires_at,
      newBalance: row.new_balance,
      new_balance: row.new_balance,
      subscriptionId: row.subscription_id,
    });

  } catch (err) {
    console.error("❌ Error en buyVipController:", err);
    return res.status(500).json({ error: "Error interno" });
  }
};

export const createVipIntentController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan_id } = req.body;

    if (!plan_id) return res.status(400).json({ error: "Falta plan_id" });

    const intent = await createVipPurchaseIntent(userId, plan_id);
    return res.json({ ok: true, intent });
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (msg.includes("Usuario no encontrado") || msg.includes("Plan no existe")) {
      return res.status(400).json({ error: msg });
    }
    console.error("❌ Error en createVipIntentController:", err);
    return res.status(500).json({ error: "Error interno" });
  }
};
