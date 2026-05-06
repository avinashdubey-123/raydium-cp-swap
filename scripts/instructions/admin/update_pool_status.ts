import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import fs from "fs";
import idl from "../../../target/idl/raydium_cp_swap.json";
import { getPoolAddress, getAuthAddress } from "../../../tests/utils/pda";

const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
const ADMIN_KEYPAIR_PATH = "/home/avinash_dubey/.config/solana/id.json";
const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");
const MINT_A = new PublicKey("DEzz2hBGDDPRC58WRpswFjYVH2M5BbhR9q6xVeTK2qKv");
const MINT_B = new PublicKey("7Ru62uNfTEqx748XweWjLgjeJrT7KWjCsiocnK7Qqx9");

function loadKeypair(path: string) {
  const raw = fs.readFileSync(path, "utf8");
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

async function main() {
  const admin = loadKeypair(ADMIN_KEYPAIR_PATH);
  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {});
  anchor.setProvider(provider);

  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider as any);

  const [token0, token1] = sortMints(MINT_A, MINT_B);
  const [poolState] = await getPoolAddress(AMM_CONFIG, token0, token1, PROGRAM_ID);

  const STATUS = 1; // example new status (u8)

  const sig = await program.methods.updatePoolStatus(STATUS).accounts({ authority: admin.publicKey, poolState: poolState }).rpc();
  console.log("updatePoolStatus tx:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
