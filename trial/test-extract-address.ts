import { extractAddress, containsMajorRoad } from "../client/src/lib/extract-address";

const cases: [string, string | null, string | null][] = [
  // The reported call: Gandy Blvd & Dale Mabry
  ["signal four, gandhi boulevard in dale mason", "Gandy Blvd", "Dale Mabry"],
  ["signal four, gandhi boulevard in dale mason. No paper is being pulled into the parking lot.", "Gandy Blvd", "Dale Mabry"],
  // Cross-street pairs
  ["signal 4 at dale mabry and linebaugh", "Dale Mabry", "Linebaugh"],
  ["signal 4 at dealt maybury highway and sligh", "Dale Mabry highway", "Sligh Ave"],
  ["signal 4 on hillsbough and 40th", "40th St", "Hillsborough Ave"],
  ["west shore and gandy boulevard, florida tag 10-50", "West Shore Blvd", "Gandy Blvd"],
  ["signal four, cypress and dale mabry", "Dale Mabry", "cypress"],
  // Numbered addresses unchanged
  ["mva at 808 north linebaugh avenue", "808 north Linebaugh avenue", null],
  // Bare major roads now extract (user request)
  ["SIGNAL 4 A HILLSBOROUGH AND ARMENIA", "Hillsborough Ave", null],
  ["break on busch and 56th", "56th St", "Busch Blvd"],
  ["on floribraska near sligh", "Nebraska Ave", "Sligh Ave"],
  ["signal four at fowler fletcher", "Fletcher Ave", "Fowler Ave"],
  ["two fifty eastbounder on 50th", "50th St", null],
  ["mva kennedy in himes", "Kennedy Blvd", "Himes Ave"],
  ["on waters and 30th", "30th St", "Waters Ave"],
  ["on columbus and broadway", "Columbus Ave", "Broadway Ave"],
  // Protected phrases must NOT extract
  ["Hillsborough County Sheriff units clear", null, null],
  ["the state of Florida highway patrol", "Florida highway", null],
  ["Busch Gardens traffic on the interstate", null, null],
  ["memorial parkway exit closed", "Memorial Parkway", null],
  // Known limitation: "ran off road" triggers the ROAD suffix (pre-existing)
  ["signal 4 NISSAN MURANO RAN OFF ROAD INTO TRESS AT ON RAMP OF 275 AND DALE MABRY", "4 NISSAN MURANO RAN OFF ROAD", "Dale Mabry"],
];

let fail = 0;
for (const [t, wantAddr, wantCross] of cases) {
  const r = extractAddress(t);
  const norm = (s: string | null) => (s || "").toLowerCase();
  const ok = norm(r.address) === norm(wantAddr) && norm(r.crossStreet) === norm(wantCross);
  if (!ok) {
    fail++;
    console.log("FAIL:", t.slice(0, 70));
    console.log("   got: ", r.address, "&", r.crossStreet, "| want:", wantAddr, "&", wantCross);
  } else {
    console.log("ok  :", r.address, "&", r.crossStreet);
  }
}

const roadCases: [string, boolean][] = [
  ["his is going to be Nora, Mike, come back. Julius, you're... I'll give you a two-five-zero, eastbounder, signal five-one-one-one-one. signal four, gandhi boulevard in dale mason.", true],
  ["break on busch and 56th", true],
  ["on floribraska near sligh", true],
  ["unit responding, nothing else", false],
  ["thank you, bye-bye, static", false],
  ["the state of Florida highway patrol is assisting", false],
  ["Hillsborough County Sheriff clear of the call", false],
];
for (const [t, want] of roadCases) {
  const got = containsMajorRoad(t);
  if (got !== want) { fail++; console.log("ROAD FAIL:", t.slice(0, 60), "got", got, "want", want); }
  else console.log("road ok (" + got + "):", t.slice(0, 60));
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
