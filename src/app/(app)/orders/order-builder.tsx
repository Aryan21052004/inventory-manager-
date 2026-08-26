"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
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
import { StockStatusBadge } from "@/components/ui/stock-status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatNumber } from "@/lib/format";
import type { StockStatus } from "@/lib/stock-status";
import { cn } from "@/lib/utils";

/**
 * The order builder.
 *
 * Everything visible here is a preview. The line totals, the subtotal and the
 * grand total are recomputed on the server from prices read out of the database
 * at the moment the order is written — this component does not send them, and
 * they would not be believed if it did. What it sends is a customer, a set of
 * product ids and quantities, and a discount.
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
}

export interface ProductOption {
  id: string;
  name: string;
  sku: string;
  /** The product's price now — what the server will recalculate the line from. */
  sellingPrice: string;
  stockQuantity: number;
  minimumStock: number;
  stockStatus: StockStatus;
  /**
   * False only for a line already on an order whose product has since been
   * retired. Search results are always active.
   */
  isActive: boolean;
}

interface OrderLine {
  product: ProductOption;
  quantity: number;
}

/** An order being edited, as the page hands it over. */
export interface ExistingOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  discount: string;
  lines: OrderLine[];
}

function OrderBuilder({
  customers,
  initialProducts,
  order,
}: {
  customers: CustomerOption[];
  initialProducts: ProductOption[];
  /** Absent when raising a new order; present when editing one. */
  order?: ExistingOrder;
}) {
  const router = useRouter();
  const editing = order !== undefined;

  const [customerId, setCustomerId] = useState<string>(order?.customerId ?? "");
  const [lines, setLines] = useState<OrderLine[]>(order?.lines ?? []);
  const [discount, setDiscount] = useState(order?.discount ?? "0.00");
  const [submitting, setSubmitting] = useState(false);

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

    setLines((current) => [...current, { product, quantity: 1 }]);
  }

  function setQuantity(productId: string, quantity: number) {
    setLines((current) =>
      current.map((line) =>
        line.product.id === productId ? { ...line, quantity } : line,
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
    (sum, line) =>
      sum + Math.round(Number(line.product.sellingPrice) * 100) * line.quantity,
    0,
  );
  const discountCents = Math.round((Number(discount) || 0) * 100);
  const totalCents = subtotalCents - discountCents;

  const discountTooLarge = discountCents > subtotalCents;
  const overStock = lines.filter(
    (line) => line.quantity > line.product.stockQuantity,
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
    !discountTooLarge &&
    retired.length === 0 &&
    !submitting;

  const submission = () => ({
    customerId,
    items: lines.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
    })),
    // Sent as a plain amount. Every other figure — unit prices, line totals,
    // the subtotal, the grand total — is recomputed on the server from prices
    // read there, so none of them travel from here.
    discount: String(discountCents / 100),
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
              <p className="text-sm text-muted-foreground">
                There are no customers yet. An order needs one, and this module
                does not create customers on the fly — a mistyped name would
                otherwise become a second customer record.
              </p>
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
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="hidden md:table-cell">
                        Stock status
                      </TableHead>
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
                            {formatCurrency(option.sellingPrice)}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <StockStatusBadge status={option.stockStatus} />
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
                    <TableHead className="text-right">Unit price</TableHead>
                    <TableHead className="w-32 text-right">Quantity</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const unitCents = Math.round(
                      Number(line.product.sellingPrice) * 100,
                    );
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
                        <TableCell
                          className={cn(
                            "tabular text-right",
                            short
                              ? "font-medium text-destructive"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatNumber(line.product.stockQuantity)}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {formatCurrency(line.product.sellingPrice)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            value={line.quantity}
                            aria-label={`Quantity for ${line.product.name}`}
                            aria-invalid={short}
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
                          {formatCurrency((unitCents * line.quantity) / 100)}
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
            <CardDescription>Grand total is subtotal minus discount.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field
              label="Discount"
              htmlFor="discount"
              hint="A cash amount off the subtotal."
              error={
                discountTooLarge
                  ? "The discount is larger than the subtotal."
                  : undefined
              }
            >
              <Input
                id="discount"
                type="number"
                min="0"
                step="0.01"
                value={discount}
                onChange={(event) => setDiscount(event.target.value)}
                aria-invalid={discountTooLarge}
                className="tabular"
              />
            </Field>

            <dl className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular font-medium">
                  {formatCurrency(subtotalCents / 100)}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="tabular font-medium text-destructive">
                  {discountCents > 0 ? "−" : ""}
                  {formatCurrency(discountCents / 100)}
                </dd>
              </div>
              {/*
                No tax line, and no place for one. The grand total is the
                discounted subtotal — see the check constraint on `orders`.
              */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <dt className="font-medium">Grand total</dt>
                <dd className="tabular text-lg font-semibold">
                  {formatCurrency(Math.max(totalCents, 0) / 100)}
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
              <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {overStock.length === 1
                    ? `${overStock[0]!.product.name} has fewer units on hand than this order asks for.`
                    : `${overStock.length} lines ask for more than is on hand.`}{" "}
                  {editing
                    ? "You can still save; confirming will be refused until stock is available."
                    : "You can still save a draft; confirming will be refused until stock is available."}
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
                    disabled={!canSubmit || overStock.length > 0}
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
                    Confirming deducts stock immediately and writes a movement
                    against your account. A draft changes nothing.
                  </p>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {customerId ? (
          <SelectedCustomer
            customer={customers.find((entry) => entry.id === customerId)!}
          />
        ) : null}
      </div>
    </div>
  );
}

function SelectedCustomer({ customer }: { customer: CustomerOption }) {
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
      </CardContent>
    </Card>
  );
}

export { OrderBuilder };
