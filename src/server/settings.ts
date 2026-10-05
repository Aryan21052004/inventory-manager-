import "server-only";

import { cache } from "react";

import { DEFAULT_CURRENCY, type Currency } from "@/lib/currency";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";

/**
 * Installation-wide settings. At present, the currency.
 *
 * The table holds exactly one row, guaranteed by a check constraint rather than
 * by convention, so this module never has to decide which of several rows is
 * the real one.
 */

/** The one row's primary key. Constrained to this value in the database. */
const SINGLETON_ID = "singleton";

/**
 * The currency the installation accounts in.
 *
 * Wrapped in React's `cache()`, which memoises for the lifetime of a single
 * server render. That matters more here than it looks: the dashboard formats
 * money in eleven places and the valuation report in ten, and every component
 * that renders a figure needs to know the currency. Without the memo a page
 * would issue one query per money-bearing component; with it, one per request,
 * however many callers ask.
 *
 * The memo is per-render, not a process-wide cache, so an administrator's
 * change is visible on the next request rather than after a restart.
 *
 * **Falls back to the default rather than throwing.** The row can legitimately
 * be absent — a database migrated but not yet seeded, or a test that has just
 * truncated every table — and none of those is a reason to fail a page that was
 * only trying to render a number. A missing row means "nobody has chosen", and
 * the answer to that is the default, not a 500.
 *
 * Deliberately unauthenticated. Every page that calls this sits under the
 * `(app)` layout, which has already resolved the session and redirected if
 * there was none; adding a second check inside a formatting dependency would
 * invite ordering bugs for no gain, and
 * the active currency is not a secret.
 */
export const getCurrency = cache(async (): Promise<Currency> => {
  try {
    const setting = await prisma.appSetting.findUnique({
      where: { id: SINGLETON_ID },
      select: { defaultCurrency: true },
    });

    return setting?.defaultCurrency ?? DEFAULT_CURRENCY;
  } catch {
    /*
     * An unreachable database must not take down a page that renders money.
     * The pages themselves already handle their own query failing and show an
     * error state; this one is a formatting detail, and defaulting keeps the
     * failure in the one place that can describe it properly.
     */
    return DEFAULT_CURRENCY;
  }
});

/**
 * Changes the installation currency. ADMIN only.
 *
 * Authorisation is here, on the server, not in the screen that calls it. The
 * settings form is a `"use server"` entry point a browser can invoke directly,
 * so hiding the selector from a STAFF user proves nothing — `requireRole`
 * re-checks against the role stored in our own database, which is the same
 * arrangement every other privileged write in this codebase uses.
 *
 * **This writes one row and touches nothing else.** No monetary column is read,
 * recalculated or rewritten, and no exchange rate is applied, because none
 * exists. The amounts in the database keep the exact values they had; what
 * changes is the currency they are reported in. That re-labels historical
 * figures, which is the accepted, stated consequence of a single global
 * currency — see the migration and the warning on the settings screen.
 *
 * An upsert rather than an update: the row is created by the migration, but a
 * database restored from a partial dump, or a test that truncated everything,
 * should still be settable rather than failing on a missing row.
 */
export async function setCurrency(currency: Currency): Promise<Currency> {
  const user = await requireRole("ADMIN");

  const setting = await prisma.appSetting.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, defaultCurrency: currency, updatedBy: user.id },
    update: { defaultCurrency: currency, updatedBy: user.id },
    select: { defaultCurrency: true },
  });

  return setting.defaultCurrency;
}
