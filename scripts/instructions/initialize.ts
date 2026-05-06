#!/usr/bin/env ts-node
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import idl from "../../target/idl/raydium_cp_swap.json";
import { createInterface } from "readline/promises";
import {
  getAuthAddress,
  getOrcleAccountAddress,
  getPoolAddress,
  getPoolLpMintAddress,
  getPoolVaultAddress,
} from "../../tests/utils/pda";

type Action = "derive-initialize-accounts" | "initialize";

const ACTION: Action = "initialize";
const RPC_URL = "https://api.devnet.solana.com";
const FEE_PAYER_WALLET_PATH = "/home/avinash_dubey/.config/solana/id.json";
const CREATOR_WALLET_PATH = "/home/avinash_dubey/.config/solana/creator-id.json";
const PROGRAM_ID = new PublicKey(""); // declare_id
const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");

const MINT_A = new PublicKey("2hDZv9TWejnGpLj7wTzjBeYtfZdip93x1hXj9FxjVfWe");
const MINT_B = new PublicKey("EwMHKeLwXxBcxamkkSxSwNhPr9KMgPLRDVHzN8sZhEou");

const CREATE_POOL_FEE_ACCOUNT = new PublicKey("63EqUEuqiLw9ZvJJsFECg5fN7bM9hBifUEYJFGhJtuCa");

const INIT_AMOUNT_0 = new BN(1000);
const INIT_AMOUNT_1 = new BN(1000);
const OPEN_TIME = new BN("0");

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

async function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) {
    throw new Error(`Mint not found on RPC: ${mint.toBase58()}`);
  }
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Unsupported mint owner for ${mint.toBase58()}: ${info.owner.toBase58()}`);
}

async function deriveInitializeAccounts(connection: Connection, creator: PublicKey) {
  const [authority] = await getAuthAddress(PROGRAM_ID);

  const [token0Mint, token1Mint] = sortMints(MINT_A, MINT_B);
  const token0Program = await detectTokenProgram(connection, token0Mint);
  const token1Program = await detectTokenProgram(connection, token1Mint);

  const [poolState] = await getPoolAddress(AMM_CONFIG, token0Mint, token1Mint, PROGRAM_ID);
  const [lpMint] = await getPoolLpMintAddress(poolState, PROGRAM_ID);
  const [token0Vault] = await getPoolVaultAddress(poolState, token0Mint, PROGRAM_ID);
  const [token1Vault] = await getPoolVaultAddress(poolState, token1Mint, PROGRAM_ID);
  const [observationState] = await getOrcleAccountAddress(poolState, PROGRAM_ID);

  const creatorToken0 = getAssociatedTokenAddressSync(token0Mint, creator, false, token0Program);
  const creatorToken1 = getAssociatedTokenAddressSync(token1Mint, creator, false, token1Program);
  const creatorLpToken = getAssociatedTokenAddressSync(lpMint, creator, false, TOKEN_PROGRAM_ID);

  return {
    // passed fields
    creator,
    ammConfig: AMM_CONFIG,

    // computed fields (PDA/ATA/program lookups)
    authority,
    poolState,
    token0Mint,
    token1Mint,
    lpMint,
    creatorToken0,
    creatorToken1,
    creatorLpToken,
    token0Vault,
    token1Vault,
    createPoolFee: CREATE_POOL_FEE_ACCOUNT,  // passed field
    observationState,
    tokenProgram: TOKEN_PROGRAM_ID,
    token0Program,
    token1Program,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };
}

async function assertExecutableProgram(connection: Connection, programId: PublicKey) {
  const info = await connection.getAccountInfo(programId, "confirmed");
  if (!info) {
    throw new Error(
      `Program account not found on this RPC/cluster: ${programId.toBase58()}`
    );
  }
  if (!info.executable) {
    throw new Error(
      `Account exists but is not executable: ${programId.toBase58()} (owner=${info.owner.toBase58()})`
    );
  }
}

async function requireInitializeConfirmation() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "YES" to execute initialize transaction: ')).trim();
  rl.close();

  if (answer.toLowerCase() !== "yes") {
    throw new Error("Initialize cancelled. Confirmation input was not YES.");
  }
}

// async function ensureCreatorTokenAccounts(
//   provider: anchor.AnchorProvider,
//   creator: PublicKey,
//   token0Mint: PublicKey,
//   token1Mint: PublicKey,
//   token0Program: PublicKey,
//   token1Program: PublicKey
// ) {
//   const creatorToken0 = getAssociatedTokenAddressSync(token0Mint, creator, false, token0Program);
//   const creatorToken1 = getAssociatedTokenAddressSync(token1Mint, creator, false, token1Program);
//   const ixs = [];

//   if (!(await provider.connection.getAccountInfo(creatorToken0, "confirmed"))) {
//     ixs.push(
//       createAssociatedTokenAccountIdempotentInstruction(
//         provider.wallet.publicKey,
//         creatorToken0,
//         creator,
//         token0Mint,
//         token0Program,
//         ASSOCIATED_TOKEN_PROGRAM_ID
//       )
//     );
//   }

//   if (!(await provider.connection.getAccountInfo(creatorToken1, "confirmed"))) {
//     ixs.push(
//       createAssociatedTokenAccountIdempotentInstruction(
//         provider.wallet.publicKey,
//         creatorToken1,
//         creator,
//         token1Mint,
//         token1Program,
//         ASSOCIATED_TOKEN_PROGRAM_ID
//       )
//     );
//   }

//   if (ixs.length === 0) return;

//   console.log(`Creating ${ixs.length} missing creator token account(s)...`);
//   const sig = await provider.sendAndConfirm(new Transaction().add(...ixs), []);
//   console.log(`ATA setup tx: ${sig}`);
// }

async function assertCreatePoolFeeAccount(connection: Connection) {
  const info = await connection.getAccountInfo(CREATE_POOL_FEE_ACCOUNT, "confirmed");
  if (!info) {
    throw new Error(
      `create_pool_fee account does not exist: ${CREATE_POOL_FEE_ACCOUNT.toBase58()}`
    );
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(
      `create_pool_fee must be a Token Program account, but owner is ${info.owner.toBase58()} at ${CREATE_POOL_FEE_ACCOUNT.toBase58()}`
    );
  }

  const tokenAcc = await getAccount(connection, CREATE_POOL_FEE_ACCOUNT, "confirmed", TOKEN_PROGRAM_ID);
  if (!tokenAcc.mint.equals(NATIVE_MINT)) {
    throw new Error(
      `create_pool_fee must be a wrapped SOL token account (mint ${NATIVE_MINT.toBase58()}), got mint ${tokenAcc.mint.toBase58()}`
    );
  }
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const feePayer = loadKeypair(FEE_PAYER_WALLET_PATH);
  const creator = loadKeypair(CREATOR_WALLET_PATH);

  // Use the fee payer as the provider wallet (feePayer pays tx fees).
  // Creator will be passed as an additional signer (creator may be charged for account creation per program).
  const wallet = new anchor.Wallet(feePayer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlAddress = (idl as any)?.address ? new PublicKey((idl as any).address) : null;
  if (idlAddress && !idlAddress.equals(PROGRAM_ID)) {
    console.warn(
      `Warning: IDL address (${idlAddress.toBase58()}) != configured PROGRAM_ID (${PROGRAM_ID.toBase58()}). Using PROGRAM_ID.`
    );
  }
  (idl as any).address = PROGRAM_ID.toBase58();
  await assertExecutableProgram(connection, PROGRAM_ID);

  // Force using configured program id instead of the idl embedded address.
  const program = new anchor.Program(idl, provider);

  const accounts = await deriveInitializeAccounts(connection, creator.publicKey);

  console.log("Passed input fields:");
  console.log(`feePayer: ${feePayer.publicKey.toBase58()}`);
  console.log(`creator: ${creator.publicKey.toBase58()}`);
  console.log(`ammConfig: ${AMM_CONFIG.toBase58()}`);
  console.log(`mintA: ${MINT_A.toBase58()}`);
  console.log(`mintB: ${MINT_B.toBase58()}`);
  console.log(`createPoolFee: ${CREATE_POOL_FEE_ACCOUNT.toBase58()}`);
  console.log(`initAmount0: ${INIT_AMOUNT_0.toString()}`);
  console.log(`initAmount1: ${INIT_AMOUNT_1.toString()}`);
  console.log(`openTime: ${OPEN_TIME.toString()}`);

  console.log("Derived initialize accounts:");
  for (const [k, v] of Object.entries(accounts)) {
    const out = v instanceof PublicKey ? v.toBase58() : String(v);
    console.log(`${k}: ${out}`);
  }

  if (ACTION === "initialize") {
    await requireInitializeConfirmation();
    await assertCreatePoolFeeAccount(connection);
    // Require canonical creator ATAs to already exist (do not create them here)
    try {
      await getAccount(connection, accounts.creatorToken0, "confirmed", accounts.token0Program);
    } catch (e) {
      throw new Error(
        `Missing creator ATA for token0: ${accounts.creatorToken0.toBase58()}. Create the ATA before running initialize.`
      );
    }

    try {
      await getAccount(connection, accounts.creatorToken1, "confirmed", accounts.token1Program);
    } catch (e) {
      throw new Error(
        `Missing creator ATA for token1: ${accounts.creatorToken1.toBase58()}. Create the ATA before running initialize.`
      );
    }
    console.log("\nSending initialize transaction...");
    const multiplier = new BN(10).pow(new BN(9)); // decimals
    const baseInitAmount0 = INIT_AMOUNT_0.mul(multiplier);
    const baseInitAmount1 = INIT_AMOUNT_1.mul(multiplier);
    try {
      const sig = await program.methods
        .initialize(baseInitAmount0, baseInitAmount1, OPEN_TIME)
        .accounts(accounts)
        .signers([creator])
        .rpc();
      console.log(`initialize tx: ${sig}`);
    } catch (err) {
      if (err instanceof SendTransactionError) {
        console.error("Initialize simulation failed:", err.message);
        const logs = await err.getLogs(connection).catch(() => null);
        if (logs?.length) {
          console.error("Simulation logs:");
          for (const line of logs) console.error(line);
        } else {
          console.error("No simulation logs returned.");
        }
      }
      throw err;
    }
  } else {
    console.log("\nACTION=derive-initialize-accounts, no transaction sent.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
