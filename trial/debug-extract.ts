import { extractAddress, applyAddressHomophones } from "../client/src/lib/extract-address";
const cases = [
  "west shore and gandy boulevard, florida tag 10-50",
  "signal four at fowler fletcher",
  "mva kennedy in himes",
  "on waters and 30th",
  "signal 4 at dealt maybury highway and sligh",
];
for (const t of cases) {
  console.log("IN :", t);
  console.log("FIX:", applyAddressHomophones(t));
  console.log("OUT:", JSON.stringify(extractAddress(t)));
  console.log();
}
