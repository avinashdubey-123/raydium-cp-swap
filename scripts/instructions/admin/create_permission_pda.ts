import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");

// Hardcoded values (copied from scripts/instructions/initialize.ts)
const ADMIN_KEYPAIR_PATH = "/home/avinash_dubey/.config/solana/id.json";
const CREATOR_KEYPAIR_PATH = "/home/avinash_dubey/.config/solana/id1.json";

function loadKeypair(keypairPath?: string) {
  const p = keypairPath || path.join(process.env.HOME || "", ".config/solana/id.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(raw));
}

async function main() {
  // Use hardcoded values defined above
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  const permissionAuthorityKeypair = loadKeypair(CREATOR_KEYPAIR_PATH);

  const connection = new anchor.web3.Connection("https://api.devnet.solana.com");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/raydium_cp_swap.json", "utf8")
  );
  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider);

  const permissionAuthority = permissionAuthorityKeypair.publicKey;
  const [permissionPda] = PublicKey.findProgramAddressSync([Buffer.from("permission"), permissionAuthority.toBuffer()], PROGRAM_ID);

  console.log("Permission PDA:", permissionPda.toBase58());
  // If the PDA account already exists, skip creating it to avoid "Allocate ... already in use".
  const existing = await provider.connection.getAccountInfo(permissionPda, "confirmed");
  if (existing) {
    console.log("Permission PDA already exists, skipping creation:", permissionPda.toBase58());
    return;
  }

  try {
    const tx = await program.methods
      .createPermissionPda()
      .accounts({
        owner: admin.publicKey,
        permissionAuthority: permissionAuthority,
        permission: permissionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("createPermissionPda tx:", tx);
  } catch (err: any) {
    // If Anchor's SendTransactionError is thrown, try to print simulation logs for debugging.
    if (typeof err?.getLogs === "function") {
      console.error("Transaction failed:", err.message ?? err);
      const logs = await err.getLogs(provider.connection).catch(() => null);
      if (logs) {
        console.error("Simulation logs:");
        for (const l of logs) console.error(l);
      }
    } else if (err?.transactionLogs) {
      console.error("Transaction logs:", err.transactionLogs);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
