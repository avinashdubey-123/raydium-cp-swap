import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { ConstantProductCurve } from "../curve/constantProduct";
import { CpmmFee, computeTransferFeeForPre } from "../curve/fee";
import { getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getAuthAddress,
  getPoolAddress,
  getPoolVaultAddress,
} from "../../tests/utils/pda";
import idl from "../../target/idl/raydium_cp_swap.json";

async function loadKeypair(path: string): Promise<Keypair> {
  const fs = await import("fs/promises");
  const raw = await fs.readFile(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

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

async function main() {
  const RPC_URL = "https://api.devnet.solana.com";
  const FEE_PAYER_WALLET_PATH = "/home/avinash_dubey/.config/solana/creator-id.json";
  const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
  const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");
  const MINT_IN = new PublicKey("7Ru62uNfTEqx748XweWjLgjeJrT7KWjCsiocnK7Qqx9");
  const MINT_OUT = new PublicKey("FRYJVUuNHeH1jJ4D56TTgRZyFQ7jEQQdu1vpd4evdkPb");
  
  // amount to send (pre-fee) as BN base units
  const AMOUNT_IN = new BN("500000000000");

  const connection = new Connection(RPC_URL, "confirmed");
  const feePayer = await loadKeypair(FEE_PAYER_WALLET_PATH);
  const wallet = new anchor.Wallet(feePayer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider as any);

  const owner = feePayer;

  function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
    return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  }

  // canonical PDA uses token0 < token1 ordering
  const [token0, token1] = sortMints(MINT_IN, MINT_OUT);
  const [poolPda] = await getPoolAddress(AMM_CONFIG, token0, token1, PROGRAM_ID);

  const poolStatePubkey = poolPda;
  const [inputVault] = await getPoolVaultAddress(poolStatePubkey, MINT_IN, PROGRAM_ID);
  const [outputVault] = await getPoolVaultAddress(poolStatePubkey, MINT_OUT, PROGRAM_ID);

  // Preflight checks: print canonical PDA and derived-by-order PDA for debugging
  console.log("Derived PDAs:", {
    pool: poolPda.toBase58(),
    token0: token0.toBase58(),
    token1: token1.toBase58(),
  });
  console.log("Checking accounts:", { programId: PROGRAM_ID.toBase58(), ammConfig: AMM_CONFIG.toBase58(), poolState: poolStatePubkey.toBase58() });
  const poolStateInfo = await connection.getAccountInfo(poolStatePubkey);
  if (!poolStateInfo || poolStateInfo.data.length === 0) {
    console.error("PoolState account does not exist or has no data:", poolStatePubkey.toBase58());
    console.error("Possible causes: wrong AMM_CONFIG, swapped MINT_IN/MINT_OUT order, or incorrect PROGRAM_ID/cluster.");
    process.exit(1);
  }

  const poolState: any = await (program.account as any).poolState.fetch(poolStatePubkey);
  const ammConfigAcct: any = await (program.account as any).ammConfig.fetch(AMM_CONFIG);

  // BN-safe sum of fee counters for pool token0/token1
  const protocolFeesToken0 = new BN(poolState.protocolFeesToken0?.toString?.() ?? poolState.protocolFeesToken0 ?? 0);
  const fundFeesToken0 = new BN(poolState.fundFeesToken0?.toString?.() ?? poolState.fundFeesToken0 ?? 0);
  const creatorFeesToken0 = new BN(poolState.creatorFeesToken0?.toString?.() ?? poolState.creatorFeesToken0 ?? 0);

  const protocolFeesToken1 = new BN(poolState.protocolFeesToken1?.toString?.() ?? poolState.protocolFeesToken1 ?? 0);
  const fundFeesToken1 = new BN(poolState.fundFeesToken1?.toString?.() ?? poolState.fundFeesToken1 ?? 0);
  const creatorFeesToken1 = new BN(poolState.creatorFeesToken1?.toString?.() ?? poolState.creatorFeesToken1 ?? 0);

  // identify which vault is token0/token1 in pool_state
  const poolToken0Vault = new PublicKey(poolState.token0Vault?.toString?.() ?? poolState.token_0_vault ?? "11111111111111111111111111111111");
  const poolToken1Vault = new PublicKey(poolState.token1Vault?.toString?.() ?? poolState.token_1_vault ?? "11111111111111111111111111111111");
  // read the canonical pool vault balances (token0/token1) and compute totals used by program
  const poolToken0Acct = await getAccount(connection, poolToken0Vault);
  const poolToken1Acct = await getAccount(connection, poolToken1Vault);
  const poolVault0Amount = new BN(poolToken0Acct.amount.toString());
  const poolVault1Amount = new BN(poolToken1Acct.amount.toString());

  // determine totals for token0 and token1 (neutral naming) and whether input is token0
  const feesToken0 = protocolFeesToken0.add(fundFeesToken0).add(creatorFeesToken0);
  const feesToken1 = protocolFeesToken1.add(fundFeesToken1).add(creatorFeesToken1);
  if (feesToken0.gt(poolVault0Amount) || feesToken1.gt(poolVault1Amount)) {
    throw new Error("Pool state fee counters exceed vault balances (invalid state)");
  }

  // total0/total1 correspond to pool state's token0 and token1 totals used by program
  const total0 = poolVault0Amount.sub(feesToken0);
  const total1 = poolVault1Amount.sub(feesToken1);

  // Determine whether the input token corresponds to token0 in pool_state
  let inputIsToken0: boolean;
  if (inputVault.equals(poolToken0Vault)) {
    inputIsToken0 = true;
  } else if (inputVault.equals(poolToken1Vault)) {
    inputIsToken0 = false;
  } else {
    throw new Error("Invalid pool vault ordering: input vault does not match pool token vaults");
  }

  // Compute totals for the input/output ordering used in the curve functions
  const totalInputAmount = inputIsToken0 ? total0 : total1;
  const totalOutputAmount = inputIsToken0 ? total1 : total0;

  // creator fee selection: poolState.creator_fee_on values: 0=Both,1=OnlyToken0,2=OnlyToken1
  const creatorFeeOn = Number(poolState.creatorFeeOn ?? poolState.creator_fee_on ?? 0);
  let isCreatorFeeOnInput = false;
  if (creatorFeeOn === 0) isCreatorFeeOnInput = true;
  else if (creatorFeeOn === 1) isCreatorFeeOnInput = inputIsToken0;
  else if (creatorFeeOn === 2) isCreatorFeeOnInput = !inputIsToken0;

  // read rate fields from amm config (BN)
  const tradeFeeRate = new BN(ammConfigAcct.tradeFeeRate?.toString?.() ?? ammConfigAcct.trade_fee_rate ?? 0);
  const creatorFeeRate = new BN(ammConfigAcct.creatorFeeRate?.toString?.() ?? ammConfigAcct.creator_fee_rate ?? 0);
  const protocolFeeRate = new BN(ammConfigAcct.protocolFeeRate?.toString?.() ?? ammConfigAcct.protocol_fee_rate ?? 0);
  const fundFeeRate = new BN(ammConfigAcct.fundFeeRate?.toString?.() ?? ammConfigAcct.fund_fee_rate ?? 0);

  // compute input transfer fee (Token-2022)
  const inputTransferFee = await computeTransferFeeForPre(connection, MINT_IN, AMOUNT_IN);
  const actualAmountIn = AMOUNT_IN.sub(inputTransferFee);
  if (actualAmountIn.lte(new BN(0))) throw new Error("Input amount after transfer fee is zero");

  // replicate CurveCalculator::swap_base_input logic
  let creatorFee = new BN(0);
  let tradeFee: BN;
  let inputAmountLessFees: BN;

  if (isCreatorFeeOnInput) {
    const totalFee = CpmmFee.tradingFee(actualAmountIn, tradeFeeRate.add(creatorFeeRate));
    creatorFee = CpmmFee.splitCreatorFee(totalFee, tradeFeeRate, creatorFeeRate);
  tradeFee = totalFee.sub(creatorFee);
    inputAmountLessFees = actualAmountIn.sub(totalFee);
  } else {
    tradeFee = CpmmFee.tradingFee(actualAmountIn, tradeFeeRate);
    inputAmountLessFees = actualAmountIn.sub(tradeFee);
  }

  const protocolFee = CpmmFee.protocolFee(tradeFee, protocolFeeRate);
  const fundFee = CpmmFee.fundFee(tradeFee, fundFeeRate);

  const outputAmountSwapped = ConstantProductCurve.swapBaseInputWithoutFees(
    inputAmountLessFees,
    totalInputAmount,
    totalOutputAmount
  );

  let outputAmount = outputAmountSwapped;
  if (!isCreatorFeeOnInput) {
    const creatorFeeOnOutput = CpmmFee.creatorFee(outputAmountSwapped, creatorFeeRate);
    creatorFee = creatorFeeOnOutput;
    outputAmount = outputAmountSwapped.sub(creatorFeeOnOutput);
  }

  // compute output transfer fee and receive
  const outputTransferFee = await computeTransferFeeForPre(connection, MINT_OUT, outputAmount);
  const receiveAmount = outputAmount.sub(outputTransferFee);

  console.log("=== Swap Quote ===");
  console.log("Amount in (pre-fee):", AMOUNT_IN.toString());
  console.log("Input transfer fee:", inputTransferFee.toString(), "actual amount in:", actualAmountIn.toString());
  console.log("inputAmountLessFees:", inputAmountLessFees.toString());
  console.log("tradeFee:", tradeFee.toString(), "protocolFee:", protocolFee.toString(), "fundFee:", fundFee.toString(), "creatorFee:", creatorFee.toString());
  console.log("outputAmount (pre-transfer):", outputAmount.toString(), "outputTransferFee:", outputTransferFee.toString(), "receive:", receiveAmount.toString());

  const confirm = await awaitConfirmation("Proceed with swap transaction?");
  if (!confirm) {
    console.log("Aborted by user");
    process.exit(0);
  }

  const inputTokenProgram = (await connection.getAccountInfo(MINT_IN))?.owner?.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const outputTokenProgram = (await connection.getAccountInfo(MINT_OUT))?.owner?.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const inputTokenAccount = getAssociatedTokenAddressSync(MINT_IN, owner.publicKey, false, inputTokenProgram as PublicKey);
  const outputTokenAccount = getAssociatedTokenAddressSync(MINT_OUT, owner.publicKey, false, outputTokenProgram as PublicKey);

  // Ensure owner's associated token accounts exist (create idempotent ATAs if missing)
  const ataIxs: any[] = [];
  const inputAtaInfo = await connection.getAccountInfo(inputTokenAccount);
  if (!inputAtaInfo) {
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        provider.wallet.publicKey,
        inputTokenAccount,
        owner.publicKey,
        MINT_IN,
        inputTokenProgram as PublicKey,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  const outputAtaInfo = await connection.getAccountInfo(outputTokenAccount);
  if (!outputAtaInfo) {
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        provider.wallet.publicKey,
        outputTokenAccount,
        owner.publicKey,
        MINT_OUT,
        outputTokenProgram as PublicKey,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  if (ataIxs.length > 0) {
    console.log(`Creating ${ataIxs.length} missing ATA(s) for owner...`);
    const sig = await provider.sendAndConfirm(new Transaction().add(...ataIxs), []);
    console.log(`ATA setup tx: ${sig}`);
  }

  const [authority] = await getAuthAddress(PROGRAM_ID);

  try {
    console.log("Sending swap with:", { amount_in: AMOUNT_IN.toString(), minimum_amount_out: receiveAmount.toString() });
    const tx = await program.methods
      .swapBaseInput(new anchor.BN(AMOUNT_IN.toString()), new anchor.BN(receiveAmount.toString()))
      .accounts({
        payer: owner.publicKey,
        authority: authority,
        ammConfig: AMM_CONFIG,
        poolState: poolStatePubkey,
        inputTokenAccount,
        outputTokenAccount,
        inputVault: inputVault,
        outputVault: outputVault,
        inputTokenProgram: inputTokenProgram,
        outputTokenProgram: outputTokenProgram,
        inputTokenMint: MINT_IN,
        outputTokenMint: MINT_OUT,
        observationState: poolState.observationKey ?? poolState.observation_key,
      })
      .signers([owner])
      .rpc();

    console.log("Transaction sent:", tx);
    process.exit(0);
  } catch (err: any) {
    console.error("Transaction failed:", err?.message ?? err);
    if (err?.logs) console.error("Anchor logs:", err.logs);
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
