// "Create agreement" control, shown only when lib/creation.ts allows it
// (connected account in the verified creator_allowlist AND the terms' buyer).
// Otherwise an explanation and no button. The contract remains the authority:
// a rejected call (e.g. ERR_CREATOR_NOT_ALLOWLISTED) is mapped by errors.ts.

import { Notice } from "../ui.tsx";
import { CREATION_COPY, type CreationGate } from "../../lib/creation.ts";

export function CreatorNotice({ gate }: { gate: CreationGate }) {
  if (gate.kind !== "not_allowlisted") return null;
  return (
    <div data-creator="not_allowlisted">
      <Notice tone="warning">
        <p>
          <strong>{CREATION_COPY.notAllowlisted}</strong>
        </p>
        <p>{CREATION_COPY.stillRoles}</p>
      </Notice>
    </div>
  );
}

export function CreateAgreementControl(props: { gate: CreationGate; blockers: readonly string[]; busy: boolean; onCreate: () => void }) {
  const { gate } = props;
  if (gate.kind !== "allowed") {
    const text =
      gate.kind === "preview"
        ? [CREATION_COPY.preview]
        : gate.kind === "connect"
          ? [CREATION_COPY.connect]
          : gate.kind === "not_buyer"
            ? [CREATION_COPY.notBuyer]
            : [CREATION_COPY.notAllowlisted, CREATION_COPY.stillRoles];
    return (
      <div data-create-gate={gate.kind}>
        <ul className="reasons">
          {text.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div data-create-gate="allowed">
      <button className="button" type="button" style={{ width: "100%" }} disabled={props.blockers.length > 0 || props.busy} onClick={props.onCreate}>
        Create agreement
      </button>
      <p className="small muted" style={{ marginTop: "var(--s1)" }}>
        Signing as <span className="mono">{gate.accountId}</span>, an authorized testnet creator and the buyer in these terms.
      </p>
      {props.blockers.length > 0 && (
        <ul className="reasons">
          {props.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
