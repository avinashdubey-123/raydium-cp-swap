#!/usr/bin/env ts-node
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  // getOrCreateAssociatedTokenAccount,
  // mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

type MintTrackerEntry = {
  timestamp: string;
  rpc: string;
  mint: string;
  recipient: string;
  ata: string;
  amountTokens: string;
  amountBaseUnits: string;
  txSignature: string;
};

type MintTrackerFile = {
  entries: MintTrackerEntry[];
};

function usage() {
  console.log(`Usage:
  env RPC_URL=http://127.0.0.1:8899 PAYER=./payer.json DECIMALS=9 MINT=new RECIPIENTS=addr1,addr2 AMOUNT=1000 npx ts-node scripts/mint/create_and_mint.ts

Or pass args:
  npx ts-node scripts/mint/create_and_mint.ts <PAYER_KEYPAIR_PATH> <DECIMALS> <MINT|new> <RECIPIENTS(comma)> <AMOUNT>
`);
}

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf8");
  const arr = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function appendTrackerEntry(entry: MintTrackerEntry) {
  const trackerPath = path.resolve(__dirname, "..", "mint_ata_tracker.json");
  const initialData: MintTrackerFile = { entries: [] };
  let data: MintTrackerFile = initialData;

  if (fs.existsSync(trackerPath)) {
    try {
      const raw = fs.readFileSync(trackerPath, "utf8");
      const parsed = JSON.parse(raw) as MintTrackerFile;
      if (Array.isArray(parsed.entries)) {
        data = parsed;
      }
    } catch (err) {
      console.warn("Tracker file is invalid JSON. Reinitializing tracker file.");
    }
  }

  data.entries.push(entry);
  fs.writeFileSync(trackerPath, JSON.stringify(data, null, 2));
  console.log(`Tracker updated: ${trackerPath}`);
}

async function main() {
  // Hardcoded configuration (edit these values directly)
  const rpc = "https://api.devnet.solana.com"; // RPC endpoint
  const payerPath = "/home/avinash_dubey/.config/solana/id1.json"; // path to payer keypair JSON (no trailing space)
  const decimals = 9; // mint decimals
  const mintArg: string = "288X3QggojQrXfVRuxah5F6PWTBxJkdLnQ8YbUNGrkjT"; // "new" or existing mint pubkey string
  // Single recipient: format "ADDRESS" or "ADDRESS:AMOUNT" (amount in token units)
  const recipientArg: string = "F8j5MGtzkWcu4BsNtFHjokcYDyyik31nQ9M8GSbdiXgy:2000"; // <<< REPLACE before running

  if (recipientArg.includes("REPLACE_WITH_RECIPIENT_PUBKEY")) {
    console.error("Please edit scripts/mint/create_and_mint.ts and set `recipientArg` to a real recipient pubkey before running.");
    process.exit(1);
  }

  // Load payer keypair
  if (!fs.existsSync(payerPath)) {
    console.error(`PAYER keypair file not found: ${payerPath}`);
    process.exit(1);
  }
  const payer = loadKeypair(payerPath);
  const conn = new Connection(rpc, "confirmed");

  let mintPubkey: PublicKey;
  if (mintArg === "new") {
    console.log("Creating new mint...");
    mintPubkey = await createMint(conn, payer, payer.publicKey, null, decimals);
    console.log("Created mint:", mintPubkey.toBase58());
  } else {
    try {
      mintPubkey = new PublicKey(mintArg);
    } catch (err) {
      console.error("Invalid MINT pubkey:", mintArg);
      process.exit(1);
    }
    console.log("Using existing mint:", mintPubkey.toBase58());
  }

  // Parse single recipient (optional per-recipient amount)
  const parts = recipientArg.split(":");
  const recipientAddr = parts[0].trim();
  const recipientAmountStr = parts[1] ? parts[1].trim() : "1000";
  let recipientPubkey: PublicKey;
  try {
    recipientPubkey = new PublicKey(recipientAddr);
  } catch (err) {
    console.error("Invalid recipient pubkey:", recipientAddr);
    process.exit(1);
  }

  const recipientAmountTokens = BigInt(recipientAmountStr);
  const multiplier = BigInt(10) ** BigInt(decimals);
  const amountBase = recipientAmountTokens * multiplier;
  if (amountBase > BigInt(Number.MAX_SAFE_INTEGER)) {
    console.warn(`Amount for ${recipientPubkey.toBase58()} exceeds Number.MAX_SAFE_INTEGER; operation may fail.`);
  }
  const amountNumber = Number(amountBase);

  const mintInfo = await conn.getAccountInfo(mintPubkey)

  const tokenProgram = mintInfo?.owner.equals(TOKEN_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : (await import("@solana/spl-token")).TOKEN_2022_PROGRAM_ID

  console.log(`Ensuring ATA and minting to ${recipientPubkey.toBase58()}`);
  const ataAddress = getAssociatedTokenAddressSync(
    mintPubkey,
    recipientPubkey,
    false,
    tokenProgram
  );
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    ataAddress,
    recipientPubkey,
    mintPubkey,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const mintIx = createMintToInstruction(
    mintPubkey,
    ataAddress,
    payer.publicKey,
    amountBase,
    [],
    tokenProgram
  );

  const tx = new (await import("@solana/web3.js")).Transaction();
  tx.add(ataIx, mintIx);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const signed = await (await import("@solana/web3.js")).sendAndConfirmTransaction(conn, tx, [payer]);
  console.log(`Mint tx: ${signed}`);

  appendTrackerEntry({
    timestamp: new Date().toISOString(),
    rpc,
    mint: mintPubkey.toBase58(),
    recipient: recipientPubkey.toBase58(),
    ata: ataAddress.toBase58(),
    amountTokens: recipientAmountTokens.toString(),
    amountBaseUnits: amountBase.toString(),
    txSignature: signed,
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
