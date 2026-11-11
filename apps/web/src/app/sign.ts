// Signs one call through the wallet (lib/near/wallet.ts, testnet
// wallet-selector; NOT yet exercised against a deployed contract). A
// reported on-chain failure is rethrown so that it maps to an error code;
// a returned hash is only "sent", never a result: callers re-read the
// contract view to judge the outcome.

import type { FunctionCallSpec } from "../lib/near/tx.ts";
import { readWalletOutcome } from "../lib/near/walletOutcome.ts";

export async function sign(signerId: string, call: FunctionCallSpec): Promise<string | null> {
  const { signAndSend } = await import("../lib/near/wallet.ts");
  const o = readWalletOutcome(await signAndSend(signerId, call));
  if (o.failure !== null) throw new Error(o.failure);
  return o.txHash;
}

/**
 * Like `sign`, but never throws for an executed transaction: returns the
 * final status so that a withdraw's result can be shown as "reported by the
 * transaction" next to the re-read contract record. A wallet that redirects
 * (formerly MyNearWallet) or whose popup closes early may return nothing; then
 * only the re-read counts.
 */
export async function signForOutcome(
  signerId: string,
  call: FunctionCallSpec,
): Promise<{ txHash: string | null; successValue: string | null; failure: string | null }> {
  const { signAndSend } = await import("../lib/near/wallet.ts");
  return readWalletOutcome(await signAndSend(signerId, call));
}
