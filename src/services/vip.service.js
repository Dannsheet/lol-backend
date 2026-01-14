import { supabase } from "../config/supabase.js";

export async function buyVip(userId, planId) {
  const { data: plan, error: planError } = await supabase
    .from("vip_plans")
    .select("*")
    .eq("id", planId)
    .single();

  if (planError || !plan) throw new Error("El plan no existe");

  const { data: user, error: userError } = await supabase
    .from("usuarios")
    .select("balance")
    .eq("id", userId)
    .single();

  if (userError) throw new Error("Usuario no encontrado");

  if (user.balance < plan.price) {
    throw new Error("Saldo insuficiente");
  }

  const newBalance = user.balance - plan.price;

  await supabase
    .from("usuarios")
    .update({ balance: newBalance })
    .eq("id", userId);

  const expiration = new Date();
  expiration.setDate(expiration.getDate() + plan.duration_days);

  const { data: subscription, error: subError } = await supabase
    .from("subscriptions")
    .insert({
      user_id: userId,
      plan_id: planId,
      expires_at: expiration,
      is_active: true,
    })
    .select()
    .single();

  if (subError) throw new Error(subError.message);

  return { subscription, newBalance };
}
