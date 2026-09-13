"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Info,
  Loader2,
  Package,
  Plus,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { toast } from "sonner";

import {
  createOrderAction,
  searchOrderProductsAction,
  updateOrderAction,
} from "@/app/(app)/orders/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CurrencySelect } from "@/components/ui/currency-select";
import { formatEntry, RecordMoney } from "@/components/ui/money";
import { useCurrency } from "@/components/layout/currency-provider";
import type { Currency } from "@/lib/currency";
import {
  carriedAcrossCurrencyChange,
  clearedByCurrencyChange,
  sameKnownCurrency,
} from "@/lib/document-currency";
import { formatCurrency, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The order builder.
 *
 * Everything visible here is a preview. The line totals, the subtotal and the
 * grand total are recomputed on the server from prices read out of the database
 * at the moment the order is written — this component does not send them, and
 * they would not be believed if it did. What it sends is a customer, a set of
 * product ids and quantities.
 *
 * The arithmetic is duplicated rather than shared because the two copies answer
 * different questions: this one tells the user what they are about to commit
 * to, and the server's decides what the order actually is. If they ever
 * disagree, the server is right and the page will show it after saving.
 *
 * Stock is shown per line, and a line that exceeds it is flagged — but flagged
 * only. Confirmation is where stock is truly checked, under a row lock, because
 * the number displayed here was true when the page loaded and may not be by the
 * time anyone clicks.
 *
 * The same component builds a new order and edits an existing one. They differ
 * only in where the lines start and which action receives them, so splitting
 * them would mean two copies of a product search, a line table and a totals
 * panel kept in step by hand.
 *
 * Editing never touches inventory, and cannot: `updateOrder` writes lines and
 * money, and the stock engine is not reachable from it. Quantities move only
 * when an order is confirmed. Editing is also refused server-side for anything
 * past PENDING, whatever this component allows.
 */

export interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  /**
   * INACTIVE only for the customer already on an order being edited — the
   * picker is otherwise a list of active customers. See `loadCustomers`.
   */
  status: "ACTIVE" | "INACTIVE";
}

export interface ProductOption {
  id: string;
  name: string;
  sku: string;
  /**
   * The catalogue's reference price, used to prefill a new line's quote.
   *
   * Null when the product has no reference price, in which case the line starts
   * blank and the salesperson enters the quote. It is a default and nothing
   * more: once a line exists, its price lives in `OrderLine.unitPrice`.
   */
  sellingPrice: string | null;
  /** What that price is quoted in. Null when it was never recorded. */
  priceCurrency: Currency | null;
  stockQuantity: number;
  /**
   * False only for a line already on an order whose product has since been
   * retired. Search results are always active.
   */
  isActive: boolean;
}

interface OrderLine {
  product: ProductOption;
  quantity: number;
  /**
   * The quoted unit price, as typed. Held as a string rather than a number so a
   * half-typed value ("12.", "") survives editing instead of collapsing to 0 —
   * the same reason the server checks the string before converting it.
   */
  unitPrice: string;
  /**
   * Where this figure came from, and the only place that is knowable.
   *
   * The server cannot tell a prefilled quote from a typed one — `OrderItem`
   * stores no provenance, and an edit replaces its lines wholesale — so the
   * distinction has to live here, in the state of the form that made it. It
   * exists for exactly one decision: when the currency changes, a catalogue
   * prefill is meaningless in the new currency and is cleared, while a figure
   * somebody typed is theirs and is kept.
   *
   * "catalogue" survives only until the box is edited. There is no path back.
   */
  priceSource: "catalogue" | "manual";
}

/** An order being edited, as the page hands it over. */
export interface ExistingOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  /**
   * What this order is already denominated in. Shown as-is — never replaced
   * by the installation default, which would re-state a figure nobody
   * re-decided. Null on a legacy order whose currency was never recorded.
   */
  currency: Currency | null;
  lines: OrderLine[];
}

function OrderBuilder({
  customers,
  initialProducts,
  order,
  initialCustomerId,
}: {
  customers: CustomerOption[];
  initialProducts: ProductOption[];
  /** Absent when raising a new order; present when editing one. */
  order?: ExistingOrder;
  /**
   * A customer to start with, from `/orders/new?customer=…` — the shortcut on a
   * customer's record. The page only passes one it found in `customers`, so
   * this can never select something the dropdown does not contain.
   */
  initialCustomerId?: string;
}) {
  const router = useRouter();
  const editing = order !== undefined;

  const [customerId, setCustomerId] = useState<string>(
    order?.customerId ?? initialCustomerId ?? "",
  );
  const [lines, setLines] = useState<OrderLine[]>(order?.lines ?? []);
  const [submitting, setSubmitting] = useState(false);

  const defaultCurrency = useCurrency();

  /*
   * What this order is denominated in.
   *
   * An existing order shows its own currency, never today's default — that
   * default proposes a currency for something being created and has no say
   * over one already agreed. A legacy order with none recorded falls back to
   * the default only because it is being given one for the first time.
   */
  const [currency, setCurrency] = useState<Currency>(
    order?.currency ?? defaultCurrency,
  );
  const [pricesAcknowledged, setPricesAcknowledged] = useState(false);

  /*
   * The currency and prices this order was loaded with. The acknowledgement
   * rule is defined against these and not against the live form, so it mirrors
   * exactly what the server will compare on save.
   */
  const baselineCurrency = order?.currency ?? null;
  const baselinePrices = useMemo(
    () =>
      new Map((order?.lines ?? []).map((line) => [line.product.id, line.unitPrice])),
    [order],
  );

  /*
   * Changing the currency re-states what every figure on the order means; it
   * does not convert anything, because nothing here can.
   *
   * A catalogue prefill is cleared: it was the price list's number, and the
   * price list is not denominated in the new currency. A figure somebody typed
   * is kept — deleting a person's own work to tidy up a currency change would
   * be worse than leaving them to check it.
   */
  function changeCurrency(next: Currency) {
    if (next === currency) return;

    setCurrency(next);
    setPricesAcknowledged(false);
    const clearing = new Set(
      clearedByCurrencyChange(
        lines.map((line) => ({
          key: line.product.id,
          amount: line.unitPrice,
          prefilled: line.priceSource === "catalogue",
        })),
      ),
    );

    setLines((current) =>
      current.map((line) =>
        clearing.has(line.product.id) ? { ...line, unitPrice: "" } : line,
      ),
    );
  }

  /*
   * Lines whose figure did not move while the currency did — the same test the
   * server applies, so the form cannot offer a save the server will refuse.
   */
  const carriedPrices = carriedAcrossCurrencyChange(
    lines.map((line) => ({
      key: line.product.id,
      amount: line.unitPrice,
      prefilled: line.priceSource === "catalogue",
    })),
    baselinePrices,
    { from: baselineCurrency, to: currency },
  );

  const needsPriceAcknowledgement =
    carriedPrices.length > 0 && !pricesAcknowledged;

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ProductOption[]>(initialProducts);
  const [searching, startSearch] = useTransition();

  const lastQuery = useRef("");

  /*
   * Product search runs on the server, debounced. Filtering a preloaded list in
   * the browser would only ever search the twenty products that happened to
   * arrive with the page — fine for a demo catalogue, wrong the moment there
   * are a thousand parts.
   */
  useEffect(() => {
    if (search === lastQuery.current) return;

    const timer = setTimeout(() => {
      lastQuery.current = search;
      startSearch(async () => {
        setResults(await searchOrderProductsAction(search));
      });
    }, 250);

    return () => clearTimeout(timer);
  }, [search]);

  const addedIds = useMemo(
    () => new Set(lines.map((line) => line.product.id)),
    [lines],
  );

  function addProduct(product: ProductOption) {
    // One line per product. A second line for the same part is an editing
    // mistake, not a scenario — the server refuses it and the database refuses
    // it, so the UI should not offer it either.
    if (addedIds.has(product.id)) {
      toast.info(`${product.name} is already on the order`, {
        description: "Change the quantity on its line instead.",
      });
      return;
    }

    /*
     * The reference price prefills the quote; a product without one starts
     * blank and must be filled in. Prefilling happens *here*, when the line is
     * created, and nowhere else — a line that already carries a quote must
     * never be re-seeded from the catalogue.
     *
     * And only a price the catalogue quoted in the currency this order is
     * being raised in. A figure denominated in something else is not a default
     * but a different number: copying 40.00 off a dollar price list into a
     * rupee order converts nothing, it silently re-denominates it, and
     * `OrderItem` keeps no record that the figure ever meant dollars. There
     * are no exchange rates here, so the honest prefill is none — the picker
     * and the note under the box each show the reference in its own currency,
     * and the quote gets entered in this order's.
     *
     * The rule `changeCurrency` applies to lines already on the order, applied
     * at the other moment a catalogue figure can get onto one.
     */
    const prefill =
      product.sellingPrice !== null &&
      sameKnownCurrency(currency, product.priceCurrency)
        ? product.sellingPrice
        : null;

    setLines((current) => [
      ...current,
      {
        product,
        quantity: 1,
        unitPrice: prefill ?? "",
        // Prefilled from the catalogue, so a currency change may clear it.
        // Blank whenever the catalogue's figure cannot be used — no reference
        // price, or one denominated in something else — and a blank is the
        // operator's from the outset.
        priceSource: prefill === null ? "manual" : "catalogue",
      },
    ]);
  }

  function setQuantity(productId: string, quantity: number) {
    setLines((current) =>
      current.map((line) =>
        line.product.id === productId ? { ...line, quantity } : line,
      ),
    );
  }

  function setUnitPrice(productId: string, unitPrice: string) {
    setLines((current) =>
      current.map((line) =>
        line.product.id === productId
          ? // Typed, so it is the operator's figure now and a currency change
            // must never discard it.
            { ...line, unitPrice, priceSource: "manual" as const }
          : line,
      ),
    );
  }

  function removeLine(productId: string) {
    setLines((current) =>
      current.filter((line) => line.product.id !== productId),
    );
  }

  // Integer cents throughout, for the same reason the server uses them: a
  // subtotal is a sum of many numbers, and floating point drifts.
  const subtotalCents = lines.reduce(
    (sum, line) => sum + quoteCents(line.unitPrice) * line.quantity,
    0,
  );
  // The grand total is the subtotal. There is no discount term and no tax
  // term — see the check constraint on `orders`.
  const totalCents = subtotalCents;
  /*
   * Lines the shelf cannot fill today.
   *
   * No longer an error. This business sells parts it does not yet hold, so
   * confirming such a line deducts what is on hand and records the rest as an
   * outstanding obligation on the order — the button below stays enabled and
   * the message says what will happen rather than refusing.
   */
  const overStock = lines.filter(
    (line) => line.quantity > line.product.stockQuantity,
  );

  const outstandingUnits = overStock.reduce(
    (sum, line) =>
      sum + (line.quantity - Math.max(0, line.product.stockQuantity)),
    0,
  );

  /*
   * A line whose product has been retired since the order was raised. The
   * server refuses to save one, so the form refuses too — with a message
   * naming the product, rather than letting the save fail after the fact.
   */
  const retired = lines.filter((line) => !line.product.isActive);

  const canSubmit =
    customerId !== "" &&
    lines.length > 0 &&
    retired.length === 0 &&
    // Every line must carry a price the server will accept. The button is
    // disabled rather than the save being allowed to fail on a round trip.
    lines.every((line) => isValidQuote(line.unitPrice)) &&
    /*
     * A carried price needs the operator to say they meant it. Gated here as
     * well as on the server for the same reason every line price is: the save
     * would be refused on a round trip, and disabling the button says so
     * before the click rather than after it.
     */
    !needsPriceAcknowledgement &&
    !submitting;

  const submission = () => ({
    customerId,
    currency,
    ...(pricesAcknowledged ? { pricesConfirmedForCurrencyChange: true } : {}),
    items: lines.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      /*
       * The quote, and the only money that travels from here. Line totals, the
       * subtotal and the grand total are all recomputed on the server from this
       * and the quantity — a total the browser calculated is a total the
       * browser chose.
       */
      unitPrice: line.unitPrice.trim(),
    })),
  });

  async function submit(confirm: boolean) {
    if (!canSubmit) return;

    setSubmitting(true);

    const result =
      editing && order
        ? await updateOrderAction(order.id, submission())
        : await createOrderAction(submission(), confirm);

    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    toast.success(result.message);
    router.push(`/orders/${result.orderId}`);
    // The detail page is server-rendered and cached; without this it can show
    // the pre-edit lines for a moment after the redirect.
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
            <CardDescription>Who this order is for.</CardDescription>
          </CardHeader>
          <CardContent>
            {customers.length === 0 ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  There are no customers to pick from. An order needs one, and
                  this form does not create them on the fly — a mistyped name
                  would otherwise become a second customer record. Add one in
                  the customers directory, or bring an archived customer back.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/customers">Go to customers</Link>
                </Button>
              </div>
            ) : (
              <Field label="Customer" htmlFor="customer">
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger id="customer">
                    <SelectValue placeholder="Choose a customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((customer) => (
                      <SelectItem key={customer.id} value={customer.id}>
                        {customer.name}
                        {customer.email ? ` · ${customer.email}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            <CurrencySelect
              value={currency}
              onChange={changeCurrency}
              disabled={submitting}
              id="order-currency"
              hint="What this order is agreed in. Changing it does not convert any figure — there are no exchange rates in this system — so prices taken from the catalogue are cleared and anything you typed is kept for you to check."
            />

            {carriedPrices.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
                <p className="text-xs leading-relaxed text-foreground">
                  {carriedPrices.length === 1
                    ? "One line still shows the price it had before the currency changed"
                    : `${carriedPrices.length} lines still show the prices they had before the currency changed`}
                  {baselineCurrency === null
                    ? ""
                    : ` (${baselineCurrency} → ${currency})`}
                  . A price is not converted by re-labelling it. Re-enter the
                  {carriedPrices.length === 1 ? " figure" : " figures"} in{" "}
                  {currency}, or confirm below that {carriedPrices.length === 1
                    ? "it is"
                    : "they are"}{" "}
                  the same in both.
                </p>

                <label className="flex items-start gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-warning"
                    checked={pricesAcknowledged}
                    onChange={(event) =>
                      setPricesAcknowledged(event.target.checked)
                    }
                  />
                  <span>
                    These figures are correct in {currency}.
                  </span>
                </label>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add products</CardTitle>
            <CardDescription>
              Search the catalogue by name or SKU. Only active products can be
              sold.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by product name or SKU…"
                aria-label="Search products by name or SKU"
                className="pl-9 pr-9"
              />
              {searching ? (
                <Loader2
                  className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
                  aria-hidden
                />
              ) : null}
            </div>

            <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
              {results.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No active products match that search.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="hidden sm:table-cell">SKU</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead className="text-right">Reference</TableHead>
                      <TableHead className="w-12">
                        <span className="sr-only">Add</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((option) => {
                      const added = addedIds.has(option.id);

                      return (
                        <TableRow key={option.id}>
                          <TableCell className="max-w-[14rem] truncate font-medium">
                            {option.name}
                          </TableCell>
                          <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                            {option.sku}
                          </TableCell>
                          <TableCell className="tabular text-right">
                            {formatNumber(option.stockQuantity)}
                          </TableCell>
                          <TableCell className="tabular text-right font-medium">
                            {option.sellingPrice === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              formatEntry({
                                currency: option.priceCurrency,
                                amount: option.sellingPrice,
                              })
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant={added ? "ghost" : "outline"}
                              size="icon"
                              disabled={added}
                              aria-label={
                                added
                                  ? `${option.name} is already on the order`
                                  : `Add ${option.name}`
                              }
                              onClick={() => addProduct(option)}
                            >
                              {added ? <Check /> : <Plus />}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Order lines</CardTitle>
            <CardDescription>
              {lines.length === 0
                ? "Nothing added yet."
                : `${lines.length} ${lines.length === 1 ? "product" : "products"} on this order.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {lines.length === 0 ? (
              <EmptyState
                icon={Package}
                title="No products on this order"
                description="Search above and add the parts being sold. An order needs at least one line before it can be saved."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Quoted unit price</TableHead>
                    <TableHead className="w-32 text-right">Quantity</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const unitCents = quoteCents(line.unitPrice);
                    const short = line.quantity > line.product.stockQuantity;

                    return (
                      <TableRow key={line.product.id}>
                        <TableCell className="max-w-[14rem]">
                          <span className="block truncate font-medium">
                            {line.product.name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {line.product.sku}
                          </span>
                          {line.product.isActive ? null : (
                            <Badge variant="destructive" className="mt-1">
                              No longer active
                            </Badge>
                          )}
                        </TableCell>
                        {/*
                          Emphasis, not alarm. A short line is a valid order
                          that will leave units outstanding, so the figure is
                          highlighted rather than coloured as an error.
                        */}
                        <TableCell
                          className={cn(
                            "tabular text-right",
                            short
                              ? "font-medium text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatNumber(line.product.stockQuantity)}
                          {short ? (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {formatNumber(
                                line.quantity -
                                  Math.max(0, line.product.stockQuantity),
                              )}{" "}
                              outstanding
                            </span>
                          ) : null}
                        </TableCell>
                        {/*
                          The quote, and the point of the whole screen. The
                          reference price sits above it as a default the
                          salesperson has already accepted or typed over, so a
                          deviation is a visible choice rather than something
                          only the saved order would reveal.
                        */}
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            value={line.unitPrice}
                            aria-label={`Quoted unit price for ${line.product.name}`}
                            aria-invalid={!isValidQuote(line.unitPrice)}
                            onChange={(event) =>
                              setUnitPrice(line.product.id, event.target.value)
                            }
                            className="tabular ml-auto w-32 text-right"
                          />
                          <QuoteNote
                            reference={line.product.sellingPrice}
                            referenceCurrency={line.product.priceCurrency}
                            quoted={line.unitPrice}
                            currency={currency}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            value={line.quantity}
                            aria-label={`Quantity for ${line.product.name}`}
                            onChange={(event) => {
                              const next = Number(event.target.value);
                              setQuantity(
                                line.product.id,
                                Number.isFinite(next) && next >= 1
                                  ? Math.floor(next)
                                  : 1,
                              );
                            }}
                            className="tabular w-24 text-right"
                          />
                        </TableCell>
                        <TableCell className="tabular text-right font-medium">
                          {formatCurrency((unitCents * line.quantity) / 100, currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${line.product.name}`}
                            onClick={() => removeLine(line.product.id)}
                          >
                            <Trash2 className="text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-6">
        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
            <CardDescription>Grand total is the sum of the lines.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular font-medium">
                  {formatCurrency(subtotalCents / 100, currency)}
                </dd>
              </div>
              {/*
                No tax line and no discount line, and no place for either. The
                grand total is the subtotal — see the check constraint on
                `orders`.
              */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <dt className="font-medium">Grand total</dt>
                <dd className="tabular text-lg font-semibold">
                  {formatCurrency(Math.max(totalCents, 0) / 100, currency)}
                </dd>
              </div>
            </dl>

            {retired.length > 0 ? (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {retired.length === 1
                    ? `${retired[0]!.product.name} is no longer active and cannot be sold.`
                    : `${retired.length} products on this order are no longer active.`}{" "}
                  Remove{" "}
                  {retired.length === 1 ? "that line" : "those lines"} to save.
                </span>
              </p>
            ) : null}

            {overStock.length > 0 ? (
              <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {overStock.length === 1
                    ? `${overStock[0]!.product.name} has fewer units on hand than this order asks for.`
                    : `${overStock.length} lines ask for more than is on hand.`}{" "}
                  {editing
                    ? `Confirming will fulfil what is in stock and leave ${formatNumber(outstandingUnits)} ${outstandingUnits === 1 ? "unit" : "units"} outstanding.`
                    : `Confirming will fulfil what is in stock and leave ${formatNumber(outstandingUnits)} ${outstandingUnits === 1 ? "unit" : "units"} outstanding, to be shipped once more arrives.`}
                </span>
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              {editing ? (
                <>
                  <Button
                    type="button"
                    onClick={() => submit(false)}
                    disabled={!canSubmit}
                  >
                    {submitting ? <Loader2 className="animate-spin" /> : null}
                    {submitting ? "Saving…" : "Save changes"}
                  </Button>
                  <Button type="button" variant="outline" asChild>
                    <Link href={`/orders/${order.id}`}>Cancel</Link>
                  </Button>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Saving rewrites this order&apos;s lines and totals. It does
                    not touch inventory — stock moves only when the order is
                    confirmed.
                  </p>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    onClick={() => submit(true)}
                    disabled={!canSubmit}
                  >
                    {submitting ? <Loader2 className="animate-spin" /> : null}
                    Save and confirm
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => submit(false)}
                    disabled={!canSubmit}
                  >
                    Save as draft
                  </Button>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Confirming deducts the stock that is on hand immediately and
                    writes a movement against your account. Anything short is
                    recorded as outstanding, not refused. A draft changes
                    nothing.
                  </p>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <SelectedCustomer
          customer={customers.find((entry) => entry.id === customerId)}
        />
      </div>
    </div>
  );
}

/**
 * The selected customer, or nothing when none is chosen.
 *
 * Takes an optional customer rather than asserting one was found. The list can
 * legitimately not contain the selected id — an archived customer is only
 * included when the page asked for them by id — and a non-null assertion here
 * would turn that into a crash on a page someone is in the middle of editing.
 */
function SelectedCustomer({ customer }: { customer?: CustomerOption }) {
  if (!customer) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <User className="size-4 text-muted-foreground" aria-hidden />
          Selected customer
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="text-sm font-medium">{customer.name}</p>
        {customer.email ? (
          <p className="text-xs text-muted-foreground">{customer.email}</p>
        ) : (
          <Badge variant="muted">No email on file</Badge>
        )}
        {/* Only ever an order raised before they were archived. Saying so beats
            leaving someone to wonder why this name is not in the dropdown. */}
        {customer.status === "INACTIVE" ? (
          <Badge variant="muted" className="mt-1 w-fit">
            Archived customer
          </Badge>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * A typed quote as integer cents, or zero while it is unusable.
 *
 * Zero for a blank or half-typed value is safe here because `pricedLines` below
 * refuses to submit until every line parses — the preview simply shows a
 * partial subtotal while someone is mid-keystroke, rather than NaN.
 */
function quoteCents(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "" || !Number.isFinite(Number(trimmed))) return 0;
  return Math.round(Number(trimmed) * 100);
}

/** Whether a typed quote is something the server will accept. */
function isValidQuote(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || !Number.isFinite(Number(trimmed))) return false;
  if (!/^\d*(\.\d{1,2})?$/.test(trimmed)) return false;
  const amount = Number(trimmed);
  return amount >= 0 && amount <= 9_999_999_999.99;
}

/**
 * The reference price, and how far this quote sits from it.
 *
 * Informational, never an error. Quoting away from the catalogue is ordinary
 * business — the same part goes to one customer at ₹12,000 and another at
 * ₹13,500 — so this reports the deviation rather than warning about it. What it
 * prevents is a quote drifting from the reference *unnoticed*, which is the
 * protection that replaced the server refusing client-supplied prices at all.
 *
 * The deviation only exists when the catalogue quoted its reference in the
 * currency this order is being raised in. Otherwise the two figures are not on
 * the same scale and subtracting them would invent a number — so the reference
 * is shown in its own currency instead, which is the same fact minus the
 * arithmetic, and the salesperson compares them knowing what each one is. A
 * reference whose currency was never recorded is shown the same way, marked
 * unknown: it is still worth seeing and still not comparable.
 *
 * Nothing is shown when there is no reference to compare against, when the
 * quote is not yet usable, or when the two are comparable and agree.
 */
function QuoteNote({
  reference,
  referenceCurrency,
  quoted,
  currency,
}: {
  reference: string | null;
  referenceCurrency: Currency | null;
  quoted: string;
  /**
   * What this order is denominated in — the currency on the document being
   * built, never the installation default. The default proposes a currency for
   * a new order and has no business labelling a figure that already has one.
   */
  currency: Currency;
}) {
  if (reference === null || !isValidQuote(quoted)) return null;

  if (!sameKnownCurrency(currency, referenceCurrency)) {
    return (
      <span className="mt-1 block text-xs text-muted-foreground">
        Reference:{" "}
        <RecordMoney amount={reference} currency={referenceCurrency} />
      </span>
    );
  }

  const referenceCents = Math.round(Number(reference) * 100);
  const quotedCents = quoteCents(quoted);
  const difference = quotedCents - referenceCents;

  if (difference === 0) return null;

  const percent =
    referenceCents === 0
      ? null
      : Math.abs((difference / referenceCents) * 100).toFixed(1);

  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      {formatCurrency(Math.abs(difference) / 100, currency)}{" "}
      {difference < 0 ? "below" : "above"} reference
      {percent === null ? null : ` · ${percent}%`}
    </span>
  );
}

export { OrderBuilder };
