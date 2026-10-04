import { describe, expect, it } from "vitest";

import { supabaseIdentityFrom } from "@/server/auth";

import { fakeSupabaseUser } from "./supabase-auth-mock";

/**
 * The rules that decide whether a Supabase session may be trusted at all.
 *
 * These need no database, which is the point of `supabaseIdentityFrom` being a
 * pure function: the decisions that gate privilege escalation are the ones most
 * worth testing, and they should not be reachable only through a round trip to
 * Postgres. The claim-and-create behaviour that follows a usable identity lives
 * in `supabase-auth.test.ts`, against a real database.
 */

describe("rejecting sessions that cannot be mapped safely", () => {
  it("refuses a user with no email address", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "unused@example.com", { email: null }),
    );

    expect(identity).toBeNull();
  });

  it("refuses a user whose email is an empty string", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "unused@example.com", { email: "   " }),
    );

    expect(identity).toBeNull();
  });

  /*
   * The important one. Email is the key that adopts an existing row along with
   * its role, so an unproven address would let anyone who can type an
   * administrator's email inherit the administrator's account.
   */
  it("refuses a user whose email is not verified", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "admin@example.com", {
        email_confirmed_at: null,
      }),
    );

    expect(identity).toBeNull();
  });

  it("refuses a user whose email verification is absent entirely", () => {
    const identity = supabaseIdentityFrom({
      id: "sb_1",
      email: "admin@example.com",
    });

    expect(identity).toBeNull();
  });

  it("refuses an anonymous session even when it carries an email", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_anon", "admin@example.com", { is_anonymous: true }),
    );

    expect(identity).toBeNull();
  });
});

describe("accepting a usable session", () => {
  it("returns the Supabase id and email", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_42", "person@example.com"),
    );

    expect(identity).not.toBeNull();
    expect(identity?.supabaseUserId).toBe("sb_42");
    expect(identity?.email).toBe("person@example.com");
  });

  /*
   * `users.email` is unique, so two spellings of one address must not be able
   * to become two rows. Normalising here means the adoption lookup and the
   * create path both see the same string.
   */
  it("normalises the email so one address cannot become two accounts", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_42", "  Person@Example.COM  "),
    );

    expect(identity?.email).toBe("person@example.com");
  });

  it("keeps the Supabase id exactly as given", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("  sb_padded  ", "person@example.com"),
    );

    // Deliberately not trimmed: the id is an opaque key, and altering it would
    // be inventing a different one.
    expect(identity?.supabaseUserId).toBe("  sb_padded  ");
  });
});

describe("deriving a display name", () => {
  it("prefers full_name", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "person@example.com", {
        user_metadata: { full_name: "Ada Lovelace", name: "ignored" },
      }),
    );

    expect(identity?.name).toBe("Ada Lovelace");
  });

  it("falls back through name, user_name and preferred_username", () => {
    const byName = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "person@example.com", {
        user_metadata: { name: "Grace Hopper" },
      }),
    );
    expect(byName?.name).toBe("Grace Hopper");

    const byUserName = supabaseIdentityFrom(
      fakeSupabaseUser("sb_2", "person2@example.com", {
        user_metadata: { user_name: "ghopper" },
      }),
    );
    expect(byUserName?.name).toBe("ghopper");

    const byPreferred = supabaseIdentityFrom(
      fakeSupabaseUser("sb_3", "person3@example.com", {
        user_metadata: { preferred_username: "grace" },
      }),
    );
    expect(byPreferred?.name).toBe("grace");
  });

  it("uses the local part of the email when metadata carries no name", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "warehouse.lead@example.com"),
    );

    expect(identity?.name).toBe("warehouse.lead");
  });

  it("ignores metadata values that are not usable strings", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "person@example.com", {
        // A provider can put anything in here, including the wrong type.
        user_metadata: { full_name: "   ", name: 42, user_name: null },
      }),
    );

    expect(identity?.name).toBe("person");
  });

  it("trims a name that arrives padded", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "person@example.com", {
        user_metadata: { full_name: "  Ada Lovelace  " },
      }),
    );

    expect(identity?.name).toBe("Ada Lovelace");
  });

  it("never returns an empty name", () => {
    const identity = supabaseIdentityFrom(
      fakeSupabaseUser("sb_1", "person@example.com", { user_metadata: {} }),
    );

    expect(identity?.name).not.toBe("");
    expect(identity?.name.trim()).toBe(identity?.name);
  });
});
