import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { ConstantProductCurve } from "../curve/constantProduct";
import { computeInverseTransferFee, computeTransferFeeForPre } from "../curve/fee";
import { getMint, getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  getAuthAddress,
  getPoolAddress,
  getPoolVaultAddress,
  getPoolLpMintAddress,
} from "../../tests/utils/pda";
import { RoundDirection } from "../curve/calculator";
import idl from "../../target/idl/raydium_cp_swap.json";

// Deposit script: single-token input, compute fees, and call program.deposit

function awaitConfirmation(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(prompt + " [y/N]: ");
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      const ans = data.toString().trim().toLowerCase();
      resolve(ans === "y" || ans === "yes");
    });
  });
}

// Detect token program owners for mints (SPL v1 vs token-2022)
async function detectTokenProgram(connection: Connection, mint: PublicKey) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Unsupported mint owner for ${mint.toBase58()}: ${info.owner.toBase58()}`);
}

async function loadKeypair(path: string): Promise<Keypair> {
  const fs = await import("fs/promises");
  const raw = await fs.readFile(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

async function main() {
  // Constants and provider setup
  const RPC_URL = "https://api.devnet.solana.com";
  const FEE_PAYER_WALLET_PATH = "/home/avinash_dubey/.config/solana/id.json";
  const CREATOR_WALLET_PATH = "/home/avinash_dubey/.config/solana/id1.json";
  const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
  const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");
  const MINT_A = new PublicKey("FRYJVUuNHeH1jJ4D56TTgRZyFQ7jEQQdu1vpd4evdkPb");
  const MINT_B = new PublicKey("7Ru62uNfTEqx748XweWjLgjeJrT7KWjCsiocnK7Qqx9");

  // Owner signer
  const ownerKeypairPath = CREATOR_WALLET_PATH;

  // Setup connection and provider
  const connection = new Connection(RPC_URL, "confirmed");
  const feePayer = await loadKeypair(FEE_PAYER_WALLET_PATH);
  const wallet = new anchor.Wallet(feePayer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL and program
  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider as any);

  // Hardcoded user input (token0 human amount)
  const inputToken0Human = "100";

  if (!ownerKeypairPath) throw new Error("OWNER_KEYPAIR must be set to keypair path");
  const owner = await loadKeypair(ownerKeypairPath);

  // Determine token ordering and fetch mints
  const [token0Mint, token1Mint] = Buffer.compare(MINT_A.toBuffer(), MINT_B.toBuffer()) < 0 ? [MINT_A, MINT_B] : [MINT_B, MINT_A];

  // Fetch on-chain mint decimals
  const mint0 = await getMint(connection, token0Mint);
  const mint1 = await getMint(connection, token1Mint);

  // Derive pool PDAs
  const [poolStatePubkey] = await getPoolAddress(AMM_CONFIG, token0Mint, token1Mint, PROGRAM_ID);
  const [lpMint] = await getPoolLpMintAddress(poolStatePubkey, PROGRAM_ID);
  const [token0Vault] = await getPoolVaultAddress(poolStatePubkey, token0Mint, PROGRAM_ID);
  const [token1Vault] = await getPoolVaultAddress(poolStatePubkey, token1Mint, PROGRAM_ID);

  const vault0Acct = await getAccount(connection, token0Vault);
  const vault1Acct = await getAccount(connection, token1Vault);

  const poolVault0Amount = new BN(vault0Acct.amount.toString());
  const poolVault1Amount = new BN(vault1Acct.amount.toString());

  // LP supply
  const lpMintAcct = await getMint(connection, lpMint);
  const lpSupply = new BN(lpMintAcct.supply.toString());

  // Fetch pool_state to compute totals without accumulated fees (match on-chain logic)
  const poolStateAcct: any = await (program.account as any).poolState.fetch(poolStatePubkey);

  // BN-safe parse of pool_state fee counters
  const proto0 = new BN(poolStateAcct.protocolFeesToken0?.toString?.() ?? poolStateAcct.protocolFeesToken0 ?? 0);
  const fund0 = new BN(poolStateAcct.fundFeesToken0?.toString?.() ?? poolStateAcct.fundFeesToken0 ?? 0);
  const creator0 = new BN(poolStateAcct.creatorFeesToken0?.toString?.() ?? poolStateAcct.creatorFeesToken0 ?? 0);
  const feesToken0 = proto0.add(fund0).add(creator0);

  const proto1 = new BN(poolStateAcct.protocolFeesToken1?.toString?.() ?? poolStateAcct.protocolFeesToken1 ?? 0);
  const fund1 = new BN(poolStateAcct.fundFeesToken1?.toString?.() ?? poolStateAcct.fundFeesToken1 ?? 0);
  const creator1 = new BN(poolStateAcct.creatorFeesToken1?.toString?.() ?? poolStateAcct.creatorFeesToken1 ?? 0);
  const feesToken1 = proto1.add(fund1).add(creator1);

  if (feesToken0.gt(poolVault0Amount) || feesToken1.gt(poolVault1Amount)) {
    throw new Error("Pool state fee counters exceed vault balances (invalid state)");
  }

  const totalVault0 = poolVault0Amount.sub(feesToken0);
  const totalVault1 = poolVault1Amount.sub(feesToken1);

  // Use authoritative lp supply from pool state (program uses this)
  const lpSupplyFromState = new BN(poolStateAcct.lpSupply?.toString?.() ?? lpMintAcct.supply.toString());

  // User provides pre-fee token0 amount (base units)
  const decimals0 = mint0.decimals;
  const inputToken0Base = new BN(Math.floor(Number(inputToken0Human) * Math.pow(10, decimals0)).toString());

  // Compute transfer fee for provided pre-fee amount
  const fee0bn = await computeTransferFeeForPre(connection, token0Mint, inputToken0Base);
  const postToken0 = inputToken0Base.sub(fee0bn);

  // Compute implied LP from post-fee token0 (ceiling) using program totals
  let impliedLp = postToken0.mul(lpSupplyFromState).div(totalVault0);
  if (postToken0.mul(lpSupplyFromState).mod(totalVault0).gt(new BN(0))) {
    impliedLp = impliedLp.add(new BN(1));
  }

  const results = ConstantProductCurve.lpTokensToTradingTokens(
    impliedLp,
    lpSupplyFromState,
    totalVault0,
    totalVault1,
    // Ceiling rounding
    RoundDirection.Ceiling
  );

  const token0Amount = results.tokenAmount0;
  const token1Amount = results.tokenAmount1;

  // For token0 we used a pre-fee input; fee computed above
  const fee0 = fee0bn;
  const max0 = inputToken0Base;

  // For token1 compute required pre-fee maxima via inverse fee
  const inv1 = await computeInverseTransferFee(connection, token1Mint, token1Amount);
  const max1 = inv1.transferAmount;
  const fee1 = inv1.transferFee;

  console.log("=== Deposit Quote ===");
  console.log("Implied LP:", impliedLp.toString());
  console.log(
    "Token0 post-fee needed:",
    token0Amount.toString(),
    "pre-fee provided:",
    max0.toString(),
    "transferFee:",
    fee0.toString(),
    "post-fee available:",
    postToken0.toString()
  );
  console.log(
    "Token1 post-fee needed:",
    token1Amount.toString(),
    "pre-fee max:",
    max1.toString(),
    "transferFee:",
    fee1.toString()
  );

  console.log("Debug: poolState.lpSupply:", (poolStateAcct.lpSupply ?? "<none>").toString());
  console.log("Debug: pool fees:", {
    protocolFeesToken0: poolStateAcct.protocolFeesToken0?.toString(),
    fundFeesToken0: poolStateAcct.fundFeesToken0?.toString(),
    creatorFeesToken0: poolStateAcct.creatorFeesToken0?.toString(),
    protocolFeesToken1: poolStateAcct.protocolFeesToken1?.toString(),
    fundFeesToken1: poolStateAcct.fundFeesToken1?.toString(),
    creatorFeesToken1: poolStateAcct.creatorFeesToken1?.toString(),
  });
  console.log("Debug: totalVaultsUsedByProgram:", totalVault0.toString(), totalVault1.toString());

  const confirm = await awaitConfirmation("Proceed with deposit transaction?");
  if (!confirm) {
    console.log("Aborted by user");
    process.exit(0);
  }

  // Build deposit instruction using Anchor program rpc. Accounts must match the on-chain instruction names.


  const token0Program = await detectTokenProgram(connection, token0Mint);
  const token1Program = await detectTokenProgram(connection, token1Mint);

  const ownerLpToken = getAssociatedTokenAddressSync(lpMint, owner.publicKey, false, TOKEN_PROGRAM_ID);
  const ownerToken0Account = getAssociatedTokenAddressSync(token0Mint, owner.publicKey, false, token0Program);
  const ownerToken1Account = getAssociatedTokenAddressSync(token1Mint, owner.publicKey, false, token1Program);

  // derive authority PDA
  const [authority] = await getAuthAddress(PROGRAM_ID);

  // Convert amounts to anchor.BN
  const impliedLpAnchor = new anchor.BN(impliedLp.toString());
  const max0Anchor = new anchor.BN(max0.toString());
  const max1Anchor = new anchor.BN(max1.toString());

  try {
    const tx = await program.methods
      .deposit(impliedLpAnchor, max0Anchor, max1Anchor)
      .accounts({
        owner: owner.publicKey,
        authority: authority,
        poolState: poolStatePubkey,
        ownerLpToken: ownerLpToken,
        token0Account: ownerToken0Account,
        token1Account: ownerToken1Account,
        token0Vault: token0Vault,
        token1Vault: token1Vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        vault0Mint: token0Mint,
        vault1Mint: token1Mint,
        lpMint: lpMint,
      })
      .signers([owner])
      .rpc();

    console.log("Transaction sent:", tx);
    process.exit(0);
  } catch (err: any) {
    console.error("Transaction failed:", err?.message ?? err);
    if (err?.logs) console.error(err.logs);
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
