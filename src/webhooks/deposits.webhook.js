import express from "express";
import { supabaseAdmin } from "../services/supabase.service.js";

const router = express.Router();

router.post("/deposit/webhook", async (req, res) => {
  try {
    const { tx_hash, amount, address, tag } = req.body;

    if (!tag) return res.status(400).json({ error: "Falta tag" });
    if (!tx_hash) return res.status(400).json({ error: "Falta tx_hash" });

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: "Amount inválido" });
    }

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from("user_wallets")
      .select("user_id, deposit_address, network")
      .eq("unique_tag", tag)
      .single();

    if (walletError) {
      return res.status(400).json({ error: "Usuario no encontrado" });
    }

    if (!wallet) {
      return res.status(400).json({ error: "Usuario no encontrado" });
    }

    if (address && wallet.deposit_address && address !== wallet.deposit_address) {
      return res.status(400).json({ error: "Address no coincide" });
    }

    const userId = wallet.user_id;

    const { data: existingDeposit, error: existingDepositError } = await supabaseAdmin
      .from("depositos")
      .select("id")
      .eq("hash_tx", tx_hash)
      .maybeSingle();

    if (existingDepositError) {
      console.error("Webhook deposit error (check duplicate):", existingDepositError);
      return res.status(500).json({ error: "internal error" });
    }

    if (existingDeposit) {
      return res.json({ ok: true, duplicated: true });
    }

    const { error: insertError } = await supabaseAdmin.from("depositos").insert({
      usuario_id: userId,
      monto: parsedAmount,
      hash_tx: tx_hash,
      token: "USDT",
      confirmado: true,
      deposit_tag: tag,
    });

    if (insertError) throw insertError;

    const { error: rpcError } = await supabaseAdmin.rpc("increment_user_balance", {
      userid: userId,
      amountdelta: parsedAmount,
    });

    if (rpcError) throw rpcError;

    return res.json({ ok: true });
  } catch (e) {
    console.error("Webhook deposit error:", e);
    return res.status(500).json({ error: "internal error" });
  }
});

export default router;
