import { z } from "zod";

import { CURRENCIES } from "@/lib/currency";

/**
 * Validation for the settings form.
 *
 * One field, and it still gets a schema. The value arrives from a `<select>`,
 * which looks like it constrains its own options — but a `"use server"` action
 * is an endpoint a browser can call with anything at all, so the list of
 * options in the markup is a convenience for the user rather than a guarantee
 * to the server.
 *
 * The enum is built from `CURRENCIES` rather than restated, so the form, the
 * formatter and the database column cannot disagree about what is supported.
 */
export const currencySettingSchema = z.object({
  currency: z.enum(CURRENCIES, {
    message: "Choose one of the supported currencies.",
  }),
});

export type CurrencySettingInput = z.infer<typeof currencySettingSchema>;
