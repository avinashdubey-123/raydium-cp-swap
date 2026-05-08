import { useMemo } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { AnchorProvider, Program, Idl } from '@coral-xyz/anchor'
import idlJson from '../../idl/raydium_cp_swap.json'

export default function useProgram(): Program | null {
    const { connection } = useConnection()
    const wallet = useWallet()

    const anchorWallet = useMemo(() => {
        if (!wallet || !wallet.connected || !wallet.publicKey) return null;
        return {
            publicKey: wallet.publicKey,
            signTransaction: wallet.signTransaction?.bind(wallet),
            signAllTransactions: wallet.signAllTransactions?.bind(wallet),
        }
    }, [wallet])

    const provider = useMemo(() => {
        if (!anchorWallet) return null;
        return new AnchorProvider(connection, anchorWallet as any, AnchorProvider.defaultOptions());
    }, [connection, anchorWallet]);

    const program = useMemo(() => {
        if (!provider) return null

        try {
            const idl = idlJson as unknown as Idl
            return new Program(idl, provider)
        } catch (err) {
            console.error('useProgram: failed to create Program', err)
            return null
        }
    }, [provider])

    return program
}