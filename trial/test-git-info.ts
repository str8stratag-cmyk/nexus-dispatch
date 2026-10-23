/**
 * Pure-helper tests for GET /api/health's git branch/sha fields.
 * Run: npx tsx trial/test-git-info.ts
 */
import { computeGitInfo, getGitInfo, resetGitInfoCache } from "../server/git-info";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); } else console.log("ok  :", label);
}

// ---- computeGitInfo: normal success ----
const calls: string[][] = [];
const okExec = (args: string[]) => {
  calls.push(args);
  if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "release\n";
  if (args[0] === "rev-parse" && args.includes("--short")) return "abc1234\n";
  throw new Error("unexpected args: " + args.join(" "));
};
const info = computeGitInfo(okExec);
check("branch parsed", info.branch, "release");
check("sha parsed", info.sha, "abc1234");
check("both git calls made", calls.length, 2);

// ---- computeGitInfo: git unavailable (e.g. ENOENT, not a repo) ----
const failExec = (_args: string[]) => {
  throw new Error("git: command not found");
};
const unavailable = computeGitInfo(failExec);
check("git unavailable: branch null, not throw", unavailable.branch, null);
check("git unavailable: sha null, not throw", unavailable.sha, null);

// ---- computeGitInfo: one call fails, the other succeeds (independent try/catch) ----
const halfExec = (args: string[]) => {
  if (args.includes("--abbrev-ref")) throw new Error("detached HEAD, no branch name");
  return "def5678\n";
};
const half = computeGitInfo(halfExec);
check("partial failure: branch null", half.branch, null);
check("partial failure: sha still populated", half.sha, "def5678");

// ---- computeGitInfo: empty output treated as null, not "" ----
const emptyExec = (_args: string[]) => "";
const empty = computeGitInfo(emptyExec);
check("empty output -> null branch", empty.branch, null);
check("empty output -> null sha", empty.sha, null);

// ---- getGitInfo: cached after first call (exec not called again) ----
resetGitInfoCache();
let callCount = 0;
const countingExec = (args: string[]) => {
  callCount++;
  return args.includes("--abbrev-ref") ? "main" : "f00ba12";
};
const first = getGitInfo(countingExec);
const second = getGitInfo(countingExec);
check("cache: first call populates", first.branch, "main");
check("cache: second call returns same object", second, first);
check("cache: exec only ran for the first call (2 git invocations total)", callCount, 2);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
