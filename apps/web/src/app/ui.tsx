import type { ReactNode } from "react";
import type { StateLabel, Tone } from "../lib/contract/states.ts";
import { formatUnits } from "../lib/format.ts";

const GLYPH: Record<Tone, string> = {
  neutral: "–",
  info: "i",
  positive: "✓",
  warning: "!",
  negative: "×",
};

/** Status chip: always text plus glyph, never colour alone (docs/19). */
export function Status({ state }: { state: Pick<StateLabel, "label" | "tone"> }) {
  return (
    <span className={`status tone-${state.tone}`} data-glyph={GLYPH[state.tone]}>
      {state.label}
    </span>
  );
}

/** Exact token amount; raw base units on hover. */
export function Amount({ base, decimals, symbol }: { base: bigint; decimals: number; symbol: string }) {
  return (
    <span className="num" title={`${base.toString()} base units`}>
      {formatUnits(base, decimals)} {symbol}
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "negative"; children: ReactNode }) {
  return <div className={`notice ${tone === "info" ? "" : tone}`} role={tone === "negative" ? "alert" : undefined}>{children}</div>;
}

export function Field(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (aria: { id: string; "aria-invalid": boolean; "aria-describedby": string | undefined }) => ReactNode;
}) {
  const hintId = props.hint !== undefined ? `${props.id}-hint` : undefined;
  const errId = props.error !== undefined ? `${props.id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children({ id: props.id, "aria-invalid": props.error !== undefined, "aria-describedby": describedBy })}
      {props.hint !== undefined && (
        <span className="hint" id={hintId}>
          {props.hint}
        </span>
      )}
      {props.error !== undefined && (
        <span className="err" id={errId}>
          {props.error}
        </span>
      )}
    </div>
  );
}
