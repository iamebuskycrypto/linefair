// One consistent read of a line's withdrawal state: get_agreement,
// get_withdrawal (BUYER and SUPPLIER) and custody_summary, all at the SAME
// final block height, so the record/ledger consistency checks in
// withdrawals.ts never compare values from different blocks. Read-only.

import type { NearRpc } from "./rpc.ts";
import type { AgreementView, CustodySummaryView, LineView, WithdrawalView } from "../contract/types.ts";
import type { ClaimSnapshot, Who } from "../contract/withdrawals.ts";

export interface LineSnapshot {
  readonly blockHeight: bigint;
  readonly agreement: AgreementView;
  readonly line: LineView;
  readonly buyer: WithdrawalView | null;
  readonly supplier: WithdrawalView | null;
  readonly custody: CustodySummaryView;
}

export async function readLineSnapshot(rpc: NearRpc, escrowId: string, agreementId: string, lineId: number): Promise<LineSnapshot> {
  const { height } = await rpc.finalBlock();
  const [a, b, s, c] = await Promise.all([
    rpc.getAgreement(escrowId, agreementId, height),
    rpc.getWithdrawal(escrowId, agreementId, lineId, "BUYER", height),
    rpc.getWithdrawal(escrowId, agreementId, lineId, "SUPPLIER", height),
    rpc.custodySummary(escrowId, height),
  ]);
  if (a.value === null) throw new Error(`agreement ${agreementId} not found at block ${height}`);
  const line = a.value.lines.find((l) => l.line_id === lineId);
  if (line === undefined) throw new Error(`line ${lineId} not found at block ${height}`);
  return { blockHeight: height, agreement: a.value, line, buyer: b.value, supplier: s.value, custody: c.value };
}

export function claimSnapshot(s: LineSnapshot, who: Who): ClaimSnapshot {
  return { blockHeight: s.blockHeight, line: s.line, withdrawal: who === "buyer" ? s.buyer : s.supplier, custody: s.custody };
}
