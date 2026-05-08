import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    getMint,
    calculateEpochFee,
} from "@solana/spl-token";
const FEE_RATE_DENOMINATOR_VALUE = new BN(1_000_000);

function ceilDiv(tokenAmount: BN, feeNumerator: BN, feeDenominator: BN): BN {
    return tokenAmount.mul(feeNumerator).add(feeDenominator).sub(new BN(1)).div(feeDenominator);
}

function floorDiv(tokenAmount: BN, feeNumerator: BN, feeDenominator: BN): BN {
    return tokenAmount.mul(feeNumerator).div(feeDenominator);
}

export class CpmmFee {
    static tradingFee(amount: BN, tradeFeeRate: BN): BN {
        return ceilDiv(amount, tradeFeeRate, FEE_RATE_DENOMINATOR_VALUE);
    }
    static protocolFee(amount: BN, protocolFeeRate: BN): BN {
        return floorDiv(amount, protocolFeeRate, FEE_RATE_DENOMINATOR_VALUE);
    }
    static fundFee(amount: BN, fundFeeRate: BN): BN {
        return floorDiv(amount, fundFeeRate, FEE_RATE_DENOMINATOR_VALUE);
    }

    static creatorFee(amount: BN, creatorFeeRate: BN): BN {
        return ceilDiv(amount, creatorFeeRate, FEE_RATE_DENOMINATOR_VALUE);
    }

    static splitCreatorFee(totalFee: BN, tradeFeeRate: BN, creatorFeeRate: BN): BN {
        return floorDiv(totalFee, creatorFeeRate, tradeFeeRate.add(creatorFeeRate));
    }

    static calculatePreFeeAmount(postFeeAmount: BN, tradeFeeRate: BN): BN {
        if (tradeFeeRate.isZero()) return postFeeAmount;

        const numerator = postFeeAmount.mul(FEE_RATE_DENOMINATOR_VALUE);
        const denominator = FEE_RATE_DENOMINATOR_VALUE.sub(tradeFeeRate);

        return numerator.add(denominator).sub(new BN(1)).div(denominator);
    }
}

export async function computeInverseTransferFee(
    connection: Connection,
    mintPubkey: PublicKey,
    postFeeAmount: BN
): Promise<{ transferAmount: BN; transferFee: BN }> {
    const acct = await connection.getAccountInfo(mintPubkey);
    if (!acct) {
        return { transferAmount: postFeeAmount, transferFee: new BN(0) };
    }

    if (!acct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return { transferAmount: postFeeAmount, transferFee: new BN(0) };
    }

    // Try to read mint with Token-2022 program parser to extract transfer fee config
    let mintObj: any;
    try {
        mintObj = await getMint(connection, mintPubkey, "processed", TOKEN_2022_PROGRAM_ID);
    } catch (e) {
        return { transferAmount: postFeeAmount, transferFee: new BN(0) };
    }

    const tfc =
        (mintObj as any).transferFeeConfig || (mintObj as any).extensions?.transferFeeConfig || (mintObj as any).transferFee;

    if (!tfc) {
        return { transferAmount: postFeeAmount, transferFee: new BN(0) };
    }

    const newer = (tfc.newerTransferFee ?? tfc.newer ?? null) as any;
    const older = (tfc.olderTransferFee ?? tfc.older ?? null) as any;

    const newerBps = Number(newer?.transferFeeBasisPoints ?? newer?.transfer_fee_basis_points ?? 0);
    const olderBps = Number(older?.transferFeeBasisPoints ?? older?.transfer_fee_basis_points ?? 0);
    const basisPoints: number = Math.max(newerBps, olderBps, 0);

    const newerMax = BigInt(newer?.maximumFee ?? newer?.MaxFee ?? 0n);
    const olderMax = BigInt(older?.maximumFee ?? older?.MaxFee ?? 0n);
    const maxFee: bigint = newerMax > olderMax ? newerMax : olderMax;

    const epoch: bigint = BigInt(newer?.epoch ?? older?.epoch ?? 0n);

    // Binary search for pre such that pre - calculateEpochFee(cfg, epoch, pre) == post
    // Initial bounds: low = post, high = post + conservative estimate
    const postBig = BigInt(postFeeAmount.toString());

    let highBig: bigint;
    if (basisPoints === 0) {
        highBig = postBig + maxFee + 2n;
    } else {
        const denom = BigInt(10000 - basisPoints);
        highBig = (postBig * 10000n + denom - 1n) / denom + 2n;
    }

    let lowBig = postBig;

    if (highBig <= lowBig) highBig = lowBig + 1n;

    // binary search loop
    let foundPre: bigint | null = null;
    let iterations = 0;
    while (lowBig <= highBig && iterations < 128) {
        iterations++;
        const mid = (lowBig + highBig) / 2n;
        let feeBig: bigint;
        try {
            feeBig = BigInt(calculateEpochFee(tfc, epoch, mid));
        } catch (err) {
            feeBig = 0n;
        }

        const postCandidate = mid - feeBig;
        if (postCandidate === postBig) {
            foundPre = mid;
            break;
        }
        if (postCandidate < postBig) {
            lowBig = mid + 1n;
        } else {
            if (mid === 0n) break;
            highBig = mid - 1n;
        }
    }

    if (foundPre === null) {
        foundPre = lowBig;
    }

    let finalFeeBig: bigint;
    try {
        finalFeeBig = BigInt(calculateEpochFee(tfc, epoch, foundPre));
    } catch (err) {
        finalFeeBig = 0n;
    }

    const transferAmountBN = new BN(foundPre.toString());
    const transferFeeBN = new BN(finalFeeBig.toString());

    return { transferAmount: transferAmountBN, transferFee: transferFeeBN };
}

export async function computeTransferFeeForPre(connection: Connection, mintPubkey: PublicKey, preAmount: BN): Promise<BN> {
    const acct = await connection.getAccountInfo(mintPubkey);
    if (!acct) return new BN(0);
    if (!acct.owner.equals(TOKEN_2022_PROGRAM_ID)) return new BN(0);

    let mintObj: any;
    try {
        mintObj = await getMint(connection, mintPubkey, "processed", TOKEN_2022_PROGRAM_ID);
    } catch (e) {
        return new BN(0);
    }

    const tfc = (mintObj as any).transferFeeConfig || (mintObj as any).extensions?.transferFeeConfig || (mintObj as any).transferFee;
    if (!tfc) return new BN(0);

    const newer = (tfc.newerTransferFee ?? tfc.newer ?? null) as any;
    const older = (tfc.olderTransferFee ?? tfc.older ?? null) as any;
    const epoch: bigint = BigInt(newer?.epoch ?? older?.epoch ?? 0n);

    let feeBig: bigint;
    try {
        feeBig = BigInt(calculateEpochFee(tfc, epoch, BigInt(preAmount.toString())));
    } catch (err) {
        feeBig = 0n;
    }
    return new BN(feeBig.toString());
}