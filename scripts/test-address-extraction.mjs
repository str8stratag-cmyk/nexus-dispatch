import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reconcilerPath = join(__dirname, "..", "trial", "reconciler.mjs");
const reconcilerCode = readFileSync(reconcilerPath, "utf-8");

// Extract TAMPA_STREETS and ADDRESS_CORRECTIONS by evaluating the module-ish code.
// Simpler: import the module and re-implement the helpers exactly as in reconciler.
import(join(__dirname, "..", "trial", "reconciler.mjs")).then((m) => {
  console.log("Module exports:", Object.keys(m));
});
