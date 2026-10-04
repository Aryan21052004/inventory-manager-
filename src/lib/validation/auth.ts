/**
 * Validation and message rules for the authentication screens.
 *
 * Pure on purpose. Everything here is a decision about what the user is told,
 * and those decisions are the ones with security consequences — so they live in
 * a module that can be read in one sitting and tested without a browser, rather
 * than being spread through four form components.
 *
 * ## The rule these exist to enforce
 *
 * **Nothing the user sees may reveal whether an email address has an account.**
 * An unauthenticated form that answers that question is an account-enumeration
 * oracle: it lets anyone confirm which of their targets uses this installation.
 * The consequence runs against instinct — a wrong password and an unknown
 * address must produce the *same* message, even though a more specific one would
 * be friendlier — so the generic wording is centralised here where it cannot
 * drift back to being helpful.
 *
 * The one exception is an unconfirmed email, and it is only safe because the
 * person has already proved they hold the password.
 */

/**
 * Supabase enforces its own minimum (six by default, configurable per project),
 * so this is a floor rather than the rule. Checking here as well means the
 * obvious mistake is caught without a round trip, and the server stays the
 * authority.
 */
export const MIN_PASSWORD_LENGTH = 8;

export interface AuthFieldErrors {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: AuthFieldErrors };

/**
 * Deliberately permissive. A form is not the place to adjudicate RFC 5322, and a
 * clever pattern that rejects a real address is worse than a vague one that lets
 * the server decide: the user cannot argue with a regex. This catches the typo
 * (no `@`, nothing after the dot) and nothing else.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

function emailError(value: string): string | undefined {
  const email = normaliseEmail(value);
  if (!email) return "Enter your email address.";
  if (!EMAIL_SHAPE.test(email)) return "Enter a valid email address.";
  return undefined;
}

function passwordError(value: string): string | undefined {
  if (!value) return "Enter your password.";
  return undefined;
}

function newPasswordError(value: string): string | undefined {
  if (!value) return "Choose a password.";
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return undefined;
}

function prune(errors: AuthFieldErrors): AuthFieldErrors {
  return Object.fromEntries(
    Object.entries(errors).filter(([, message]) => message !== undefined),
  );
}

const hasAny = (errors: AuthFieldErrors) => Object.keys(errors).length > 0;

export function validateSignIn(input: {
  email: string;
  password: string;
}): Validated<{ email: string; password: string }> {
  const errors = prune({
    email: emailError(input.email),
    password: passwordError(input.password),
  });

  if (hasAny(errors)) return { ok: false, errors };

  return {
    ok: true,
    value: { email: normaliseEmail(input.email), password: input.password },
  };
}

export function validateSignUp(input: {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}): Validated<{ name: string; email: string; password: string }> {
  const name = input.name.trim();

  const errors = prune({
    name: name ? undefined : "Enter your name.",
    email: emailError(input.email),
    password: newPasswordError(input.password),
    /*
     * Reported against the confirmation field, not the password. The user has
     * not necessarily mistyped the password — they have mistyped one of the two,
     * and pointing at the second is the convention they expect. Only flagged
     * once the password itself is otherwise acceptable, so a short password does
     * not produce two complaints about one mistake.
     */
    confirmPassword:
      newPasswordError(input.password) === undefined &&
      input.password !== input.confirmPassword
        ? "Both passwords must match."
        : undefined,
  });

  if (hasAny(errors)) return { ok: false, errors };

  return {
    ok: true,
    value: { name, email: normaliseEmail(input.email), password: input.password },
  };
}

/** The forgotten-password form: an address and nothing else. */
export function validatePasswordResetRequest(input: {
  email: string;
}): Validated<{ email: string }> {
  const errors = prune({ email: emailError(input.email) });

  if (hasAny(errors)) return { ok: false, errors };

  return { ok: true, value: { email: normaliseEmail(input.email) } };
}

/** Choosing a replacement password, having arrived from a recovery link. */
export function validateNewPassword(input: {
  password: string;
  confirmPassword: string;
}): Validated<{ password: string }> {
  const errors = prune({
    password: newPasswordError(input.password),
    confirmPassword:
      newPasswordError(input.password) === undefined &&
      input.password !== input.confirmPassword
        ? "Both passwords must match."
        : undefined,
  });

  if (hasAny(errors)) return { ok: false, errors };

  return { ok: true, value: { password: input.password } };
}

// ---------------------------------------------------------------------------
// What the user is told when the provider says no
// ---------------------------------------------------------------------------

/**
 * One message for every way a sign-in can fail to match.
 *
 * Wrong password, no such account, deleted account — all the same sentence. The
 * alternative tells an attacker which addresses are worth attacking.
 */
export const SIGN_IN_FAILED =
  "That email and password do not match an account.";

/**
 * Safe to be specific: reaching this means the password was right, so the person
 * already knows the account exists.
 */
export const EMAIL_NOT_CONFIRMED =
  "Check your inbox and confirm your email address before signing in.";

const RATE_LIMITED =
  "Too many attempts. Wait a few minutes before trying again.";

const GENERIC_FAILURE =
  "Something went wrong. Try again, and if it keeps happening contact an administrator.";

/**
 * The shape of an error from `@supabase/supabase-js`, structurally, so this stays
 * testable without constructing one.
 */
export interface AuthErrorLike {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}

/**
 * Turns a provider error into something safe to display.
 *
 * Supabase's own messages are not written with enumeration in mind — "User
 * already registered" is a direct answer to the question this form must not
 * answer — so none of them are passed through. The error's *code* is read and a
 * sentence of ours is chosen; anything unrecognised falls back to a generic one
 * rather than leaking the original.
 */
export function signInErrorMessage(error: AuthErrorLike | null): string {
  if (!error) return GENERIC_FAILURE;

  if (isEmailNotConfirmed(error)) return EMAIL_NOT_CONFIRMED;
  if (isRateLimited(error)) return RATE_LIMITED;
  if (isInvalidCredentials(error)) return SIGN_IN_FAILED;

  return GENERIC_FAILURE;
}

/** For the flows where there is nothing specific worth saying. */
export function genericErrorMessage(error: AuthErrorLike | null): string {
  if (error && isRateLimited(error)) return RATE_LIMITED;
  return GENERIC_FAILURE;
}

function isEmailNotConfirmed(error: AuthErrorLike): boolean {
  return (
    error.code === "email_not_confirmed" ||
    /not confirmed/i.test(error.message ?? "")
  );
}

function isRateLimited(error: AuthErrorLike): boolean {
  return (
    error.status === 429 ||
    error.code === "over_request_rate_limit" ||
    error.code === "over_email_send_rate_limit"
  );
}

function isInvalidCredentials(error: AuthErrorLike): boolean {
  return (
    error.code === "invalid_credentials" ||
    error.code === "invalid_login_credentials" ||
    /invalid login credentials/i.test(error.message ?? "")
  );
}

// ---------------------------------------------------------------------------
// What a successful sign-up means
// ---------------------------------------------------------------------------

/**
 * A sign-up response, structurally.
 *
 * `identities` is the field that matters and the reason this is a function
 * rather than an `if` in a component. With email confirmation switched on,
 * registering an address that *already* has an account returns a user object
 * with an empty `identities` array rather than an error — Supabase's deliberate
 * way of not confirming the address exists. Treating that as success and showing
 * the same "check your email" screen is what preserves the property; branching
 * on it would re-create the oracle Supabase just closed.
 */
export interface SignUpResultLike {
  user: { identities?: unknown[] | null } | null;
  session: unknown | null;
}

export type SignUpOutcome = "signed-in" | "confirmation-required";

export function signUpOutcome(result: SignUpResultLike): SignUpOutcome {
  // A session means the project has confirmations off and the user is already
  // authenticated; anything else means an email has been sent, or would have
  // been had the address been free.
  return result.session ? "signed-in" : "confirmation-required";
}

export const CONFIRMATION_SENT =
  "Check your email for a link to confirm your address. If an account already " +
  "exists for it, we have sent a sign-in link instead.";

export const PASSWORD_RESET_SENT =
  "If that address has an account, a link to reset the password is on its way. " +
  "Check your inbox.";
