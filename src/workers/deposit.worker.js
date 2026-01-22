import { supabaseAdmin } from "../services/supabase.service.js";
import { tryAutoActivateVipForUser } from "../services/vip-intent.service.js";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  formatUnits,
  id,
  zeroPadValue,
} from "ethers";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

const TRANSFER_TOPIC0 = id("Transfer(address,address,uint256)");

let running = false;
let decimalsCache = null;
let walletMap = new Map();
let lastProcessedBlock = null;
let warnedDepositosBlockchainMissing = false;

const getEnvNumber = (key, fallback) => {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const chunkArray = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const toTopicAddress = (addr) => {
  try {
    return zeroPadValue(String(addr).toLowerCase(), 32);
  } catch {
    return null;
  }
};

const refreshWalletMap = async () => {
  const { data, error } = await supabaseAdmin
    .from("user_wallets")
    .select("user_id, deposit_address")
    .limit(10000);

  if (error) {
    console.error("❌ Deposit worker: error leyendo user_wallets:", error.message);
    return;
  }

  const next = new Map();
  for (const row of data ?? []) {
    const addr = String(row?.deposit_address ?? "")
      .trim()
      .toLowerCase();
    const userId = row?.user_id;
    if (!addr || !userId) continue;
    next.set(addr, userId);
  }

  walletMap = next;
};

async function processDeposits() {
  if (running) return;
  running = true;

  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const usdtContract = String(process.env.USDT_CONTRACT_BSC || "").trim();
  const confirmationsRequired = getEnvNumber("CONFIRMATIONS_REQUIRED", 1);
  const scanBatchBlocks = getEnvNumber("DEPOSIT_SCAN_BLOCK_BATCH", 500);
  const topicBatch = getEnvNumber("DEPOSIT_TOPIC_BATCH", 25);

  if (!rpcUrl || !usdtContract) {
    console.error(
      "❌ Deposit worker: faltan variables .env (BSC_RPC_URL, USDT_CONTRACT_BSC)"
    );
    running = false;
    return;
  }

  try {
    if (!walletMap.size) {
      await refreshWalletMap();
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const token = new Contract(usdtContract, ERC20_ABI, provider);

    if (decimalsCache == null) {
      try {
        decimalsCache = Number(await token.decimals());
      } catch {
        decimalsCache = 18;
      }
    }

    const head = await provider.getBlockNumber();
    const targetBlock = Math.max(0, head - confirmationsRequired);

    if (lastProcessedBlock == null) {
      const configuredFrom = getEnvNumber("DEPOSIT_FROM_BLOCK", null);
      if (Number.isFinite(configuredFrom) && configuredFrom >= 0) {
        lastProcessedBlock = configuredFrom;
      } else {
        const fallback = Math.max(0, targetBlock - 2000);
        lastProcessedBlock = fallback;
        console.log(
          `ℹ️ Deposit worker: DEPOSIT_FROM_BLOCK no configurado. Empezando desde bloque ${fallback}`
        );
      }
    }

    if (lastProcessedBlock >= targetBlock) {
      running = false;
      return;
    }

    const fromBlock = lastProcessedBlock + 1;
    const toBlock = Math.min(fromBlock + scanBatchBlocks, targetBlock);

    const iface = new Interface(ERC20_ABI);

    const addresses = Array.from(walletMap.keys());
    const addressTopics = addresses
      .map(toTopicAddress)
      .filter((t) => typeof t === "string" && t.startsWith("0x"));

    if (!addressTopics.length) {
      lastProcessedBlock = toBlock;
      running = false;
      return;
    }

    const topicChunks = chunkArray(addressTopics, topicBatch);

    for (const chunk of topicChunks) {
      let logs = [];
      try {
        logs = await provider.getLogs({
          address: usdtContract,
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC0, null, chunk],
        });
      } catch (e) {
        console.error(
          `❌ Deposit worker: error getLogs bloques ${fromBlock}-${toBlock}:`,
          e?.message || e
        );
        continue;
      }

      for (const log of logs) {
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue;
        }

        const to = String(parsed?.args?.to ?? "")
          .trim()
          .toLowerCase();
        const userId = walletMap.get(to);
        if (!userId) continue;

        const txHash = String(log.transactionHash || "").trim();
        if (!txHash) continue;

        const value = parsed?.args?.value;
        const amountStr = formatUnits(value, decimalsCache);

        const { error: insertChainError } = await supabaseAdmin
          .from("depositos_blockchain")
          .insert({
            user_id: userId,
            tx_hash: txHash,
            to_address: to,
            amount: amountStr,
            network: "BEP20-USDT",
            token_symbol: "USDT",
            status: "confirmed",
            confirmations: confirmationsRequired,
          });

        if (insertChainError) {
          const code = String(insertChainError.code ?? "");
          if (code === "23505") {
            continue;
          }

          console.error(
            `❌ Deposit worker: error insertando depositos_blockchain (tx=${txHash}):`,
            insertChainError.message
          );
          continue;
        }

        const { error: insertDepositError } = await supabaseAdmin
          .from("depositos")
          .insert({
            usuario_id: userId,
            hash_tx: txHash,
            monto: amountStr,
            token: "USDT",
            confirmado: true,
            network: "BEP20",
            credited: true,
            metadata: {
              to_address: to,
              source: "deposit_worker",
            },
          });

        if (insertDepositError) {
          console.error(
            `❌ Deposit worker: error insertando depositos (tx=${txHash}):`,
            insertDepositError.message
          );
          continue;
        }

        const { error: rpcError } = await supabaseAdmin.rpc(
          "increment_user_balance",
          {
            userid: userId,
            amountdelta: Number(amountStr),
          }
        );

        if (rpcError) {
          console.error(
            `❌ Deposit worker: increment_user_balance falló (user=${userId}, tx=${txHash}):`,
            rpcError.message
          );
          continue;
        }

        console.log(
          `✅ Depósito acreditado user=${userId} amount=${amountStr} tx=${txHash}`
        );

        try {
          const result = await tryAutoActivateVipForUser(userId, {
            source: "deposit_worker",
            txHash,
            amount: amountStr,
          });

          if (result?.attempted && result?.ok) {
            console.log(
              `✅ VIP auto-activado user=${userId} plan=${result.planId} subscription=${result.subscriptionId}`
            );
          } else if (result?.attempted && result?.ok === false) {
            console.log(
              `ℹ️ VIP auto-activate no aplicado user=${userId} status=${result.status ?? "n/a"} error=${result.error ?? result.reason ?? ""}`
            );
          }
        } catch (e) {
          console.error(
            `❌ Error intentando VIP auto-activate (user=${userId}, tx=${txHash}):`,
            e?.message || e
          );
        }
      }
    }

    lastProcessedBlock = toBlock;
  } catch (e) {
    console.error("❌ Deposit worker error:", e?.message || e);
  } finally {
    running = false;
  }
}

const enabled = String(process.env.DEPOSIT_SCAN_ENABLED || "true").toLowerCase();
if (enabled !== "false" && enabled !== "0") {
  const refreshMs = getEnvNumber("DEPOSIT_WALLETS_REFRESH_MS", 30000);
  const scanMs = getEnvNumber("DEPOSIT_SCAN_INTERVAL_MS", 15000);

  console.log("🔧 Worker de depósitos iniciado...");

  refreshWalletMap();
  setInterval(refreshWalletMap, refreshMs);
  setInterval(processDeposits, scanMs);
}
