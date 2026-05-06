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
  const [permissionPda, bump] = await PublicKey.findProgramAddress([Buffer.from("permission"), permissionAuthority.toBuffer()], PROGRAM_ID);

  console.log("Permission PDA:", permissionPda.toBase58());

  const tx = await program.methods
    .closePermissionPda()
    .accounts({
      owner: admin.publicKey,
      permissionAuthority: permissionAuthority,
      permission: permissionPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("closePermissionPda tx:", tx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
