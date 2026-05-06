import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import fs from "fs";
import idl from "../../target/idl/raydium_cp_swap.json";
import { getPoolAddress, getPoolVaultAddress, getAuthAddress, getOrcleAccountAddress } from "../../tests/utils/pda";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");
const CREATOR_KEYPATH = "/home/avinash_dubey/.config/solana/creator-id.json";
const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");
const MINT_A = new PublicKey("FRYJVUuNHeH1jJ4D56TTgRZyFQ7jEQQdu1vpd4evdkPb");
const MINT_B = new PublicKey("7Ru62uNfTEqx748XweWjLgjeJrT7KWjCsiocnK7Qqx9");

function loadKeypair(path: string) {
  const raw = fs.readFileSync(path, "utf8");
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

async function main() {
  const creator = loadKeypair(CREATOR_KEYPATH);
  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com", "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(creator), {});
  anchor.setProvider(provider);

  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as any, provider as any);

  const [token0, token1] = sortMints(MINT_A, MINT_B);
  const [poolState] = await getPoolAddress(AMM_CONFIG, token0, token1, PROGRAM_ID);
  const [token0Vault] = await getPoolVaultAddress(poolState, token0, PROGRAM_ID);
  const [token1Vault] = await getPoolVaultAddress(poolState, token1, PROGRAM_ID);
  const [authority] = await getAuthAddress(PROGRAM_ID);

  const token0Program = (await connection.getAccountInfo(token0))?.owner?.equals(TOKEN_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
  const token1Program = (await connection.getAccountInfo(token1))?.owner?.equals(TOKEN_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;

  const creatorToken0 = getAssociatedTokenAddressSync(token0, creator.publicKey, false, token0Program);
  const creatorToken1 = getAssociatedTokenAddressSync(token1, creator.publicKey, false, token1Program);

  const sig = await program.methods
    .collectCreatorFee()
    .accounts({
      creator: creator.publicKey,
      authority: authority,
      poolState: poolState,
      ammConfig: AMM_CONFIG,
      token0Vault: token0Vault,
      token1Vault: token1Vault,
      vault0Mint: token0,
      vault1Mint: token1,
      creatorToken0: creatorToken0,
      creatorToken1: creatorToken1,
      token0Program: token0Program,
      token1Program: token1Program,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([])
    .rpc();

  console.log("collectCreatorFee tx:", sig);
}

main().catch((e) => { console.error(e); process.exit(1); });
