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
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import {
  createPurchaseAction,
  searchPurchaseProductsAction,
  updatePurchaseAction,
} from "@/app/(app)/purchases/actions";
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
import { formatCurrency, formatNumber } from "@/lib/format";

/**
 * The purchase builder.
 *
 * Everything visible is a preview. Line totals and the grand total are
 * recomputed on the server from the quantity and unit cost it validated — this
 * component does not send them, and they would not be believed if it did.
 *
 * The unit cost *is* sent, and that is the one meaningful difference from the
 * order builder. A selling price is our number and is copied from the
 * catalogue; a purchase cost is the supplier's number, and it can differ from
 * the catalogue cost on any given delivery. The catalogue cost is offered as
 * the starting value and can be overwritten.
 *
 * The same component raises a new purchase and edits an existing one. They
 * differ only in where the lines start and which action receives them.
 */

export interface SupplierOption {
  id: string;
  name: string;
  email: string | null;
}

export interface ProductOption {
  id: string;
  name: string;
  sku: string;
  /** The catalogue cost — a default for the line, not a constraint on it. */
  standardCost: string | null;
  stockQuantity: number;
  isActive: boolean;
}

interface PurchaseLine {
  product: ProductOption;
  quantity: number;
  /** Held as a string so the input can be typed in freely. */
  unitCost: string;
}

export interface ExistingPurchase {
  id: string;
  purchaseNumber: string;
  supplierId: string;
  purchaseDate: string;
  lines: PurchaseLine[];
}

function PurchaseBuilder({
  suppliers,
  initialProducts,
  purchase,
}: {
  suppliers: SupplierOption[];
  initialProducts: ProductOption[];
  /** Absent when raising a new purchase; present when editing one. */
  purchase?: ExistingPurchase;
}) {
  const router = useRouter();
  const editing = purchase !== undefined;

  const [supplierId, setSupplierId] = useState(purchase?.supplierId ?? "");
  const [lines, setLines] = useState<PurchaseLine[]>(purchase?.lines ?? []);
  const [purchaseDate, setPurchaseDate] = useState(
    purchase?.purchaseDate ?? new Date().toISOString().slice(0, 10),
  );
  const [submitting, setSubmitting] = useState(false);

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ProductOption[]>(initialProducts);
  const [searching, startSearch] = useTransition();

  const lastQuery = useRef("");

  /*
   * Product search runs on the server, debounced. Filtering a preloaded list
   * in the browser would only ever search the products that happened to arrive
   * with the page.
   */
  useEffect(() => {
    if (search === lastQuery.current) return;

    const timer = setTimeout(() => {
      lastQuery.current = search;
      startSearch(async () => {
        setResults(await searchPurchaseProductsAction(search));
      });
    }, 250);

    return () => clearTimeout(timer);
  }, [search]);

  const addedIds = useMemo(
    () => new Set(lines.map((line) => line.product.id)),
    [lines],
  );

  function addProduct(product: ProductOption) {
    // One line per product. The server refuses a duplicate and the database
    // refuses it, so the UI should not offer it either.
    if (addedIds.has(product.id)) {
      toast.info(`${product.name} is already on the purchase`, {
        description: "Change the quantity on its line instead.",
      });
      return;
    }

    setLines((current) => [
      ...current,
      /*
       * Seeded from the planning figure when there is one, and left blank when
       * there is not. Blank rather than "0.00" on purpose: a zero that nobody
       * meant is a lot recorded as free stock, and the whole point of this
       * screen is that what gets typed here becomes the acquisition cost of the
       * batch. The operator has to enter what the supplier actually charged.
       */
      { product, quantity: 1, unitCost: product.standardCost ?? "" },
    ]);
  }

  function updateLine(productId: string, patch: Partial<PurchaseLine>) {
    setLines((current) =>
      current.map((line) =>
        line.product.id === productId ? { ...line, ...patch } : line,
      ),
    );
  }

  function removeLine(productId: string) {
    setLines((current) =>
      current.filter((line) => line.product.id !== productId),
    );
  }

  // Integer cents throughout, for the same reason the server uses them.
  const lineCents = (line: PurchaseLine) =>
    Math.round((Number(line.unitCost) || 0) * 100) * line.quantity;

  const totalCents = lines.reduce((sum, line) => sum + lineCents(line), 0);

  /** A line whose cost is not a usable number, or is negative. */
  const badCost = lines.filter(
    (line) => !Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0,
  );

  /**
   * A line whose product has been retired. The server refuses to save or
   * receive one, so the form refuses too — naming the product rather than
   * letting the save fail after the fact.
   */
  const retired = lines.filter((line) => !line.product.isActive);

  const canSubmit =
    supplierId !== "" &&
    lines.length > 0 &&
    badCost.length === 0 &&
    retired.length === 0 &&
    !submitting;

  const submission = () => ({
    supplierId,
    items: lines.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      unitCost: line.unitCost === "" ? "0" : line.unitCost,
    })),
    purchaseDate,
  });

  async function submit(receive: boolean) {
    if (!canSubmit) return;

    setSubmitting(true);

    const result =
      editing && purchase
        ? await updatePurchaseAction(purchase.id, submission())
        : await createPurchaseAction(submission(), receive);

    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    toast.success(result.message);
    router.push(`/purchases/${result.purchaseId}`);
    // The detail page is server-rendered and cached; without this it can show
    // pre-edit lines for a moment after the redirect.
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Supplier</CardTitle>
            <CardDescription>Who these goods are coming from.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {suppliers.length === 0 ? (
              <p className="text-sm text-muted-foreground sm:col-span-2">
                There are no suppliers yet. A purchase needs one, and this module
                does not create suppliers on the fly — a mistyped name would
                otherwise become a second supplier record.
              </p>
            ) : (
              <>
                <Field label="Supplier" htmlFor="supplier">
                  <Select value={supplierId} onValueChange={setSupplierId}>
                    <SelectTrigger id="supplier">
                      <SelectValue placeholder="Choose a supplier" />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers.map((supplier) => (
                        <SelectItem key={supplier.id} value={supplier.id}>
                          {supplier.name}
                          {supplier.email ? ` · ${supplier.email}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field
                  label="Purchase date"
                  htmlFor="purchaseDate"
                  hint="When it was placed with the supplier."
                >
                  <Input
                    id="purchaseDate"
                    type="date"
                    value={purchaseDate}
                    onChange={(event) => setPurchaseDate(event.target.value)}
                  />
                </Field>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add products</CardTitle>
            <CardDescription>
              Search the catalogue by name or SKU. Only active products can be
              purchased.
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
                      <TableHead className="text-right">Current stock</TableHead>
                      <TableHead className="text-right">Cost price</TableHead>
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
                            {option.standardCost === null
                              ? "No standard cost"
                              : formatCurrency(option.standardCost)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant={added ? "ghost" : "outline"}
                              size="icon"
                              disabled={added}
                              aria-label={
                                added
                                  ? `${option.name} is already on the purchase`
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
            <CardTitle>Purchase lines</CardTitle>
            <CardDescription>
              {lines.length === 0
                ? "Nothing added yet."
                : `${lines.length} ${lines.length === 1 ? "product" : "products"} on this purchase.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {lines.length === 0 ? (
              <EmptyState
                icon={Package}
                title="No products on this purchase"
                description="Search above and add the parts being delivered. A purchase needs at least one line before it can be saved."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">In stock</TableHead>
                    <TableHead className="w-28 text-right">Quantity</TableHead>
                    <TableHead className="w-32 text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
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
                            Retired
                          </Badge>
                        )}
                      </TableCell>

                      <TableCell className="tabular text-right text-muted-foreground">
                        {formatNumber(line.product.stockQuantity)}
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
                            updateLine(line.product.id, {
                              quantity:
                                Number.isFinite(next) && next >= 1
                                  ? Math.floor(next)
                                  : 1,
                            });
                          }}
                          className="tabular w-24 text-right"
                        />
                      </TableCell>

                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.unitCost}
                          aria-label={`Unit cost for ${line.product.name}`}
                          aria-invalid={Number(line.unitCost) < 0}
                          onChange={(event) =>
                            updateLine(line.product.id, {
                              unitCost: event.target.value,
                            })
                          }
                          className="tabular w-28 text-right"
                        />
                      </TableCell>

                      <TableCell className="tabular text-right font-medium">
                        {formatCurrency(lineCents(line) / 100)}
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
                  ))}
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
            <CardDescription>
              The total is the sum of the line totals.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Lines</dt>
                <dd className="tabular font-medium">{lines.length}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Units</dt>
                <dd className="tabular font-medium">
                  {formatNumber(
                    lines.reduce((sum, line) => sum + line.quantity, 0),
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular font-medium">
                  {formatCurrency(totalCents / 100)}
                </dd>
              </div>
              {/*
                No tax line and no discount. A purchase is what the supplier
                invoiced, line by line — a negotiated reduction belongs in the
                unit cost that was agreed.
              */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <dt className="font-medium">Grand total</dt>
                <dd className="tabular text-lg font-semibold">
                  {formatCurrency(totalCents / 100)}
                </dd>
              </div>
            </dl>

            {retired.length > 0 ? (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {retired.length === 1
                    ? `${retired[0]!.product.name} has been retired and cannot be purchased.`
                    : `${retired.length} products on this purchase have been retired.`}{" "}
                  Remove {retired.length === 1 ? "that line" : "those lines"}, or
                  make the product active again.
                </span>
              </p>
            ) : null}

            {badCost.length > 0 ? (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                A unit cost is missing or negative. Costs can be zero — a
                warranty replacement still arrives — but not below it.
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
                    <Link href={`/purchases/${purchase.id}`}>Cancel</Link>
                  </Button>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Saving rewrites this purchase&apos;s lines and total. It does
                    not touch inventory — stock rises only when the delivery is
                    received.
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
                    Save and receive
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
                    Receiving adds the quantities to stock immediately and writes
                    a movement against your account. A draft changes nothing.
                  </p>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {supplierId ? (
          <SelectedSupplier
            supplier={suppliers.find((entry) => entry.id === supplierId)!}
          />
        ) : null}
      </div>
    </div>
  );
}

function SelectedSupplier({ supplier }: { supplier: SupplierOption }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Truck className="size-4 text-muted-foreground" aria-hidden />
          Selected supplier
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="text-sm font-medium">{supplier.name}</p>
        {supplier.email ? (
          <p className="text-xs text-muted-foreground">{supplier.email}</p>
        ) : (
          <Badge variant="muted">No email on file</Badge>
        )}
      </CardContent>
    </Card>
  );
}

export { PurchaseBuilder };
