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

interface SolanaProviderProps {
  children: ReactNode;
}

export const SolanaProvider: FC<SolanaProviderProps> = ({ children }) => {
  // The network can be set to 'devnet', 'testnet', or 'mainnet'
  const network = WalletAdapterNetwork.Devnet;
  const wallets = useMemo(() => {
    const injected = typeof window !== 'undefined' && (window as any).solana && (window as any).solana.isPhantom
    if (injected) return [] as any
    return [new PhantomWalletAdapter()]
  }, [])

  // You can also provide a custom RPC endpoint
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);

  useEffect(() => {
    try {
      // expose resolved endpoint for runtime verification and log once
      ;(window as any).__SOLANA_ENDPOINT = endpoint
      // eslint-disable-next-line no-console
      console.log('Resolved Solana endpoint ->', endpoint)
    } catch (e) {
      // ignore
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