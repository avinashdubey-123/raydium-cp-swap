import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { ConstantProductCurve } from "../curve/constantProduct";
import { CpmmFee, computeInverseTransferFee } from "../curve/fee";
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

// Swap-out script: user specifies desired receive (post-transfer) and we compute required max input
async function main() {
  const RPC_URL = "https://api.devnet.solana.com";
  const FEE_PAYER_WALLET_PATH = "/home/avinash_dubey/.config/solana/id1.json";
  const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
  const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");
  const MINT_IN = new PublicKey("DEzz2hBGDDPRC58WRpswFjYVH2M5BbhR9q6xVeTK2qKv");
  const MINT_OUT = new PublicKey("7Ru62uNfTEqx748XweWjLgjeJrT7KWjCsiocnK7Qqx9");

  // desired receive amount (post-transfer) in base units
  const DESIRED_RECEIVE = new BN("1000000000");

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

  const [token0, token1] = sortMints(MINT_IN, MINT_OUT);
  const [canonicalPoolPda] = await getPoolAddress(AMM_CONFIG, token0, token1, PROGRAM_ID);
  const poolStatePubkey = canonicalPoolPda;
  const [inputVault] = await getPoolVaultAddress(poolStatePubkey, MINT_IN, PROGRAM_ID);
  const [outputVault] = await getPoolVaultAddress(poolStatePubkey, MINT_OUT, PROGRAM_ID);

  const poolState: any = await (program.account as any).poolState.fetch(poolStatePubkey);
  const ammConfigAcct: any = await (program.account as any).ammConfig.fetch(AMM_CONFIG);

  const protocolFeesToken0 = new BN(poolState.protocolFeesToken0?.toString?.() ?? poolState.protocolFeesToken0 ?? 0);
  const fundFeesToken0 = new BN(poolState.fundFeesToken0?.toString?.() ?? poolState.fundFeesToken0 ?? 0);
  const creatorFeesToken0 = new BN(poolState.creatorFeesToken0?.toString?.() ?? poolState.creatorFeesToken0 ?? 0);

  const protocolFeesToken1 = new BN(poolState.protocolFeesToken1?.toString?.() ?? poolState.protocolFeesToken1 ?? 0);
  const fundFeesToken1 = new BN(poolState.fundFeesToken1?.toString?.() ?? poolState.fundFeesToken1 ?? 0);
  const creatorFeesToken1 = new BN(poolState.creatorFeesToken1?.toString?.() ?? poolState.creatorFeesToken1 ?? 0);

  const poolToken0Vault = new PublicKey(poolState.token0Vault?.toString?.() ?? poolState.token_0_vault ?? "11111111111111111111111111111111");
  const poolToken1Vault = new PublicKey(poolState.token1Vault?.toString?.() ?? poolState.token_1_vault ?? "11111111111111111111111111111111");
  const poolToken0Acct = await getAccount(connection, poolToken0Vault);
  const poolToken1Acct = await getAccount(connection, poolToken1Vault);
  const poolVault0Amount = new BN(poolToken0Acct.amount.toString());
  const poolVault1Amount = new BN(poolToken1Acct.amount.toString());

  const feesToken0 = protocolFeesToken0.add(fundFeesToken0).add(creatorFeesToken0);
  const feesToken1 = protocolFeesToken1.add(fundFeesToken1).add(creatorFeesToken1);
  if (feesToken0.gt(poolVault0Amount) || feesToken1.gt(poolVault1Amount)) {
    throw new Error("Pool state fee counters exceed vault balances (invalid state)");
  }

  const total0 = poolVault0Amount.sub(feesToken0);
  const total1 = poolVault1Amount.sub(feesToken1);

  // Determine whether inputVault corresponds to token0 in pool_state (like swap_base_input)
  let inputIsToken0: boolean;
  if (inputVault.equals(poolToken0Vault)) inputIsToken0 = true;
  else if (inputVault.equals(poolToken1Vault)) inputIsToken0 = false;
  else throw new Error("Invalid pool vault ordering: input vault does not match pool token vaults");

  const totalInputAmount = inputIsToken0 ? total0 : total1;
  const totalOutputAmount = inputIsToken0 ? total1 : total0;

  const creatorFeeOn = Number(poolState.creatorFeeOn ?? poolState.creator_fee_on ?? 0);
  let isCreatorFeeOnInput = false;
  if (creatorFeeOn === 0) isCreatorFeeOnInput = true;
  else if (creatorFeeOn === 1) isCreatorFeeOnInput = inputIsToken0;
  else if (creatorFeeOn === 2) isCreatorFeeOnInput = !inputIsToken0;

  const tradeFeeRate = new BN(ammConfigAcct.tradeFeeRate?.toString?.() ?? ammConfigAcct.trade_fee_rate ?? 0);
  const creatorFeeRate = new BN(ammConfigAcct.creatorFeeRate?.toString?.() ?? ammConfigAcct.creator_fee_rate ?? 0);
  const protocolFeeRate = new BN(ammConfigAcct.protocolFeeRate?.toString?.() ?? ammConfigAcct.protocol_fee_rate ?? 0);
  const fundFeeRate = new BN(ammConfigAcct.fundFeeRate?.toString?.() ?? ammConfigAcct.fund_fee_rate ?? 0);

  // Step 1: invert output transfer fee to get pre-transfer output amount
  const invOut = await computeInverseTransferFee(connection, MINT_OUT, DESIRED_RECEIVE);
  const preTransferOutput = invOut.transferAmount; // amount that should be produced by AMM before transfer
  const outputTransferFee = invOut.transferFee;

  // Step 2: account for creator fee placement
  let outputAmountSwapped = preTransferOutput; // amount expected from curve before creator deduction when creator on output
  let creatorFee = new BN(0);
  if (!isCreatorFeeOnInput) {
    // creator fee is taken on output: invert creator fee
    outputAmountSwapped = CpmmFee.calculatePreFeeAmount(preTransferOutput, creatorFeeRate);
    creatorFee = outputAmountSwapped.sub(preTransferOutput);
  }

  // Step 3: invert AMM curve to find input amount required by the curve (post-AMM-fees removed)
  const inputAmountLessFees = ConstantProductCurve.swapBaseOutputWithoutFees(
    outputAmountSwapped,
    totalInputAmount,
    totalOutputAmount
  );

  // Step 4: re-introduce AMM trading & creator fees on input side
  let actualAmountIn = new BN(0); // amount the pool must receive (after token transfer fees)
  let tradeFee = new BN(0);
  if (isCreatorFeeOnInput) {
    // total fee rate applies
    actualAmountIn = CpmmFee.calculatePreFeeAmount(inputAmountLessFees, tradeFeeRate.add(creatorFeeRate));
    const totalFee = actualAmountIn.sub(inputAmountLessFees);
    creatorFee = CpmmFee.splitCreatorFee(totalFee, tradeFeeRate, creatorFeeRate);
    tradeFee = totalFee.sub(creatorFee);
  } else {
    actualAmountIn = CpmmFee.calculatePreFeeAmount(inputAmountLessFees, tradeFeeRate);
    tradeFee = actualAmountIn.sub(inputAmountLessFees);
  }

  const protocolFee = CpmmFee.protocolFee(tradeFee, protocolFeeRate);
  const fundFee = CpmmFee.fundFee(tradeFee, fundFeeRate);

  // Step 5: invert transfer fee on input to compute required pre-fee input the user must provide
  const invIn = await computeInverseTransferFee(connection, MINT_IN, actualAmountIn);
  const maxInputPreFee = invIn.transferAmount;
  const inputTransferFee = invIn.transferFee;

  console.log("=== Swap-Out Quote ===");
  console.log("Desired receive (post-transfer):", DESIRED_RECEIVE.toString());
  console.log("Pre-transfer output needed:", preTransferOutput.toString(), "transferFee:", outputTransferFee.toString());
  console.log("Output swapped (pre-creator if applicable):", outputAmountSwapped.toString(), "creatorFee:", creatorFee.toString());
  console.log("Input required to curve (post-AMM-fees removed):", inputAmountLessFees.toString());
  console.log("Actual amount pool must receive (after transfer):", actualAmountIn.toString(), "tradeFee:", tradeFee.toString(), "protocolFee:", protocolFee.toString(), "fundFee:", fundFee.toString());
  console.log("Max pre-fee input to provide:", maxInputPreFee.toString(), "inputTransferFee:", inputTransferFee.toString());

  const confirm = await awaitConfirmation("Proceed with swap (submit transaction using max input pre-fee)?");
  if (!confirm) {
    console.log("Aborted by user");
    process.exit(0);
  }

  const inputTokenProgram = (await connection.getAccountInfo(MINT_IN))?.owner?.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const outputTokenProgram = (await connection.getAccountInfo(MINT_OUT))?.owner?.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const inputTokenAccount = getAssociatedTokenAddressSync(MINT_IN, owner.publicKey, false, inputTokenProgram as PublicKey);
  const outputTokenAccount = getAssociatedTokenAddressSync(MINT_OUT, owner.publicKey, false, outputTokenProgram as PublicKey);

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
    console.log("Sending swap with (max_input_pre_fee):", maxInputPreFee.toString(), "desired_receive:", DESIRED_RECEIVE.toString());
    const tx = await program.methods
      .swapBaseOutput(new anchor.BN(maxInputPreFee.toString()), new anchor.BN(DESIRED_RECEIVE.toString()))
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
