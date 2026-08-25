-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "StockTransactionType" AS ENUM ('STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "StockReferenceType" AS ENUM ('ORDER', 'PURCHASE', 'STOCK_TRANSACTION', 'MANUAL');

-- AlterEnum
BEGIN;
CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'STAFF');
ALTER TABLE "public"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "public"."UserRole_old";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'STAFF';
COMMIT;

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "products" DROP CONSTRAINT "products_category_id_fkey";

-- DropForeignKey
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_supplier_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_order_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_product_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_purchase_id_fkey";

-- DropIndex
DROP INDEX "orders_order_date_idx";

-- DropIndex
DROP INDEX "products_category_id_idx";

-- DropIndex
DROP INDEX "purchases_order_date_idx";

-- DropIndex
DROP INDEX "users_clerk_id_key";

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "is_active",
DROP COLUMN "notes";

-- AlterTable
ALTER TABLE "order_items" DROP COLUMN "line_total",
ADD COLUMN     "total" DECIMAL(12,2) NOT NULL,
ALTER COLUMN "unit_price" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "confirmed_at",
DROP COLUMN "notes",
DROP COLUMN "order_date",
ADD COLUMN     "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
ALTER COLUMN "total" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "customer_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "products" DROP COLUMN "category_id",
DROP COLUMN "is_active",
DROP COLUMN "location",
DROP COLUMN "quantity",
DROP COLUMN "reorder_level",
DROP COLUMN "unit_cost",
DROP COLUMN "unit_price",
ADD COLUMN     "category" TEXT NOT NULL,
ADD COLUMN     "cost_price" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "minimum_stock" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "selling_price" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "stock_quantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "purchase_items" DROP COLUMN "line_total",
ADD COLUMN     "total" DECIMAL(12,2) NOT NULL,
ALTER COLUMN "unit_cost" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "purchases" DROP COLUMN "notes",
DROP COLUMN "order_date",
DROP COLUMN "received_at",
ADD COLUMN     "purchase_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "total" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "supplier_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "suppliers" DROP COLUMN "contact_name",
DROP COLUMN "is_active",
DROP COLUMN "notes",
ADD COLUMN     "contact_person" TEXT;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "clerk_id",
DROP COLUMN "image_url",
ADD COLUMN     "password_hash" TEXT NOT NULL,
ALTER COLUMN "name" SET NOT NULL;

-- DropTable
DROP TABLE "categories";

-- DropTable
DROP TABLE "stock_movements";

-- DropEnum
DROP TYPE "MovementType";

-- CreateTable
CREATE TABLE "stock_transactions" (
    "id" TEXT NOT NULL,
    "type" "StockTransactionType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "previous_stock" INTEGER NOT NULL,
    "new_stock" INTEGER NOT NULL,
    "reference_type" "StockReferenceType" NOT NULL DEFAULT 'MANUAL',
    "reference_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "product_id" TEXT NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_transactions_product_id_created_at_idx" ON "stock_transactions"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_transactions_type_idx" ON "stock_transactions"("type");

-- CreateIndex
CREATE INDEX "stock_transactions_reference_type_reference_id_idx" ON "stock_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "stock_transactions_created_by_idx" ON "stock_transactions"("created_by");

-- CreateIndex
CREATE INDEX "stock_transactions_created_at_idx" ON "stock_transactions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_product_id_key" ON "order_items"("order_id", "product_id");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_items_purchase_id_product_id_key" ON "purchase_items"("purchase_id", "product_id");

-- CreateIndex
CREATE INDEX "purchases_purchase_date_idx" ON "purchases"("purchase_date");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_email_key" ON "suppliers"("email");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints
--
-- Hand-written: Prisma's schema language has no syntax for CHECK constraints,
-- so they are appended here. They are the rules that keep the rows themselves
-- valid, in the same way the foreign keys above keep the relationships valid —
-- money is never negative, a line always moves at least one unit, and the stock
-- ledger's arithmetic has to add up.
-- ---------------------------------------------------------------------------

-- Money and quantities are never negative.
ALTER TABLE "products"
  ADD CONSTRAINT "products_cost_price_non_negative" CHECK ("cost_price" >= 0),
  ADD CONSTRAINT "products_selling_price_non_negative" CHECK ("selling_price" >= 0),
  ADD CONSTRAINT "products_stock_quantity_non_negative" CHECK ("stock_quantity" >= 0),
  ADD CONSTRAINT "products_minimum_stock_non_negative" CHECK ("minimum_stock" >= 0);

-- A document's totals have to agree with the parts they are made of:
-- total = subtotal - discount + tax, and you cannot discount more than the
-- goods are worth.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_non_negative"
    CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "tax" >= 0 AND "total" >= 0),
  ADD CONSTRAINT "orders_discount_within_subtotal" CHECK ("discount" <= "subtotal"),
  ADD CONSTRAINT "orders_total_balances" CHECK ("total" = "subtotal" - "discount" + "tax");

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_total_non_negative" CHECK ("total" >= 0);

-- A line moves at least one unit, and its total is that quantity times the
-- price recorded on the line.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_unit_price_non_negative" CHECK ("unit_price" >= 0),
  ADD CONSTRAINT "order_items_total_balances" CHECK ("total" = "quantity" * "unit_price");

ALTER TABLE "purchase_items"
  ADD CONSTRAINT "purchase_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "purchase_items_unit_cost_non_negative" CHECK ("unit_cost" >= 0),
  ADD CONSTRAINT "purchase_items_total_balances" CHECK ("total" = "quantity" * "unit_cost");

-- The ledger. `quantity` is the size of the move and `type` carries the
-- direction, so the two stock columns must be reachable from each other by
-- exactly that amount — a row that claims to remove 5 units but leaves the
-- balance unchanged is a bug, and this is where it stops.
ALTER TABLE "stock_transactions"
  ADD CONSTRAINT "stock_transactions_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "stock_transactions_stock_non_negative"
    CHECK ("previous_stock" >= 0 AND "new_stock" >= 0),
  ADD CONSTRAINT "stock_transactions_arithmetic_balances" CHECK (
    ("type" = 'STOCK_IN' AND "new_stock" = "previous_stock" + "quantity")
    OR ("type" = 'STOCK_OUT' AND "new_stock" = "previous_stock" - "quantity")
    OR ("type" IN ('ADJUSTMENT', 'REVERSAL') AND abs("new_stock" - "previous_stock") = "quantity")
  ),
  -- The polymorphic reference cannot be a foreign key, so at least keep the
  -- two halves consistent: a reference id is present for every type except
  -- MANUAL, and absent for MANUAL.
  ADD CONSTRAINT "stock_transactions_reference_pairing" CHECK (
    ("reference_type" = 'MANUAL') = ("reference_id" IS NULL)
  );
