"use server";

import { revalidatePath } from "next/cache";

import { currencyLabel, type Currency } from "@/lib/currency";
import { toSafeError } from "@/lib/errors";
import { currencySettingSchema } from "@/lib/validation/settings";
import { setCurrency } from "@/server/settings";

/**
 * The settings actions, as thin wrappers.
 *
 * Same shape as every other action module here: validate the payload, call the
 * server module, revalidate what the write affects, and turn a thrown error
 * into something the form can render.
 *
 * Authorisation is not here. This is a `"use server"` entry point a browser can
 * call directly with any payload it likes, so the fact that STAFF never sees
 * the selector proves nothing — `setCurrency` re-checks ADMIN on the server.
 */

export type SettingsActionResult =
  | { ok: true; message: string; currency: Currency }
  | { ok: false; message: string };

export async function updateCurrencyAction(
  formData: FormData,
): Promise<SettingsActionResult> {
  const parsed = currencySettingSchema.safeParse({
    currency: formData.get("currency"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message:
        parsed.error.issues[0]?.message ??
        "Choose one of the supported currencies.",
    };
  }

  try {
    const currency = await setCurrency(parsed.data.currency);

    /*
     * Every screen that renders money, which is very nearly every screen. The
     * currency reaches them as a prop resolved during the server render, so a
     * page not revalidated here would keep showing the old symbol until
     * something else happened to invalidate it.
     *
     * `layout` rather than `page` for the root: the provider that carries the
     * currency to the client components lives in the `(app)` layout, and a
     * page-level revalidation would leave it holding the previous value.
     */
    revalidatePath("/", "layout");

    return {
      ok: true,
      currency,
      message:
        `Currency set to ${currencyLabel(currency)}. ` +
        `Existing amounts were not converted — they are now shown in ${currency}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "updateCurrencyAction").message,
    };
  }
}
