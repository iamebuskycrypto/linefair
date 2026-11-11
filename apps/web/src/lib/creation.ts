// Who may see "Create agreement" (LF-010A, docs/28). Display gate only: the
// contract stays the authority (create_agreement rejects non-listed callers
// with ERR_CREATOR_NOT_ALLOWLISTED before any storage write, then requires
// predecessor == buyer_id with ERR_NOT_BUYER). The allowlist comes from the
// verified get_config() read at startup; it is immutable by contract methods.

export type CreationGate =
  /** No escrow configured: local hash preview only, nothing can be created. */
  | { readonly kind: "preview" }
  | { readonly kind: "connect" }
  | { readonly kind: "not_allowlisted"; readonly accountId: string }
  | { readonly kind: "not_buyer"; readonly accountId: string }
  | { readonly kind: "allowed"; readonly accountId: string };

/**
 * `allowlist` null = no verified deployment (preview). Exact string
 * comparison: account ids are case-sensitive and the contract compares bytes.
 */
export function creationGate(allowlist: readonly string[] | null, accountId: string | null, buyer: string): CreationGate {
  if (allowlist === null) return { kind: "preview" };
  if (accountId === null) return { kind: "connect" };
  if (!allowlist.includes(accountId)) return { kind: "not_allowlisted", accountId };
  if (buyer.trim() !== accountId) return { kind: "not_buyer", accountId };
  return { kind: "allowed", accountId };
}

/** Exact UI copy per gate (the DOM check compares these strings). */
export const CREATION_COPY = {
  preview: "No escrow contract is configured, so creating is disabled. This page is a local preview.",
  connect: "Connect your testnet wallet. Only authorized testnet creators can create agreements, and only as the buyer.",
  notAllowlisted:
    "Agreement creation is limited to authorized testnet creators: the accounts fixed when this contract was deployed. This account is not one of them, so it cannot create agreements here.",
  stillRoles:
    "It can still take part: when an authorized creator names this account as supplier, primary arbitrator or backup arbitrator, it can accept, deliver, rule and withdraw as that role.",
  notBuyer:
    "This account is an authorized creator, but an agreement can only be created by the buyer named in its terms. Enter this account as the buyer to create it.",
} as const;
