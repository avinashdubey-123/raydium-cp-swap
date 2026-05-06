import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const _encoder = new TextEncoder()

export const AMM_CONFIG_SEED = _encoder.encode("amm_config")
export const POOL_SEED = _encoder.encode("pool")
export const POOL_VAULT_SEED = _encoder.encode("pool_vault")
export const POOL_AUTH_SEED = _encoder.encode("vault_and_lp_mint_auth_seed")
export const POOL_LPMINT_SEED = _encoder.encode("pool_lp_mint")
export const TICK_ARRAY_SEED = _encoder.encode("tick_array")

export const OPERATION_SEED = _encoder.encode("operation")

export const ORACLE_SEED = _encoder.encode("observation")

export function u16ToBytes(num: number) {
  return new anchor.BN(num).toArrayLike(Uint8Array as any, 'le', 2)
}

export function i16ToBytes(num: number) {
  return new anchor.BN(num).toTwos(16).toArrayLike(Uint8Array as any, 'le', 2)
}

export function u32ToBytes(num: number) {
  return new anchor.BN(num).toArrayLike(Uint8Array as any, 'le', 4)
}

export function i32ToBytes(num: number) {
  return new anchor.BN(num).toTwos(32).toArrayLike(Uint8Array as any, 'le', 4)
}

export async function getAmmConfigAddress(
  index: number,
  programId: PublicKey
): Promise<[PublicKey, number]> {
  const [address, bump] = await PublicKey.findProgramAddress(
    [AMM_CONFIG_SEED, u16ToBytes(index)],
    programId
  );
  return [address, bump];
}

export async function getAuthAddress(
  programId: PublicKey
): Promise<[PublicKey, number]> {
  const [address, bump] = await PublicKey.findProgramAddress(
    [POOL_AUTH_SEED],
    programId
  );
  return [address, bump];
}

export async function getPoolAddress(
  ammConfig: PublicKey,
  tokenMint0: PublicKey,
  tokenMint1: PublicKey,
  programId: PublicKey
): Promise<[PublicKey, number]> {
  const [address, bump] = await PublicKey.findProgramAddress(
    [
      POOL_SEED,
      ammConfig.toBytes(),
      tokenMint0.toBytes(),
      tokenMint1.toBytes(),
    ],
    programId
  );
  return [address, bump];
}

export async function getPoolVaultAddress(
  pool: PublicKey,
  vaultTokenMint: PublicKey,
  programId: PublicKey
): Promise<[PublicKey, number]> {
  const [address, bump] = await PublicKey.findProgramAddress(
    [POOL_VAULT_SEED, pool.toBytes(), vaultTokenMint.toBytes()],
    programId
  );
  return [address, bump];
}

export async function getPoolLpMintAddress(
  pool: PublicKey,
  programId: PublicKey
): Promise<[PublicKey, number]> {
  const [address, bump] = await PublicKey.findProgramAddress(
    [POOL_LPMINT_SEED, pool.toBytes()],
    programId
  );
  return [address, bump];
}

export async function getOrcleAccountAddress(
  pool: PublicKey,
  programId: PublicKey
): Promise<[PublicKey, number]> {
  const [address, bump] = await PublicKey.findProgramAddress(
    [ORACLE_SEED, pool.toBytes()],
    programId
  );
  return [address, bump];
}
