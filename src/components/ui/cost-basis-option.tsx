"use client";

import { cn } from "@/lib/utils";
import type { CostBasis } from "@/lib/validation/cost-basis";

/**
 * One of the two answers about what a batch of incoming stock cost.
 *
 * Used by every screen that creates a batch without a supplier invoice behind
 * it — the opening balance on a new product, and an upward stock adjustment.
 * Both ask the same question, so both ask it with the same control; a copy of
 * this component lived in each dialog and the two were identical but for a type
 * name.
 *
 * **Neither option is styled as the safe or expected choice, and that is the
 * design rather than an oversight.** "Cost is unknown" is a legitimate answer
 * this business genuinely needs — stock predating the paperwork has no provable
 * cost — and a control that nudged toward "known" would be a control that
 * manufactures numbers. Equally, "known" is not a burden to be dismissed. The
 * two sit side by side at the same visual weight, and the operator picks.
 *
 * The subtitle is not decoration. It says what the choice will actually do,
 * because the consequence of the unknown option outlives the form by as long as
 * the units last: every sale that later draws on the batch reports as uncosted,
 * and by then nobody remembers this screen.
 *
 * Rendered as a `radio` rather than a native input because there is no default:
 * a radio group with nothing checked is exactly the state being modelled, and
 * the schema refuses to proceed until something is.
 */
function CostBasisOption({
  value,
  current,
  onSelect,
  label,
  detail,
}: {
  value: CostBasis;
  current: CostBasis | null;
  onSelect: (value: CostBasis) => void;
  label: string;
  detail: string;
}) {
  const selected = current === value;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(value)}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}

export { CostBasisOption };
