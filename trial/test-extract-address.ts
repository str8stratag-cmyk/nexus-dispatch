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
  // "bushed" (2026-09-30 call review, real missed/garbled call): \bbush\b
  // alone doesn't match "bushed" - no word boundary between "bush" and "ed".
  ["there's a signal 4 with injuries, eastbound bushed", "eastbound Busch Blvd", null],
  // Selmon/Crosstown Expressway (2026-09-30 call review, real DISP-5 event
  // that went to quarantine instead of resolving): Whisper heard "Selmon"
  // as "settlement".
  ["this is 22nd street and settlement expressway also known as the crosstown expressway", "22nd street", "Selmon Expy"],
  ["signal 4 on the crosstown expressway", "Selmon Expy", null],
  ["signal 4 on the crosstown", "Selmon Expy", null],
  ["signal 4 on the salmon expressway", "Selmon Expy", null],
  ["signal 4 on the sandman expressway", "Selmon Expy", null],
  ["signal 4 on the sellman expressway", "Selmon Expy", null],
  // Bare, no "expressway" said - the common case (user, 2026-09-30: ~98% of
  // real traffic omits it). Accepted tradeoff: this also means a literal,
  // unrelated "salmon"/"sandman" mention would get rewritten too - judged
  // unlikely enough in dispatch-radio context to be worth it.
  ["signal 4 on the salmon", "Selmon Expy", null],
  ["signal 4 on sandman", "Selmon Expy", null],
  ["on floribraska near sligh", "Nebraska Ave", "Sligh Ave"],
  ["signal four at fowler fletcher", "Fletcher Ave", "Fowler Ave"],
  ["two fifty eastbounder on 50th", "50th St", null],
  ["mva kennedy in himes", "Kennedy Blvd", "Himes Ave"],
  ["on waters and 30th", "30th St", "Waters Ave"],
  ["on columbus and broadway", "Columbus Ave", "Broadway Ave"],
  // Bruce B Downs mishearings (2026-09-25 DISP-3 09:07 miss, real call was
  // "Signal 4 at Bruce B Downs and Fowler, accident call")
  ["See you at 2-1-7-34. You're holding a single floor with an injury, crispy downs, and sour, and fine. Signal 4 at Bruce Viana, I'll bring my ", "Bruce B Downs Blvd", null],
  ["signal 4 at bruce b downs and fowler", "Bruce B Downs Blvd", "Fowler Ave"],
  ["signal 4 at bruce b. downs and fowler", "Bruce B Downs Blvd", "Fowler Ave"],
  ["signal 4 at bruce v downs and fowler", "Bruce B Downs Blvd", "Fowler Ave"],
  ["signal 4 at bruce be downs and fouler", "Bruce B Downs Blvd", "Fowler Ave"],
  ["signal 4 at bruce downs and fowlers", "Bruce B Downs Blvd", "Fowler Ave"],
  ["mva brucey downs boulevard at fletcher", "Bruce B Downs Blvd", "Fletcher Ave"],
  ["signal four, crispy downs and fowler", "Bruce B Downs Blvd", "Fowler Ave"],
  ["accident at bruce viana and fowler", "Bruce B Downs Blvd", "Fowler Ave"],
  // Sound-alikes that must NOT invent streets
  ["bruce is on scene, the car is upside down", null, null],
  ["ups and downs all morning", null, null],
  ["that smells sour, and fine by me", null, null],
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
  ["signal 4 at bruce viana", false], // not in MAJOR_ROAD_RE; extraction still works
];
for (const [t, want] of roadCases) {
  const got = containsMajorRoad(t);
  if (got !== want) { fail++; console.log("ROAD FAIL:", t.slice(0, 60), "got", got, "want", want); }
  else console.log("road ok (" + got + "):", t.slice(0, 60));
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
