-- Add the Supabase Auth identity key to `users`.
--
-- Nullable and unindexed-for-NULLs on purpose. The column means "this row has
-- been adopted by a Supabase identity"; NULL means "still claimable". Existing
-- rows are deliberately not backfilled — there is no Supabase user to point
-- them at yet, and inventing one would be the opposite of an identity key.
--
-- A unique index rather than a unique constraint is what Prisma emits, and it
-- is the right shape here: PostgreSQL treats NULLs as distinct in a unique
-- index, so every unlinked row coexists while no two rows can ever share a
-- Supabase user id.
--
-- `clerk_id` is untouched and stays NOT NULL. Both identity columns coexist for
-- the duration of the migration away from Clerk; neither is derived from the
-- other, and nothing here reads or writes a row's data.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "supabase_user_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_supabase_user_id_key" ON "users"("supabase_user_id");
