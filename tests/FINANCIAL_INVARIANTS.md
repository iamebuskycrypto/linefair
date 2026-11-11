# Financial invariants quick reference
These are **requirements**, not evidence of passing tests. Detailed tests live in `SCENARIO_MATRIX.csv`.

For a funded line P: `P = locked + buyer_claim + supplier_claim + buyer_pending + supplier_pending + buyer_paid + supplier_paid`. Sum across lines equals all **recognized** FT funding credits. No float math. All individual amounts nonnegative, checked arithmetic, no terminal value exceeds P. `allocated_buyer+allocated_supplier=P` when finalized. No token transfer on acceptance itself.

If transfer is pending, funds are unavailable to both claimants until authenticated FT callback definitively succeeds or fails. If callback status cannot be proved, stay pending frozen for audited reconciliation. Receipt checking and storage registration are mandatory. No arbitrary withdrawal recipient or admin sweep. Values expressed in verified NEP-141 base units.
