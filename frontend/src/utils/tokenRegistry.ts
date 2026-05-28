import { PublicKey, Connection } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import defaultTokens from '../data/tokenRegistry.json';

const LOCAL_STORAGE_KEY = 'raydium_custom_tokens';

export interface TokenRegistryEntry {
  mint: string;
  symbol: string;
  name: string;
  color: string;
}

export function getTokenRegistry(): TokenRegistryEntry[] {
  if (typeof window === 'undefined') {
    return defaultTokens;
  }
  const customStr = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (customStr) {
    try {
      const customTokens: TokenRegistryEntry[] = JSON.parse(customStr);
      const merged = [...defaultTokens];
      for (const t of customTokens) {
        if (!merged.some(m => m.mint.toLowerCase() === t.mint.toLowerCase())) {
          merged.push(t);
        }
      }
      return merged;
    } catch (e) {
      console.error('Failed to parse custom tokens from localStorage', e);
      return defaultTokens;
    }
  }
  return defaultTokens;
}

export function isValidMintAddress(address: string): boolean {
  if (!address) return false;
  try {
    new PublicKey(address.trim());
    return true;
  } catch {
    return false;
  }
}

export function searchTokenRegistry(query: string, registry: TokenRegistryEntry[]): TokenRegistryEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return registry;
  return registry.filter(
    (t) =>
      t.symbol.toLowerCase().includes(trimmed) ||
      t.name.toLowerCase().includes(trimmed) ||
      t.mint.toLowerCase().includes(trimmed)
  );
}

export async function addTokenToRegistry(
  connection: Connection,
  mintAddress: string
): Promise<TokenRegistryEntry> {
  const cleanMint = mintAddress.trim();
  if (!isValidMintAddress(cleanMint)) {
    throw new Error('Invalid mint address format');
  }

  const mintPubkey = new PublicKey(cleanMint);
  let tokenProgram = TOKEN_PROGRAM_ID;

  try {
    const info = await connection.getAccountInfo(mintPubkey);
    if (!info) {
      throw new Error('Token mint not found on-chain: ' + cleanMint);
    }
    if (info.owner.equals(TOKEN_PROGRAM_ID)) {
      tokenProgram = TOKEN_PROGRAM_ID;
    } else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      tokenProgram = TOKEN_2022_PROGRAM_ID;
    } else {
      throw new Error('Mint address is not owned by a valid Token Program');
    }
  } catch (e: any) {
    throw new Error(e.message || 'Failed to detect token program');
  }

  // Ensure it's a valid mint by fetching its details
  try {
    await getMint(connection, mintPubkey, 'confirmed', tokenProgram);
  } catch (e: any) {
    throw new Error('Failed to verify token mint on-chain: ' + e.message);
  }

  // Set default symbol and name
  let symbol = cleanMint.slice(0, 4).toUpperCase();
  let name = `Token_${cleanMint.slice(0, 4)}`;

  // Try to fetch Metaplex Metadata
  try {
    const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    const [metadataAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        METADATA_PROGRAM_ID.toBuffer(),
        mintPubkey.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );

    const metadataAccount = await connection.getAccountInfo(metadataAddress);
    if (metadataAccount && metadataAccount.data) {
      const data = metadataAccount.data;
      // Metaplex metadata layout:
      // key: u8 (offset 0)
      // update_authority: Pubkey (offset 1) -> 32 bytes
      // mint: Pubkey (offset 33) -> 32 bytes
      // name: String (offset 65) -> 4-byte length prefix + UTF-8 bytes
      if (data.length > 69) {
        const nameLen = data.readUInt32LE(65);
        const nameStart = 69;
        const nameEnd = nameStart + nameLen;
        if (nameEnd <= data.length) {
          const extractedName = data.toString('utf8', nameStart, nameEnd).replace(/\0/g, '').trim();
          if (extractedName) {
            name = extractedName;
          }

          const symbolLenOffset = nameEnd;
          if (symbolLenOffset + 4 <= data.length) {
            const symbolLen = data.readUInt32LE(symbolLenOffset);
            const symbolStart = symbolLenOffset + 4;
            const symbolEnd = symbolStart + symbolLen;
            if (symbolEnd <= data.length) {
              const extractedSymbol = data.toString('utf8', symbolStart, symbolEnd).replace(/\0/g, '').trim();
              if (extractedSymbol) {
                symbol = extractedSymbol;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.log('Metaplex metadata not found or failed to parse, falling back to defaults', e);
  }

  // Generate a dynamic, visually appealing color
  const randomHue = Math.floor(Math.random() * 360);
  const color = `hsl(${randomHue} 72% 58%)`;

  const newEntry: TokenRegistryEntry = {
    mint: cleanMint,
    symbol,
    name,
    color,
  };

  // Add to localStorage if in browser environment
  if (typeof window !== 'undefined') {
    try {
      const customStr = localStorage.getItem(LOCAL_STORAGE_KEY);
      const customTokens: TokenRegistryEntry[] = customStr ? JSON.parse(customStr) : [];
      if (!customTokens.some(t => t.mint.toLowerCase() === cleanMint.toLowerCase())) {
        customTokens.push(newEntry);
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(customTokens));
      }
    } catch (e) {
      console.error('Failed to save custom token to localStorage', e);
    }
  }

  return newEntry;
}
