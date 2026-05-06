#!/usr/bin/env ts-node
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
	Connection,
	Keypair,
	PublicKey,
	SendTransactionError,
	SystemProgram,
	SYSVAR_RENT_PUBKEY,
	Transaction,
} from "@solana/web3.js";
import fs from "fs";
import idl from "../../target/idl/raydium_cp_swap.json";
import {
	createAssociatedTokenAccountIdempotentInstruction,
	getAccount,
	getAssociatedTokenAddressSync,
	NATIVE_MINT,
	TOKEN_PROGRAM_ID,
	TOKEN_2022_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createInterface } from "readline/promises";
import {
	getAuthAddress,
	getPoolAddress,
	getPoolLpMintAddress,
	getPoolVaultAddress,
	getOrcleAccountAddress,
} from "../../tests/utils/pda";

const PROGRAM_ID = new PublicKey("J1h1sProk7RbLzyvsSM8YE1hZz3ALMwQu6wzqeRSRGbD");

const PAYER_KEYPATH = "/home/avinash_dubey/.config/solana/id1.json";
const CREATOR_KEYPATH = "/home/avinash_dubey/.config/solana/creator-id.json";
const AMM_CONFIG = new PublicKey("7YnNrHDn7wbkNTB7XJRHRqF5FuyzktFQCU8Zo9VfoJN9");
const MINT_A = new PublicKey("FRYJVUuNHeH1jJ4D56TTgRZyFQ7jEQQdu1vpd4evdkPb");
const MINT_B = new PublicKey("7Ru62uNfTEqx748XweWjLgjeJrT7KWjCsiocnK7Qqx9");
const INIT_A = new BN(1000);
const INIT_B = new BN(1000);
const OPEN_TIME = new BN(0);
// Hardcoded create_pool_fee receiver (matches program's create_pool_fee_receiver::ID for devnet)
const CREATE_POOL_FEE_ACCOUNT = new PublicKey("63EqUEuqiLw9ZvJJsFECg5fN7bM9hBifUEYJFGhJtuCa");
// Creator fee enum must be passed as the IDL enum variant object
const CREATOR_FEE_ON: any = { bothToken: {} };

function loadKeypair(path: string): Keypair {
	const raw = fs.readFileSync(path, "utf8");
	return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
	return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

async function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
	const info = await connection.getAccountInfo(mint);
	if (!info) {
		console.warn(`mint account not found for ${mint.toBase58()}; assuming TOKEN_PROGRAM_ID`);
		return TOKEN_PROGRAM_ID;
	}
	if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
	if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
	throw new Error(`Unsupported mint owner for ${mint.toBase58()}: ${info.owner.toBase58()}`);
}

async function ensurePayerTokenAccounts(
	provider: anchor.AnchorProvider,
	owner: PublicKey,
	token0Mint: PublicKey,
	token1Mint: PublicKey,
	token0Program: PublicKey,
	token1Program: PublicKey,
	lpMint?: PublicKey
) {
	// Re-detect token program IDs to avoid mismatches between mint owner and provided program
	try {
		token0Program = await detectTokenProgram(provider.connection, token0Mint);
	} catch (e) {
		console.warn(`Failed to detect token program for ${token0Mint.toBase58()}: ${e}. Defaulting to TOKEN_PROGRAM_ID`);
		token0Program = TOKEN_PROGRAM_ID;
	}
	try {
		token1Program = await detectTokenProgram(provider.connection, token1Mint);
	} catch (e) {
		console.warn(`Failed to detect token program for ${token1Mint.toBase58()}: ${e}. Defaulting to TOKEN_PROGRAM_ID`);
		token1Program = TOKEN_PROGRAM_ID;
	}

	console.log(`Using token programs - token0: ${token0Program.toBase58()}, token1: ${token1Program.toBase58()}`);

	const token0Ata = getAssociatedTokenAddressSync(token0Mint, owner, false, token0Program);
	const token1Ata = getAssociatedTokenAddressSync(token1Mint, owner, false, token1Program);
	const ixs: any[] = [];

	if (!(await provider.connection.getAccountInfo(token0Ata, "confirmed"))) {
		ixs.push(
			createAssociatedTokenAccountIdempotentInstruction(
				provider.wallet.publicKey,
				token0Ata,
				owner,
				token0Mint,
				token0Program,
				ASSOCIATED_TOKEN_PROGRAM_ID
			)
		);
	}

	if (!(await provider.connection.getAccountInfo(token1Ata, "confirmed"))) {
		ixs.push(
			createAssociatedTokenAccountIdempotentInstruction(
				provider.wallet.publicKey,
				token1Ata,
				owner,
				token1Mint,
				token1Program,
				ASSOCIATED_TOKEN_PROGRAM_ID
			)
		);
	}

	if (lpMint) {
		const lpInfo = await provider.connection.getAccountInfo(lpMint, "confirmed");
		if (!lpInfo) {
			console.log(`LP mint ${lpMint.toBase58()} does not exist yet; skipping LP ATA creation.`);
		} else {
			const lpProgram = await detectTokenProgram(provider.connection, lpMint);
			console.log(`Using lp token program ${lpProgram.toBase58()} for mint ${lpMint.toBase58()}`);
			const lpAta = getAssociatedTokenAddressSync(lpMint, owner, false, lpProgram);
			if (!(await provider.connection.getAccountInfo(lpAta, "confirmed"))) {
				ixs.push(
					createAssociatedTokenAccountIdempotentInstruction(
						provider.wallet.publicKey,
						lpAta,
						owner,
						lpMint,
						lpProgram,
						ASSOCIATED_TOKEN_PROGRAM_ID
					)
				);
			}
		}
	}

	if (ixs.length === 0) return;
	console.log(`Creating ${ixs.length} missing token account(s) for ${owner.toBase58()}...`);
	const sig = await provider.sendAndConfirm(new Transaction().add(...ixs), []);
	console.log(`ATA setup tx: ${sig}`);
}

async function assertExecutableProgram(connection: Connection, programId: PublicKey) {
	let info;
	try {
		info = await connection.getAccountInfo(programId, "confirmed");
	} catch (e) {
		throw new Error(`failed to get info about account ${programId.toBase58()}: ${e}`);
	}
	if (!info) throw new Error(`Program account not found: ${programId.toBase58()}`);
	if (!info.executable) throw new Error(`Account exists but is not executable: ${programId.toBase58()}`);
}

async function requireInitializeConfirmation() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question('Type "YES" to execute initializeWithPermission transaction: ')).trim();
	rl.close();

	if (answer.toLowerCase() !== "yes") {
		throw new Error("Initialize cancelled. Confirmation input was not YES.");
	}
}

async function assertCreatePoolFeeAccount(connection: Connection, account: PublicKey) {
	const info = await connection.getAccountInfo(account, "confirmed");
	if (!info) {
		throw new Error(`create_pool_fee account does not exist: ${account.toBase58()}`);
	}
	if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
		throw new Error(`create_pool_fee must be a Token Program account, but owner is ${info.owner.toBase58()} at ${account.toBase58()}`);
	}

	const tokenAcc = await getAccount(connection, account, "confirmed", TOKEN_PROGRAM_ID);
	if (!tokenAcc.mint.equals(NATIVE_MINT)) {
		throw new Error(`create_pool_fee must be a wrapped SOL token account (mint ${NATIVE_MINT.toBase58()}), got mint ${tokenAcc.mint.toBase58()}`);
	}
}

async function deriveInitializeWithPermissionAccounts(connection: Connection, payer: PublicKey) {
	const [authority] = await getAuthAddress(PROGRAM_ID);

	const [token0Mint, token1Mint] = sortMints(MINT_A, MINT_B);
	const token0Program = await detectTokenProgram(connection, token0Mint);
	const token1Program = await detectTokenProgram(connection, token1Mint);

	const [poolState] = await getPoolAddress(AMM_CONFIG, token0Mint, token1Mint, PROGRAM_ID);
	const [lpMint] = await getPoolLpMintAddress(poolState, PROGRAM_ID);
	const lpTokenProgram = await detectTokenProgram(connection, lpMint);
	const [token0Vault] = await getPoolVaultAddress(poolState, token0Mint, PROGRAM_ID);
	const [token1Vault] = await getPoolVaultAddress(poolState, token1Mint, PROGRAM_ID);
	const [observationState] = await getOrcleAccountAddress(poolState, PROGRAM_ID);

	const payerToken0 = getAssociatedTokenAddressSync(token0Mint, payer, false, token0Program);
	const payerToken1 = getAssociatedTokenAddressSync(token1Mint, payer, false, token1Program);
	const payerLpToken = getAssociatedTokenAddressSync(lpMint, payer, false, lpTokenProgram);

	const [permissionPda] = PublicKey.findProgramAddressSync([Buffer.from("permission"), payer.toBuffer()], PROGRAM_ID);

	return {
		payer,
		ammConfig: AMM_CONFIG,
		authority,
		poolState,
		token0Mint,
		token1Mint,
		lpMint,
		payerToken0,
		payerToken1,
		payerLpToken,
		token0Vault,
		token1Vault,
		createPoolFee: undefined,
		observationState,
		permission: permissionPda,
		tokenProgram: lpTokenProgram,
		token0Program,
		token1Program,
		associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
		systemProgram: SystemProgram.programId,
		rent: SYSVAR_RENT_PUBKEY,
	} as any;
}

async function main() {
	const connection = new Connection("https://api.devnet.solana.com", "confirmed");
	const payer = loadKeypair(PAYER_KEYPATH);
	const creator = loadKeypair(CREATOR_KEYPATH);

	// Use payer (platform/operator) as the transaction signer and liquidity provider per on-chain expectations
	const wallet = new anchor.Wallet(payer);
	const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
	anchor.setProvider(provider);

	(idl as any).address = PROGRAM_ID.toBase58();
	await assertExecutableProgram(connection, PROGRAM_ID);
	const program = new anchor.Program(idl as any, provider as any);

	// derive accounts using the payer so token accounts and permission PDA are tied to the payer
	const accounts = await deriveInitializeWithPermissionAccounts(connection, payer.publicKey);

	// Use hardcoded create_pool_fee receiver from program
	const createPoolFeeReceiver = CREATE_POOL_FEE_ACCOUNT;
	accounts.createPoolFee = createPoolFeeReceiver;

	const token0 = accounts.token0Mint;
	const token1 = accounts.token1Mint;
	const lpMint = accounts.lpMint;
	const authority = accounts.authority;
	const token0Vault = accounts.token0Vault;
	const token1Vault = accounts.token1Vault;
	const observationState = accounts.observationState;
	const payerToken0 = accounts.payerToken0;
	const payerToken1 = accounts.payerToken1;
	const payerLpToken = accounts.payerLpToken;
	const poolState = accounts.poolState;
	const permissionPda = accounts.permission;
	const token0Program = accounts.token0Program;
	const token1Program = accounts.token1Program;

	console.log("Derived accounts:", {
		poolState: poolState.toBase58(),
		lpMint: lpMint.toBase58(),
		token0Vault: token0Vault.toBase58(),
		token1Vault: token1Vault.toBase58(),
		permissionPda: permissionPda.toBase58(),
	});

	console.log("Passed input fields:", {
		payer: payer.publicKey.toBase58(),
		creator: creator.publicKey.toBase58(),
		ammConfig: AMM_CONFIG.toBase58(),
		mintA: MINT_A.toBase58(),
		mintB: MINT_B.toBase58(),
		createPoolFee: createPoolFeeReceiver.toBase58(),
		initAmount0: INIT_A.toString(),
		initAmount1: INIT_B.toString(),
		openTime: OPEN_TIME.toString(),
	});

	await requireInitializeConfirmation();
	await assertCreatePoolFeeAccount(connection, createPoolFeeReceiver);

	// Ensure payer (liquidity provider) has ATAs — platform (provider.wallet) will fund ATA creation
	await ensurePayerTokenAccounts(
		provider,
		payer.publicKey,
		token0,
		token1,
		token0Program,
		token1Program,
		lpMint
	);

	console.log("Sending initializeWithPermission...");
	const multiplier = new BN(10).pow(new BN(9));
	const baseInitAmount0 = INIT_A.mul(multiplier);
	const baseInitAmount1 = INIT_B.mul(multiplier);

	try {
		const sig = await program.methods
			.initializeWithPermission(baseInitAmount0, baseInitAmount1, OPEN_TIME, CREATOR_FEE_ON)
			.accounts({
				payer: payer.publicKey,
				creator: creator.publicKey,
				ammConfig: AMM_CONFIG,
				authority: authority,
				poolState: poolState,
				token0Mint: token0,
				token1Mint: token1,
				lpMint: lpMint,
				payerToken0: payerToken0,
				payerToken1: payerToken1,
				payerLpToken: payerLpToken,
				token0Vault: token0Vault,
				token1Vault: token1Vault,
				createPoolFee: createPoolFeeReceiver,
				observationState: observationState,
				permission: permissionPda,
				tokenProgram: TOKEN_PROGRAM_ID,
				token0Program: token0Program,
				token1Program: token1Program,
				associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
				systemProgram: SystemProgram.programId,
				rent: SYSVAR_RENT_PUBKEY,
			})
			.signers([])
			.rpc();

		console.log("initializeWithPermission tx:", sig);
	} catch (err: any) {
		console.error("Initialize failed:", err?.message ?? err);
		if (typeof err?.getLogs === "function") {
			const logs = await err.getLogs(connection).catch(() => null);
			if (logs?.length) {
				console.error("Simulation logs:");
				for (const line of logs) console.error(line);
			}
		} else if (err?.transactionLogs) {
			console.error("Transaction logs:");
			for (const l of err.transactionLogs) console.error(l);
		}
		throw err;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

