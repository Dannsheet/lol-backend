import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { supabaseAdmin } from "../services/supabase.service.js";
import {
  deriveChildAddress,
  getNextDerivationIndex,
} from "../services/hdwallet.service.js";
import {
  getSupportedTokenByContract,
  getSupportedTokenBySymbol,
} from "../config/tokens.js";
import { tryAutoActivateVipForUser } from "../services/vip-intent.service.js";

const router = express.Router();

/**
 * ============================================
 * GENERAR DIRECCIÓN DE DEPÓSITO (REAL)
 * ============================================
 *
 * Devuelve una dirección fija configurada en .env
 * que es la billetera del sistema donde llegan los fondos.
 *
 * Frontend usa esta ruta al pulsar "Recargar"
 */
router.post("/deposit/address", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const network = process.env.DEPOSIT_NETWORK ?? "BEP20-USDT";

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("user_wallets")
      .select("deposit_address, network")
      .eq("user_id", userId)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing?.deposit_address) {
      return res.json({
        ok: true,
        address: existing.deposit_address,
        network: existing.network ?? network,
      });
    }

    // Compatibilidad: si el frontend aún llama /deposit/address, creamos la wallet la primera vez.
    for (let attempt = 0; attempt < 5; attempt++) {
      const nextIndex = await getNextDerivationIndex(supabaseAdmin);
      const { address, index } = deriveChildAddress(nextIndex);

      const { data: inserted, error: insertError } = await supabaseAdmin
        .from("user_wallets")
        .insert({
          user_id: userId,
          deposit_address: address,
          unique_tag: String(index),
          network,
        })
        .select("deposit_address, network")
        .single();

      if (!insertError) {
        return res.json({
          ok: true,
          address: inserted.deposit_address,
          network: inserted.network ?? network,
        });
      }

      const code = String(insertError.code ?? "");
      if (code === "23505") continue;
      throw insertError;
    }

    return res.status(500).json({ error: "No se pudo generar dirección" });
  } catch (error) {
    console.error("❌ Error en /deposit/address:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.post("/deposits/webhook", async (req, res) => {
  try {
    const {
      txHash,
      amount,
      userId,
      toAddress,
      token,
      tokenContract,
      contract,
      symbol,
      network,
    } = req.body;

    if (!txHash || amount == null || (!toAddress && !userId)) {
      return res.status(400).json({ error: "Campos faltantes" });
    }

    const contractCandidate = tokenContract ?? contract;
    const resolvedToken = contractCandidate
      ? getSupportedTokenByContract(contractCandidate)
      : getSupportedTokenBySymbol(token ?? symbol);

    if (!resolvedToken) {
      return res.status(400).json({ error: "Token no soportado" });
    }

    const normalizedNetwork = network ? String(network).trim().toUpperCase() : null;
    if (normalizedNetwork && !normalizedNetwork.startsWith("BEP20")) {
      return res.status(400).json({ error: "Token o red inválida" });
    }

    let resolvedUserId = userId;
    let normalizedToAddress = null;
    if (!resolvedUserId) {
      normalizedToAddress = String(toAddress).trim().toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(normalizedToAddress)) {
        return res.status(400).json({ error: "toAddress inválido" });
      }

      const { data: wallet, error: walletError } = await supabaseAdmin
        .from("user_wallets")
        .select("user_id, network")
        .eq("deposit_address", normalizedToAddress)
        .limit(1)
        .maybeSingle();
      if (walletError) throw walletError;
      if (!wallet?.user_id) {
        return res.status(404).json({ error: "Wallet no encontrada" });
      }

      resolvedUserId = wallet.user_id;
    } else if (toAddress) {
      normalizedToAddress = String(toAddress).trim().toLowerCase();
    }

    if (normalizedToAddress && !/^0x[a-f0-9]{40}$/.test(normalizedToAddress)) {
      return res.status(400).json({ error: "toAddress inválido" });
    }

    const amountStr = String(amount ?? "").trim();
    if (!/^(\d+)(\.\d+)?$/.test(amountStr)) {
      return res.status(400).json({ error: "amount inválido" });
    }

    const parsedAmount = Number(amountStr);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: "amount inválido" });
    }

    // Registrar TX confirmada (idempotente por tx_hash)
    // Si viene userId (modo legacy) y no viene toAddress, registramos igualmente usando un placeholder.
    const auditToAddress = normalizedToAddress ?? "0x0000000000000000000000000000000000000000";

    const { data: existingTx, error: existingTxError } = await supabaseAdmin
      .from("depositos_blockchain")
      .select("id")
      .eq("tx_hash", txHash)
      .maybeSingle();

    if (existingTxError) throw existingTxError;
    if (existingTx) {
      return res.status(200).json({ ok: true, duplicated: true });
    }

    const storedNetwork = "BEP20-USDT";

    const { error: insertTxError } = await supabaseAdmin
      .from("depositos_blockchain")
      .insert({
        user_id: resolvedUserId,
        tx_hash: txHash,
        to_address: auditToAddress,
        amount: amountStr,
        network: storedNetwork,
        token_symbol: resolvedToken.symbol,
        status: "confirmed",
        confirmations: 0,
      });

    if (insertTxError) {
      const code = String(insertTxError.code ?? "");
      if (code === "23505") {
        return res.status(200).json({ ok: true, duplicated: true });
      }
      throw insertTxError;
    }

    const { error: insertDepositError } = await supabaseAdmin
      .from("depositos")
      .insert({
        usuario_id: resolvedUserId,
        hash_tx: txHash,
        monto: parsedAmount,
        token: resolvedToken.symbol,
        confirmado: true,
        network: "BEP20",
        credited: true,
        metadata: {
          to_address: auditToAddress,
          source: "deposits_webhook",
        },
      });

    if (insertDepositError) {
      throw insertDepositError;
    }

    const { error: balanceError } = await supabaseAdmin.rpc(
      "increment_user_balance",
      {
        userid: resolvedUserId,
        amountdelta: parsedAmount,
      }
    );

    if (balanceError) {
      throw balanceError;
    }

    const { data: userRow, error: userError } = await supabaseAdmin
      .from("usuarios")
      .select("saldo_interno")
      .eq("id", resolvedUserId)
      .maybeSingle();

    if (userError) {
      throw userError;
    }

    let vipAuto = null;
    try {
      vipAuto = await tryAutoActivateVipForUser(resolvedUserId, {
        source: "deposits_webhook",
        txHash,
        amount: amountStr,
      });
    } catch (e) {
      console.error(
        `❌ Error intentando VIP auto-activate (user=${resolvedUserId}, tx=${txHash}):`,
        e?.message || e
      );
    }

    return res.json({
      ok: true,
      credited: amountStr,
      newBalance: userRow?.saldo_interno ?? null,
      vip_auto: vipAuto,
    });
  } catch (error) {
    console.error("❌ Error en /deposits/webhook:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;

