import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_SENT,
  EMAIL_NOT_CONFIRMED,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_SENT,
  SIGN_IN_FAILED,
  genericErrorMessage,
  signInErrorMessage,
  signUpOutcome,
  validateNewPassword,
  validatePasswordResetRequest,
  validateSignIn,
  validateSignUp,
} from "@/lib/validation/auth";

/**
 * The rules behind the authentication screens.
 *
 * These are the decisions with security consequences — what the user is told
 * when a sign-in fails, and whether that answer reveals which email addresses
 * have accounts — so they live in a pure module and are tested without a browser
 * or a database. The forms that use them contain no branching of their own.
 *
 * The repository's Vitest environment is Node, with no DOM, and this stage
 * deliberately does not add one: a jsdom harness would be testing React, while
 * the thing worth protecting is the wording.
 */

describe("sign-in validation", () => {
  it("requires an email address", () => {
    const result = validateSignIn({ email: "  ", password: "hunter2hunter2" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toBeDefined();
  });

  it("rejects an address with no @ or no domain", () => {
    for (const email of ["nope", "nope@", "@example.com", "a@b"]) {
      const result = validateSignIn({ email, password: "hunter2hunter2" });
      expect(result.ok, email).toBe(false);
    }
  });

  it("requires a password", () => {
    const result = validateSignIn({ email: "a@example.com", password: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.password).toBeDefined();
  });

  /*
   * No minimum length on sign-in. The rule belongs on the field where a password
   * is chosen; applying it here would tell someone with an older, shorter
   * password that their account exists but their password is now invalid.
   */
  it("does not impose a length rule when signing in", () => {
    const result = validateSignIn({ email: "a@example.com", password: "old" });

    expect(result.ok).toBe(true);
  });

  it("normalises the email and leaves the password untouched", () => {
    const result = validateSignIn({
      email: "  Person@Example.COM ",
      password: "  spaces matter  ",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBe("person@example.com");
      expect(result.value.password).toBe("  spaces matter  ");
    }
  });
});

describe("sign-up validation", () => {
  const valid = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "longenoughpassword",
    confirmPassword: "longenoughpassword",
  };

  it("accepts a complete form", () => {
    expect(validateSignUp(valid).ok).toBe(true);
  });

  it("requires a name", () => {
    const result = validateSignUp({ ...valid, name: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeDefined();
  });

  it("trims the name", () => {
    const result = validateSignUp({ ...valid, name: "  Ada  " });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Ada");
  });

  it("enforces a minimum password length", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const result = validateSignUp({
      ...valid,
      password: short,
      confirmPassword: short,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.password).toContain("characters");
  });

  it("refuses mismatched passwords", () => {
    const result = validateSignUp({
      ...valid,
      confirmPassword: "somethingelse",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.confirmPassword).toBeDefined();
  });

  /*
   * One mistake, one message. A short password that is also mistyped used to be
   * reported twice, which reads as two problems.
   */
  it("does not also complain about the confirmation when the password is too short", () => {
    const result = validateSignUp({
      ...valid,
      password: "short",
      confirmPassword: "different",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.password).toBeDefined();
      expect(result.errors.confirmPassword).toBeUndefined();
    }
  });

  it("does not carry the confirmation into the submitted value", () => {
    const result = validateSignUp(valid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual([
        "email",
        "name",
        "password",
      ]);
    }
  });
});

describe("password reset validation", () => {
  it("requires a valid email to request a reset", () => {
    expect(validatePasswordResetRequest({ email: "" }).ok).toBe(false);
    expect(validatePasswordResetRequest({ email: "nope" }).ok).toBe(false);
    expect(validatePasswordResetRequest({ email: "a@example.com" }).ok).toBe(
      true,
    );
  });

  it("enforces length and matching on a new password", () => {
    expect(
      validateNewPassword({ password: "short", confirmPassword: "short" }).ok,
    ).toBe(false);
    expect(
      validateNewPassword({
        password: "longenoughpassword",
        confirmPassword: "longenoughpasswors",
      }).ok,
    ).toBe(false);
    expect(
      validateNewPassword({
        password: "longenoughpassword",
        confirmPassword: "longenoughpassword",
      }).ok,
    ).toBe(true);
  });
});

describe("what a failed sign-in is allowed to say", () => {
  /*
   * The property that matters: an unknown address and a wrong password must be
   * indistinguishable. Anything else is an account-enumeration oracle on an
   * unauthenticated form.
   */
  it("gives the same message for a wrong password and an unknown account", () => {
    const wrongPassword = signInErrorMessage({
      code: "invalid_credentials",
      message: "Invalid login credentials",
    });
    const noSuchUser = signInErrorMessage({
      code: "invalid_credentials",
      message: "Invalid login credentials",
      status: 400,
    });

    expect(wrongPassword).toBe(SIGN_IN_FAILED);
    expect(noSuchUser).toBe(SIGN_IN_FAILED);
  });

  it("never passes a provider message through", () => {
    const leaky = signInErrorMessage({
      code: "something_new",
      message: "User already registered with a different provider",
    });

    expect(leaky).not.toContain("already registered");
    expect(leaky).not.toContain("provider");
  });

  it("does say when an email is unconfirmed, because the password was right", () => {
    expect(signInErrorMessage({ code: "email_not_confirmed" })).toBe(
      EMAIL_NOT_CONFIRMED,
    );
    expect(signInErrorMessage({ message: "Email not confirmed" })).toBe(
      EMAIL_NOT_CONFIRMED,
    );
  });

  it("recognises a rate limit from the status alone", () => {
    const limited = signInErrorMessage({ status: 429 });

    expect(limited).toMatch(/too many/i);
    expect(limited).not.toBe(SIGN_IN_FAILED);
  });

  it("falls back to something generic for an unrecognised error", () => {
    const unknown = signInErrorMessage({ code: "brand_new_code" });

    expect(unknown).toMatch(/something went wrong/i);
  });

  it("handles a null error without throwing", () => {
    expect(() => signInErrorMessage(null)).not.toThrow();
    expect(() => genericErrorMessage(null)).not.toThrow();
  });

  it("keeps the generic mapper free of specifics", () => {
    const message = genericErrorMessage({
      code: "user_already_exists",
      message: "User already registered",
    });

    expect(message).not.toMatch(/already/i);
  });
});

describe("what a successful sign-up means", () => {
  it("treats a session as being signed in", () => {
    expect(signUpOutcome({ user: { identities: [{}] }, session: {} })).toBe(
      "signed-in",
    );
  });

  it("treats no session as needing confirmation", () => {
    expect(
      signUpOutcome({ user: { identities: [{}] }, session: null }),
    ).toBe("confirmation-required");
  });

  /*
   * The non-disclosure case. Registering an address that already has an account
   * returns a user with no identities and no session, and it must be
   * indistinguishable from a genuine new registration.
   */
  it("treats an already-registered address exactly like a new one", () => {
    const fresh = signUpOutcome({ user: { identities: [{}] }, session: null });
    const existing = signUpOutcome({ user: { identities: [] }, session: null });

    expect(existing).toBe(fresh);
  });

  it("does not reveal existence in either standing message", () => {
    for (const message of [CONFIRMATION_SENT, PASSWORD_RESET_SENT]) {
      expect(message).not.toMatch(/\bno account\b/i);
      expect(message).not.toMatch(/\bnot (found|registered)\b/i);
      expect(message).not.toMatch(/\bdoes ?n[o']?t exist\b/i);
    }

    // The reset message is explicitly conditional rather than confirming.
    expect(PASSWORD_RESET_SENT).toMatch(/if that address has an account/i);
  });
});
