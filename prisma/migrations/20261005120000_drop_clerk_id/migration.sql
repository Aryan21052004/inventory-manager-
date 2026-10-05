-- Drop the last of the Clerk identity mapping.
--
-- `supabase_user_id` has been the only identity key since
-- 20261004130000_user_supabase_identity. Nothing has read `clerk_id` since the
-- Clerk runtime was removed; its only writer was a placeholder that existed
-- solely to satisfy this column's NOT NULL, and that writer goes with it.
--
-- Nothing else depends on the column: no foreign key references it (all eight
-- into `users` reference `id`), and there are no views, functions, triggers,
-- policies, defaults or publications over it. Its column-level grants are
-- dropped with it.
--
-- `IF EXISTS` on both statements because `prisma migrate deploy` applies a
-- migration's statements individually rather than wrapping them in one
-- transaction, so a failure part-way leaves the earlier ones committed and the
-- file has to be safe to re-run. Dropping the column would remove its unique
-- index implicitly; the explicit DROP INDEX is what Prisma generates, and
-- running it first is harmless.
--
-- Irreversible. The column holds the historical Clerk account id and no copy is
-- kept anywhere. Re-adding the column would not recover the value.

-- DropIndex
DROP INDEX IF EXISTS "users_clerk_id_key";

-- AlterTable
ALTER TABLE "users" DROP COLUMN IF EXISTS "clerk_id";
