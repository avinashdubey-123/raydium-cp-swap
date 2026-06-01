import { useCallback } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

type BuildEnsureAtaParams = {
  owner: PublicKey
  mint: PublicKey
  payer?: PublicKey
  tokenProgram?: PublicKey
  allowOwnerOffCurve?: boolean
}

type BuildEnsureAtaResult = {
  ata: PublicKey
  tokenProgram: PublicKey
  instruction: TransactionInstruction | null
  exists: boolean
}

export default function useTokenProgramAta() {
  const { connection } = useConnection()
  const wallet = useWallet()

  const detectTokenProgram = useCallback(async (mint: PublicKey): Promise<PublicKey> => {
    const info = await connection.getAccountInfo(mint)
    if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`)
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
    return TOKEN_PROGRAM_ID
  }, [connection])

  const deriveAta = useCallback((
    owner: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey,
    allowOwnerOffCurve = false,
  ): PublicKey => {
    return getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, tokenProgram)
  }, [])

  const buildEnsureAtaInstruction = useCallback(async ({
    owner,
    mint,
    payer,
    tokenProgram,
    allowOwnerOffCurve = false,
  }: BuildEnsureAtaParams): Promise<BuildEnsureAtaResult> => {
    const resolvedProgram = tokenProgram ?? await detectTokenProgram(mint)
    const resolvedPayer = payer ?? wallet.publicKey
    if (!resolvedPayer) throw new Error('Wallet not connected for ATA creation')

    const ata = deriveAta(owner, mint, resolvedProgram, allowOwnerOffCurve)
    const existing = await connection.getAccountInfo(ata)
    if (existing) {
      return { ata, tokenProgram: resolvedProgram, instruction: null, exists: true }
    }

    const instruction = createAssociatedTokenAccountIdempotentInstruction(
      resolvedPayer,
      ata,
      owner,
      mint,
      resolvedProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )

    return { ata, tokenProgram: resolvedProgram, instruction, exists: false }
  }, [connection, detectTokenProgram, deriveAta, wallet.publicKey])

  const ensureAta = useCallback(async (params: BuildEnsureAtaParams): Promise<BuildEnsureAtaResult> => {
    const built = await buildEnsureAtaInstruction(params)
    if (!built.instruction) return built

    const payer = params.payer ?? wallet.publicKey
    if (!payer) throw new Error('Wallet not connected for ATA creation')
    if (!wallet.sendTransaction) throw new Error('Wallet cannot send transaction')

    const tx = new Transaction().add(built.instruction)
    const latest = await connection.getLatestBlockhash('confirmed')
    tx.feePayer = payer
    tx.recentBlockhash = latest.blockhash
    await wallet.sendTransaction(tx, connection)

    return built
  }, [buildEnsureAtaInstruction, connection, wallet.publicKey, wallet.sendTransaction])

  return {
    detectTokenProgram,
    deriveAta,
    buildEnsureAtaInstruction,
    ensureAta,
  }
}
