import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { ConstantProductCurve } from "../curve/constantProduct";
import { getMint, getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, calculateEpochFee } from "@solana/spl-token";
import {
  getAuthAddress,
  getPoolAddress,
  getPoolVaultAddress,
  getPoolLpMintAddress,
} from "../../tests/utils/pda";
import { RoundDirection } from "../curve/calculator";
import { computeTransferFeeForPre  } from "../curve/fee";
import idl from "../../target/idl/raydium_cp_swap.json";

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

async function loadKeypair(path: string): Promise<Keypair> {
  const fs = await import("fs/promises");
  const raw = await fs.readFile(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

// Inline transfer fee calc for a known pre-fee amount (operates on base units)


async function main() {
  const RPC_URL = "https://api.devnet.solana.com";
  const FEE_PAYER_WALLET_PATH = "/home/avinash_dubey/.config/solana/id.json";
  const CREATOR_WALLET_PATH = "/home/avinash_dubey/.config/solana/creator-id.json";
  const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
  const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");
  const MINT_A = new PublicKey("DEzz2hBGDDPRC58WRpswFjYVH2M5BbhR9q6xVeTK2qKv");
  const MINT_B = new PublicKey("7Ru62uNfTEqx748XweWjLgjeJrT7KWjCsiocnK7Qqx9");

  const ownerKeypairPath = CREATOR_WALLET_PATH;

  const connection = new Connection(RPC_URL, "confirmed");
  const feePayer = await loadKeypair(FEE_PAYER_WALLET_PATH);
  const wallet = new anchor.Wallet(feePayer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider as any);

  // Withdraw percentage (basis points). e.g. 2500 = 25.00%
  const withdrawPercentBps = new BN(5000);

  if (!ownerKeypairPath) throw new Error("OWNER_KEYPAIR must be set to keypair path");
  const owner = await loadKeypair(ownerKeypairPath);

  const [token0Mint, token1Mint] = Buffer.compare(MINT_A.toBuffer(), MINT_B.toBuffer()) < 0 ? [MINT_A, MINT_B] : [MINT_B, MINT_A];

  const [poolStatePubkey] = await getPoolAddress(AMM_CONFIG, token0Mint, token1Mint, PROGRAM_ID);
  const [lpMint] = await getPoolLpMintAddress(poolStatePubkey, PROGRAM_ID);
  const [token0Vault] = await getPoolVaultAddress(poolStatePubkey, token0Mint, PROGRAM_ID);
  const [token1Vault] = await getPoolVaultAddress(poolStatePubkey, token1Mint, PROGRAM_ID);

  const vault0Acct = await getAccount(connection, token0Vault);
  const vault1Acct = await getAccount(connection, token1Vault);

  const poolVault0Amount = new BN(vault0Acct.amount.toString());
  const poolVault1Amount = new BN(vault1Acct.amount.toString());

  const lpMintAcct = await getMint(connection, lpMint);
  const lpSupply = new BN(lpMintAcct.supply.toString());

  // Fetch on-chain pool state to compute vault totals the program uses
  const poolStateAcct: any = await (program.account as any).poolState.fetch(poolStatePubkey);


  // Derive owner LP ATA and read user's LP balance
  const lpTokenProgram = (await connection.getAccountInfo(lpMint))?.owner?.equals(TOKEN_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
  const ownerLpToken = getAssociatedTokenAddressSync(lpMint, owner.publicKey, false, lpTokenProgram as PublicKey);
  const ownerLpAcct = await getAccount(connection, ownerLpToken);
  const ownerLpBalance = new BN(ownerLpAcct.amount.toString());

  // Compute burn amount = ceil(balance * percentBps / 10000) to honor requested percent
  const lpInput = ownerLpBalance
    .mul(withdrawPercentBps)
    .add(new BN(10000).sub(new BN(1)))
    .div(new BN(10000));

  // Compute totals without accumulated fees as the program does (BN-safe)
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

  // Use the pool state's authoritative lp_supply (the program uses this, not mint supply)
  const lpSupplyFromState = new BN(poolStateAcct.lpSupply?.toString?.() ?? lpMintAcct.supply.toString());

  const results = ConstantProductCurve.lpTokensToTradingTokens(
    lpInput,
    lpSupplyFromState,
    totalVault0,
    totalVault1,
    // Floor rounding to match on-chain withdraw
    RoundDirection.Floor
  );

  const token0Amount = results.tokenAmount0;
  const token1Amount = results.tokenAmount1;

  // compute transfer fees for pre-fee token amounts (matching on-chain get_transfer_fee)
  const fee0 = await computeTransferFeeForPre(connection, token0Mint, token0Amount);
  const fee1 = await computeTransferFeeForPre(connection, token1Mint, token1Amount);

  const receive0 = token0Amount.sub(fee0);
  const receive1 = token1Amount.sub(fee1);

  console.log("=== Withdraw Quote ===");
  console.log("Owner LP balance:", ownerLpBalance.toString());
  console.log(
    "Requested LP percent (bps):",
    withdrawPercentBps.toString(),
    `(${withdrawPercentBps.toNumber() / 100}%)`
  );
  console.log("LP to burn (amount):", lpInput.toString());
  console.log("Token0 liquidity to be removed (pre-fee):", token0Amount.toString(), "fee:", fee0.toString(), "receive:", receive0.toString());
  console.log("Token1 liquidity to be removed (pre-fee):", token1Amount.toString(), "fee:", fee1.toString(), "receive:", receive1.toString());

  // Extra debug prints to help trace slippage/fee mismatch
  console.log("Debug: lpSupply(mint):", lpSupply.toString(), "lpSupply(pool_state):", (poolStateAcct.lpSupply ?? "<none>").toString());
  console.log("Debug: poolState fees:", {
    protocolFeesToken0: poolStateAcct.protocolFeesToken0?.toString(),
    fundFeesToken0: poolStateAcct.fundFeesToken0?.toString(),
    creatorFeesToken0: poolStateAcct.creatorFeesToken0?.toString(),
    protocolFeesToken1: poolStateAcct.protocolFeesToken1?.toString(),
    fundFeesToken1: poolStateAcct.fundFeesToken1?.toString(),
    creatorFeesToken1: poolStateAcct.creatorFeesToken1?.toString(),
  });
  console.log("Debug: totalVaultsUsedByProgram:", totalVault0.toString(), totalVault1.toString());
  console.log("Debug: rawVaults:", poolVault0Amount.toString(), poolVault1Amount.toString());

  const confirm = await awaitConfirmation("Proceed with withdraw transaction?");
  if (!confirm) {
    console.log("Aborted by user");
    process.exit(0);
  }

  const token0Program = (await connection.getAccountInfo(token0Mint))?.owner?.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const token1Program = (await connection.getAccountInfo(token1Mint))?.owner?.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const ownerToken0Account = getAssociatedTokenAddressSync(token0Mint, owner.publicKey, false, token0Program as PublicKey);
  const ownerToken1Account = getAssociatedTokenAddressSync(token1Mint, owner.publicKey, false, token1Program as PublicKey);

  const [authority] = await getAuthAddress(PROGRAM_ID);

  try {
    console.log("Sending withdraw with:", { lpInput: lpInput.toString(), minimum_token_0: receive0.toString(), minimum_token_1: receive1.toString() });
    const tx = await program.methods
      // Pass post-fee minima: the program computes transfer fees and checks received amounts
      .withdraw(new anchor.BN(lpInput.toString()), new anchor.BN(receive0.toString()), new anchor.BN(receive1.toString()))
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
        memoProgram: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      })
      .signers([owner])
      .rpc();

    console.log("Transaction sent:", tx);
    process.exit(0);
  } catch (err: any) {
    console.error("Transaction failed:", err?.message ?? err);
    if (err?.logs) console.error("Anchor logs:", err.logs);
    // If this is an Anchor SendTransactionError, attempt to fetch simulation logs
    if (typeof (err as any).getLogs === "function") {
      try {
        const simLogs = await (err as any).getLogs(connection);
        console.error("Simulation logs:", simLogs);
      } catch (e) {
        console.error("Failed to fetch simulation logs:", e);
      }
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
