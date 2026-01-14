const normalizeAddress = (value) => {
  const v = String(value ?? "").trim();
  return v ? v.toLowerCase() : null;
};

const normalizeSymbol = (value) => String(value ?? "").trim().toUpperCase();

const parseSupportedTokens = () => {
  const raw = String(process.env.SUPPORTED_TOKENS ?? "").trim();
  if (!raw) return null;

  const set = new Set(
    raw
      .split(",")
      .map((x) => normalizeSymbol(x))
      .filter(Boolean)
  );

  return set.size ? set : null;
};

const SUPPORTED = parseSupportedTokens();

const isEnabled = (symbol) => {
  if (!SUPPORTED) return true;
  const s = normalizeSymbol(symbol);
  return SUPPORTED.has(s) || SUPPORTED.has(`BEP20_${s}`);
};

export const TOKENS = {
  USDT: {
    symbol: "USDT",
    contract: normalizeAddress(process.env.USDT_CONTRACT_BSC),
    decimals: 18,
  },
  BUSD: {
    symbol: "BUSD",
    contract: normalizeAddress(process.env.BUSD_CONTRACT_BSC),
    decimals: 18,
  },
  USDC: {
    symbol: "USDC",
    contract: normalizeAddress(process.env.USDC_CONTRACT_BSC),
    decimals: 18,
  },
  DAI: {
    symbol: "DAI",
    contract: normalizeAddress(process.env.DAI_CONTRACT_BSC),
    decimals: 18,
  },
};

export const TOKEN_ALIASES = {
  "BSC-USD": "BUSD",
  BSCUSD: "BUSD",
};

export function getSupportedTokenByContract(contractAddress) {
  const addr = normalizeAddress(contractAddress);
  if (!addr) return null;
  return (
    Object.values(TOKENS).find(
      (t) => t?.contract && t.contract === addr && isEnabled(t.symbol)
    ) ?? null
  );
}

export function getSupportedTokenBySymbol(symbol) {
  const raw = normalizeSymbol(symbol);
  const key = TOKEN_ALIASES[raw] ?? raw;
  const token = TOKENS[key];
  if (!token?.symbol) return null;
  if (!isEnabled(token.symbol)) return null;
  return token;
}
