import { supabaseAdmin } from "../services/supabase.service.js";
import { Contract, JsonRpcProvider, Wallet, parseUnits, isAddress, formatUnits } from "ethers";

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
];

let running = false;
let decimalsCache = null;

const getEnvNumber = (key, fallback) => {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const bestEffortRefund = async (userId, amount) => {
  try {
    const { error } = await supabaseAdmin.rpc("sumar_balance", {
      p_user_id: userId,
      p_cantidad: amount,
    });

    if (error && String(error.code ?? "") === "PGRST202") {
      await supabaseAdmin.rpc("increment_user_balance", {
        userid: userId,
        amountdelta: Number(amount),
      });
    }
  } catch {
    try {
      await supabaseAdmin.rpc("increment_user_balance", {
        userid: userId,
        amountdelta: Number(amount),
      });
    } catch {
      // ignore
    }
  }
};

const markFailed = async (retId) => {
  await supabaseAdmin
    .from("retiros")
    .update({
      estado: "fallido",
      procesado_en: new Date().toISOString(),
    })
    .eq("id", retId);
};

const markConfirmed = async (retId) => {
  await supabaseAdmin
    .from("retiros")
    .update({
      estado: "confirmado",
      confirmado_en: new Date().toISOString(),
    })
    .eq("id", retId)
    .in("estado", ["enviado", "aprobado"]);
};

const markSent = async (retId, txHash) => {
  await supabaseAdmin
    .from("retiros")
    .update({
      estado: "enviado",
      tx_hash: txHash,
      procesado_en: new Date().toISOString(),
    })
    .eq("id", retId)
    .eq("estado", "aprobado");
};

const ensureApproved = async (retId) => {
  await supabaseAdmin
    .from("retiros")
    .update({ estado: "aprobado" })
    .eq("id", retId)
    .eq("estado", "pendiente");
};

const reconcileSentWithdrawals = async (provider, confirmationsRequired) => {
  const { data: rows, error } = await supabaseAdmin
    .from("retiros")
    .select("id, usuario_id, tx_hash, total")
    .eq("estado", "enviado")
    .not("tx_hash", "is", null)
    .order("procesado_en", { ascending: true })
    .limit(10);

  if (error) return;
  const list = Array.isArray(rows) ? rows : [];

  for (const r of list) {
    const txHash = String(r?.tx_hash || '').trim();
    if (!txHash) continue;

    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) continue;
      const confs = Number(receipt.confirmations || 0);
      if (confs < confirmationsRequired) continue;

      if (receipt.status === 1) {
        await markConfirmed(r.id);
      } else {
        await markFailed(r.id);
        const refundAmount = Number(r?.total ?? 0);
        if (Number.isFinite(refundAmount) && refundAmount > 0) {
          await bestEffortRefund(r.usuario_id, refundAmount);
        }
      }
    } catch {
      // ignore reconcile errors
    }
  }
};

async function processWithdrawals() {
  if (running) return;
  running = true;
  console.log("🔁 Worker: buscando retiros pendientes...");

  const rpcUrl = String(process.env.BSC_RPC_URL || '').trim();
  const privateKey = String(process.env.WITHDRAW_PRIVATE_KEY || '').trim();
  const usdtContract = String(process.env.USDT_CONTRACT_BSC || '').trim();
  const confirmationsRequired = getEnvNumber("CONFIRMATIONS_REQUIRED", 1);
  const configuredDecimals = getEnvNumber("USDT_DECIMALS", null);

  if (!rpcUrl || !privateKey || !usdtContract) {
    console.error(
      "❌ Worker retiros: faltan variables .env (BSC_RPC_URL, WITHDRAW_PRIVATE_KEY, USDT_CONTRACT_BSC)"
    );
    running = false;
    return;
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const token = new Contract(usdtContract, ERC20_ABI, wallet);

  try {
    const net = await provider.getNetwork();
    console.log(
      `🌐 Worker network: chainId=${String(net?.chainId ?? '')} name=${String(net?.name ?? '')} wallet=${wallet.address}`
    );
  } catch {
    // ignore
  }

  if (decimalsCache == null) {
    if (Number.isFinite(configuredDecimals) && configuredDecimals > 0) {
      decimalsCache = configuredDecimals;
    } else {
      try {
        const d = await token.decimals();
        decimalsCache = Number(d);
      } catch {
        decimalsCache = 18;
      }
    }
  }

  await reconcileSentWithdrawals(provider, confirmationsRequired);

  // 1️⃣ Llamar RPC tomar_retiro() (si existe). Si no hay resultado, fallback a tabla.
  let r = null;
  try {
    const { data, error: rpcError } = await supabaseAdmin.rpc("tomar_retiro");
    if (rpcError) {
      console.error("❌ Error RPC tomar_retiro:", rpcError.message);
    } else if (Array.isArray(data) && data.length) {
      r = data[0];
    }
  } catch (e) {
    console.error("❌ Excepción RPC tomar_retiro:", e?.message || e);
  }

  if (!r) {
    const { data: rows, error } = await supabaseAdmin
      .from("retiros")
      .select("id, usuario_id, monto, red, direccion, total, estado")
      .in("estado", ["pendiente", "aprobado"])
      .limit(1);

    if (error) {
      console.error("❌ Error consultando retiros:", error.message);
      running = false;
      return;
    }

    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!row) {
      console.log("⏭️ No hay retiros pendientes");
      running = false;
      return;
    }

    await ensureApproved(row.id);
    r = {
      ret_id: row.id,
      ret_usuario_id: row.usuario_id,
      ret_monto: row.monto,
      ret_red: row.red,
      ret_direccion: row.direccion,
      ret_total: row.total,
    };
  }

  await ensureApproved(r.ret_id);

  console.log(`⚙️ Retiro tomado => ID: ${r.ret_id}`);

  const net = String(r?.ret_red || '').toUpperCase();
  if (net !== 'BEP20-USDT') {
    console.log('⏭️ Retiro requiere procesamiento manual (no BEP20-USDT):', net);
    running = false;
    return;
  }

  const to = String(r?.ret_direccion || '').trim();
  if (!isAddress(to)) {
    console.error('❌ Dirección inválida:', to);
    await markFailed(r.ret_id);
    const refundAmount = Number(r?.ret_total ?? 0);
    if (Number.isFinite(refundAmount) && refundAmount > 0) {
      await bestEffortRefund(r.ret_usuario_id, refundAmount);
    }
    running = false;
    return;
  }

  const amountStr = String(r?.ret_monto ?? '').trim();
  const amountNum = Number(amountStr);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    console.error('❌ Monto inválido:', amountStr);
    await markFailed(r.ret_id);
    const refundAmount = Number(r?.ret_total ?? 0);
    if (Number.isFinite(refundAmount) && refundAmount > 0) {
      await bestEffortRefund(r.ret_usuario_id, refundAmount);
    }
    running = false;
    return;
  }

  try {
    const units = parseUnits(amountStr, decimalsCache);
    try {
      const balanceRaw = await token.balanceOf(wallet.address);
      const balanceFmt = formatUnits(balanceRaw, decimalsCache);
      console.log(`💰 Worker USDT balance: ${balanceFmt} (decimals=${decimalsCache})`);
      if (balanceRaw < units) {
        throw new Error(`USDT insuficiente en wallet de retiros. Balance=${balanceFmt}, requerido=${amountStr}`);
      }
    } catch (balErr) {
      console.error('❌ No se pudo validar balance USDT antes de enviar:', balErr?.message || balErr);
      throw balErr;
    }
    console.log(`🚀 Enviando ${amountStr} USDT (decimals=${decimalsCache}) a ${to}`);

    const tx = await token.transfer(to, units);
    await markSent(r.ret_id, tx.hash);
    console.log(`📤 Enviado: ${tx.hash}`);

    const receipt = await tx.wait(confirmationsRequired);
    if (receipt?.status === 1) {
      await markConfirmed(r.ret_id);
      console.log(`✅ Retiro confirmado: ${r.ret_id}`);
    } else {
      console.error('❌ TX revertida:', tx.hash);
      await markFailed(r.ret_id);
      const refundAmount = Number(r?.ret_total ?? 0);
      if (Number.isFinite(refundAmount) && refundAmount > 0) {
        await bestEffortRefund(r.ret_usuario_id, refundAmount);
      }
    }
  } catch (e) {
    console.error('❌ Error enviando retiro:', e?.message || e);
    await markFailed(r.ret_id);
    const refundAmount = Number(r?.ret_total ?? 0);
    if (Number.isFinite(refundAmount) && refundAmount > 0) {
      await bestEffortRefund(r.ret_usuario_id, refundAmount);
    }
  } finally {
    running = false;
  }
}

// Ejecutar cada 10 segundos
setInterval(processWithdrawals, 10000);

console.log("🔧 Worker de retiros iniciado...");
