import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import idl from "../../../target/idl/raydium_cp_swap.json";

const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
const ADMIN_KEYPAIR_PATH = "/home/avinash_dubey/.config/solana/id.json";
const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");

function loadKeypair(path: string) {
  const raw = fs.readFileSync(path, "utf8");
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);

  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider as any);

  // Choose param/value to update. See program docs: 0=trade_fee_rate,1=protocol_fee_rate,2=fund_fee_rate,3=set_protocol_owner,4=set_fund_owner,5=create_pool_fee,6=disable_create_pool,7=creator_fee_rate
  const PARAM = 0; // example: trade fee rate
  const VALUE = 500; // example numeric value

  // If PARAM is 3 or 4 (set owner), set NEW_OWNER_PUBKEY to pass as remaining account
  const NEW_OWNER_PUBKEY: PublicKey | null = null; // e.g. new PublicKey("...")

  const txBuilder = program.methods.updateAmmConfig(PARAM, new anchor.BN(VALUE));

  let tx = txBuilder.accounts({ owner: admin.publicKey, ammConfig: AMM_CONFIG });
  if (NEW_OWNER_PUBKEY) {
    tx = (tx as any).remainingAccounts([{ pubkey: NEW_OWNER_PUBKEY, isWritable: false, isSigner: false }]);
  }

  const sig = await (tx as any).rpc();
  console.log("updateAmmConfig tx:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
