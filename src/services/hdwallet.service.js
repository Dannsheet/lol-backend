import { HDNodeWallet } from "ethers";

const XPUB = process.env.BSC_XPUB ?? process.env.XPUB;

export function deriveChildAddress(index) {
  if (!XPUB) throw new Error("XPUB no definido en .env");
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Índice de derivación inválido");
  }

  const node = HDNodeWallet.fromExtendedKey(XPUB);
  const child = node.deriveChild(index);

  return {
    address: String(child.address).toLowerCase(),
    index,
  };
}

export async function getNextDerivationIndex(supabase) {
  const { data, error } = await supabase
    .from("user_wallets")
    .select("unique_tag")
    .limit(10000);

  if (error) throw error;

  let maxIndex = -1;
  for (const row of data ?? []) {
    const parsed = Number.parseInt(String(row?.unique_tag ?? ""), 10);
    if (Number.isFinite(parsed) && parsed > maxIndex) maxIndex = parsed;
  }

  return maxIndex >= 0 ? maxIndex + 1 : 0;
}
