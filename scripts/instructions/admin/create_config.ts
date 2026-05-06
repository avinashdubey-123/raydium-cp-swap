#!/usr/bin/env ts-node
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
} from "@solana/web3.js";
import fs from "fs";
import idl from "../../../target/idl/raydium_cp_swap.json";
import { createInterface } from "readline/promises";
import { getAmmConfigAddress } from "../../../tests/utils/pda";

const RPC_URL = "https://api.devnet.solana.com";
const FEE_PAYER_WALLET_PATH = "/home/avinash_dubey/.config/solana/id.json";
const OWNER_WALLET_PATH = "/home/avinash_dubey/.config/solana/id.json";
const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");

// Requested config values for index 1
const INDEX = 1;
const TRADE_FEE_RATE = new BN("2500");
const PROTOCOL_FEE_RATE = new BN("120000");
const FUND_FEE_RATE = new BN("40000");
const CREATOR_FEE_RATE = new BN("500");
const CREATE_POOL_FEE = new BN("150000000");

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function requireCreateAmmConfigConfirmation() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "YES" to send createAmmConfig transaction: ')).trim();
  rl.close();

  if (answer.toLowerCase() !== "yes") {
    throw new Error("createAmmConfig cancelled. Confirmation input was not YES.");
  }
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const feePayer = loadKeypair(FEE_PAYER_WALLET_PATH);
  const owner = loadKeypair(OWNER_WALLET_PATH);

  const wallet = new anchor.Wallet(feePayer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider);

  const [ammConfig] = await getAmmConfigAddress(INDEX, PROGRAM_ID);
  const existing = await connection.getAccountInfo(ammConfig, "confirmed");

  console.log("Create AMM config request:");
  console.log(`programId: ${PROGRAM_ID.toBase58()}`);
  console.log(`index: ${INDEX}`);
  console.log(`ammConfig: ${ammConfig.toBase58()}`);
  console.log(`owner: ${owner.publicKey.toBase58()}`);
  console.log(`tradeFeeRate: ${TRADE_FEE_RATE.toString()}`);
  console.log(`protocolFeeRate: ${PROTOCOL_FEE_RATE.toString()}`);
  console.log(`fundFeeRate: ${FUND_FEE_RATE.toString()}`);
  console.log(`creatorFeeRate: ${CREATOR_FEE_RATE.toString()}`);
  console.log(`createPoolFee: ${CREATE_POOL_FEE.toString()}`);

  if (existing) {
    console.log("AMM config already exists for this index. No transaction sent.");
    return;
  }

  await requireCreateAmmConfigConfirmation();

  let sig: string;
  try {
    sig = await program.methods
      .createAmmConfig(
        INDEX,
        TRADE_FEE_RATE,
        PROTOCOL_FEE_RATE,
        FUND_FEE_RATE,
        CREATE_POOL_FEE,
        CREATOR_FEE_RATE
      )
      .accounts({
        owner: owner.publicKey,
        ammConfig,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
  } catch (err) {
    if (err instanceof SendTransactionError) {
      console.error("createAmmConfig simulation failed:", err.message);
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

  console.log(`createAmmConfig tx: ${sig}`);
  console.log(`created ammConfig: ${ammConfig.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
