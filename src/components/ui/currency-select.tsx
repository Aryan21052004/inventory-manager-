"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CURRENCIES, currencyLabel, type Currency } from "@/lib/currency";

/**
 * The currency one document is agreed in.
 *
 * Shared by the order and purchase builders because the rule behind it is the
 * same on both sides and a second copy would drift: this picks the currency a
 * document is *denominated* in, and it never touches the numbers on its lines.
 * There are no exchange rates in this system, so changing this re-states what
 * the figures mean and the operator re-decides them — see the callers, which
 * clear what they prefilled and make the rest explicit.
 *
 * Deliberately labelled and separated from the money inputs rather than
 * decorating them. A symbol glued to a price box reads as formatting; a named
 * field reads as a decision, which is what it is.
 */
function CurrencySelect({
  value,
  onChange,
  disabled,
  id = "document-currency",
  hint,
}: {
  value: Currency;
  onChange: (next: Currency) => void;
  disabled?: boolean | undefined;
  id?: string | undefined;
  /** Shown under the control — what changing it will and will not do. */
  hint?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Currency
      </label>

      <Select
        value={value}
        onValueChange={(next) => onChange(next as Currency)}
        disabled={disabled ?? false}
      >
        <SelectTrigger id={id} className="w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CURRENCIES.map((code) => (
            <SelectItem key={code} value={code}>
              {currencyLabel(code)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export { CurrencySelect };
