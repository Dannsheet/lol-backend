import { Wallet, HDNodeWallet } from "ethers";
import bip39 from "bip39";

// ⚠️ SOLO DEV
// Genera una seed nueva y deriva el XPUB de la cuenta en la ruta:
// m/44'/60'/0'/0
//
// Por defecto imprime MNEMONIC + XPUB.
// Si quieres imprimir XPRV (SENSIBLE), ejecuta:
// node scripts/generate-bsc-xpub-dev.js --xprv

const wants24 = process.argv.includes("--24") || process.argv.includes("--words=24");

const phrase = wants24
  ? bip39.generateMnemonic(256)
  : Wallet.createRandom().mnemonic?.phrase;

if (!phrase) {
  throw new Error("No se pudo generar mnemonic");
}

const root = HDNodeWallet.fromPhrase(phrase, undefined, "m");
const account = root.derivePath("m/44'/60'/0'/0");

console.log("MNEMONIC (DEV ONLY):");
console.log(phrase);

console.log("\nBSC_XPUB:");
console.log(account.neuter().extendedKey);

if (process.argv.includes("--xprv")) {
  console.log("\nXPRV (DEV ONLY):");
  console.log(account.extendedKey);
}
