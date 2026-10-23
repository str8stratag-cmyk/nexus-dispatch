/**
 * Pure-helper tests for admin auth: PIN format, constant-time compare, lockout.
 * Run: npx tsx trial/test-admin-auth.ts
 */
import { isValidAdminSecretFormat, secureCompare, LoginLockout, LOCKOUT_MAX_ATTEMPTS } from "../server/admin-auth";

let fail = 0;

function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log("FAIL:", label, "| got:", got, "| want:", want);
  } else {
    console.log("ok  :", label);
  }
}

// PIN format: exactly 4 digits.
check("format valid", isValidAdminSecretFormat("1234"), true);
check("format valid zeros", isValidAdminSecretFormat("0000"), true);
check("format too short", isValidAdminSecretFormat("123"), false);
check("format too long", isValidAdminSecretFormat("12345"), false);
check("format letters", isValidAdminSecretFormat("abcd"), false);
check("format mixed", isValidAdminSecretFormat("12a4"), false);
check("format empty", isValidAdminSecretFormat(""), false);
check("format undefined", isValidAdminSecretFormat(undefined), false);
check("format whitespace", isValidAdminSecretFormat(" 1234"), false);

// Constant-time compare: must behave like ===, including length mismatches.
check("compare equal", secureCompare("1234", "1234"), true);
check("compare different", secureCompare("1234", "5678"), false);
check("compare different length shorter", secureCompare("123", "1234"), false);
check("compare different length longer", secureCompare("12345", "1234"), false);
check("compare empty vs empty", secureCompare("", ""), true);
check("compare empty vs nonempty", secureCompare("", "1234"), false);

// Lockout: N wrong attempts locks the key out for the configured window.
{
  let now = 1_000_000;
  const lockout = new LoginLockout(5, 15 * 60 * 1000, () => now);

  check("not locked initially", lockout.checkLocked("1.2.3.4"), null);
  for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS - 1; i++) lockout.recordFailure("1.2.3.4");
  check("not locked after 4 failures", lockout.checkLocked("1.2.3.4"), null);

  lockout.recordFailure("1.2.3.4");
  const locked = lockout.checkLocked("1.2.3.4");
  check("locked after 5th failure", locked !== null, true);

  now += 10 * 60 * 1000;
  const stillLocked = lockout.checkLocked("1.2.3.4");
  check("still locked after 10 of 15 min", stillLocked !== null, true);

  now += 6 * 60 * 1000;
  check("unlocked after 16 min total", lockout.checkLocked("1.2.3.4"), null);
}

{
  // A different IP is tracked independently.
  let now = 0;
  const lockout = new LoginLockout(5, 15 * 60 * 1000, () => now);
  for (let i = 0; i < 5; i++) lockout.recordFailure("1.1.1.1");
  check("other IP unaffected", lockout.checkLocked("2.2.2.2"), null);
  check("offending IP locked", lockout.checkLocked("1.1.1.1") !== null, true);
}

{
  // A success clears prior failures so a mistyped PIN doesn't linger toward a lockout.
  let now = 0;
  const lockout = new LoginLockout(5, 15 * 60 * 1000, () => now);
  lockout.recordFailure("3.3.3.3");
  lockout.recordFailure("3.3.3.3");
  lockout.recordSuccess("3.3.3.3");
  for (let i = 0; i < 4; i++) lockout.recordFailure("3.3.3.3");
  check("reset by success, 4 more failures not enough", lockout.checkLocked("3.3.3.3"), null);
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
