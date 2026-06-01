import { FC, ReactNode, useMemo, useEffect } from "react";
import {
  ConnectionProvider,
  WalletProvider
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

let lastLoggedEndpoint: string | null = null

interface SolanaProviderProps {
  children: ReactNode;
}

export const SolanaProvider: FC<SolanaProviderProps> = ({ children }) => {
  const network = WalletAdapterNetwork.Devnet;
  const wallets = useMemo(() => {
    const injected = typeof window !== 'undefined' && (window as any).solana && (window as any).solana.isPhantom
    if (injected) return [] as any
    return [new PhantomWalletAdapter()]
  }, [])

  const endpoint = useMemo(() => {
    return import.meta.env.VITE_SOLANA_RPC_URL || clusterApiUrl(network);
  }, [network]);

  useEffect(() => {
    try {
      ;(window as any).__SOLANA_ENDPOINT = endpoint
      if (lastLoggedEndpoint !== endpoint) {
        console.log('Resolved Solana endpoint ->', endpoint)
        lastLoggedEndpoint = endpoint
      }
    } catch (e) {
    }
  }, [endpoint])

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};