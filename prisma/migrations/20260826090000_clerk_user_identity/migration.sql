-- Clerk owns authentication; this table owns local identity and authorisation.
--
-- Written by hand rather than generated. `prisma migrate diff` produces
-- `ADD COLUMN "clerk_id" TEXT NOT NULL` with no default, which fails outright
-- on a table that already has rows. Existing users are real records — the seed
-- writes two — so the column is added nullable, backfilled, and only then
-- constrained.
--
-- Rows that predate their Clerk account get an `unlinked_<id>` placeholder
-- rather than a null. It satisfies NOT NULL and stays unique, and it is
-- recognisable on sight as "not yet linked": the first sign-in from a Clerk
-- account with a matching email claims the row and replaces the placeholder
-- with the real `user_...` id. Using null for this would have meant a nullable
-- identity key, and every lookup would have had to defend against it forever.

-- AlterTable: add nullable, backfill, then enforce.
ALTER TABLE "users" ADD COLUMN "clerk_id" TEXT;

UPDATE "users" SET "clerk_id" = 'unlinked_' || "id" WHERE "clerk_id" IS NULL;

ALTER TABLE "users" ALTER COLUMN "clerk_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- DropColumn: authentication is Clerk's job. A password column here would be a
-- second credential store that nothing writes to and nothing checks against.
ALTER TABLE "users" DROP COLUMN "password_hash";
