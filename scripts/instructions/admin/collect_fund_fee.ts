import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, Transaction } from "@solana/web3.js";
import fs from "fs";
import idl from "../../../target/idl/raydium_cp_swap.json";
import { getPoolAddress, getPoolVaultAddress, getAuthAddress, getOrcleAccountAddress } from "../../../tests/utils/pda";
import { getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
const OWNER_KEYPATH = "/home/avinash_dubey/.config/solana/id.json";
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

async function detectTokenProgram(connection: Connection, mint: PublicKey) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Unsupported mint owner for ${mint.toBase58()}: ${info.owner.toBase58()}`);
}

async function main() {
  const owner = loadKeypair(OWNER_KEYPATH);
  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {});
  anchor.setProvider(provider);

  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider as any);

  const [token0, token1] = sortMints(MINT_A, MINT_B);
  const [poolState] = await getPoolAddress(AMM_CONFIG, token0, token1, PROGRAM_ID);
  const [token0Vault] = await getPoolVaultAddress(poolState, token0, PROGRAM_ID);
  const [token1Vault] = await getPoolVaultAddress(poolState, token1, PROGRAM_ID);
  const [authority] = await getAuthAddress(PROGRAM_ID);

  const vault0 = await getAccount(connection, token0Vault);
  const vault1 = await getAccount(connection, token1Vault);
  const vault0Mint = vault0.mint;
  const vault1Mint = vault1.mint;

  const recipient0 = getAssociatedTokenAddressSync(vault0Mint, owner.publicKey, false, await detectTokenProgram(connection, vault0Mint));
  const recipient1 = getAssociatedTokenAddressSync(vault1Mint, owner.publicKey, false, await detectTokenProgram(connection, vault1Mint));

  const ixs: any[] = [];
  if (!(await connection.getAccountInfo(recipient0))) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, recipient0, owner.publicKey, vault0Mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  if (!(await connection.getAccountInfo(recipient1))) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, recipient1, owner.publicKey, vault1Mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  if (ixs.length > 0) {
    const sig = await provider.sendAndConfirm(new Transaction().add(...ixs), []);
    console.log(`Created ${ixs.length} ATA(s): ${sig}`);
  }

  const ps: any = await (program.account as any).poolState.fetch(poolState);
  const requested0 = ps.fundFeesToken0 ?? ps.fund_fees_token_0 ?? 0;
  const requested1 = ps.fundFeesToken1 ?? ps.fund_fees_token_1 ?? 0;

  const sig = await program.methods.collectFundFee(new anchor.BN(requested0.toString()), new anchor.BN(requested1.toString()))
    .accounts({
      owner: owner.publicKey,
      authority: authority,
      poolState: poolState,
      ammConfig: AMM_CONFIG,
      token0Vault: token0Vault,
      token1Vault: token1Vault,
      vault0Mint: vault0Mint,
      vault1Mint: vault1Mint,
      recipientToken0Account: recipient0,
      recipientToken1Account: recipient1,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();

  console.log("collectFundFee tx:", sig);
}

main().catch((e) => { console.error(e); process.exit(1); });
