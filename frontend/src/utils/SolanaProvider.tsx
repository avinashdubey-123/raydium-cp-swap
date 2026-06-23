import { FC, ReactNode, useMemo, useEffect, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl, Connection } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

let lastLoggedEndpoint: string | null = null;

let exportedEndpoint: string = '';
let exportedConnection: Connection | null = null;
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

  const [activeEndpoint, setActiveEndpoint] = useState<string | null>(null);

  useEffect(() => {
    const verifyEndpoint = async (url: string) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
        });

        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          if (data.error) {
            console.warn(`[SolanaProvider] RPC endpoint ${url} returned error:`, data.error);
            return false;
          }
          return true;
        }

        console.warn(`[SolanaProvider] RPC endpoint ${url} check failed (status ${response.status})`);
        return false;
      } catch (e) {
        console.warn(`[SolanaProvider] RPC health check error for ${url}:`, e);
        return false;
      }
    };

    (async () => {
      const envEndpointRaw = import.meta.env.VITE_SOLANA_RPC_URL;
      if (envEndpointRaw) {
        const envEndpoint = envEndpointRaw.startsWith('http') ? envEndpointRaw : `https://${envEndpointRaw}`;
        const healthy = await verifyEndpoint(envEndpoint);
        if (healthy) {
          setActiveEndpoint(envEndpoint);
          return;
        }
        console.warn(`[SolanaProvider] RPC endpoint failed health check, falling back to devnet.`);
      }
      setActiveEndpoint(clusterApiUrl(network));
    })();
  }, [network]);

  const connection = useMemo(() => {
    if (!activeEndpoint) return null;
    return new Connection(activeEndpoint, 'confirmed');
  }, [activeEndpoint]);

  if (activeEndpoint && exportedEndpoint !== activeEndpoint) {
    exportedEndpoint = activeEndpoint;
    exportedConnection = connection;
  }

  useEffect(() => {
    try {
      (window as any).__SOLANA_ENDPOINT = activeEndpoint;
      if (lastLoggedEndpoint !== activeEndpoint) {
        lastLoggedEndpoint = activeEndpoint;
      }
    } catch (e) {}
  }, [activeEndpoint]);

  if (!activeEndpoint) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>Connecting to Solana RPC…</div>;
  }

  return (
    <ConnectionProvider endpoint={activeEndpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

export const getEndpoint = () => exportedEndpoint;
export const getConnection = () => {
  if (exportedConnection) return exportedConnection;

  const endpoint = exportedEndpoint || clusterApiUrl(WalletAdapterNetwork.Devnet);
  const conn = new Connection(endpoint, 'confirmed');
  exportedConnection = conn;
  exportedEndpoint = endpoint;
  return conn;
};