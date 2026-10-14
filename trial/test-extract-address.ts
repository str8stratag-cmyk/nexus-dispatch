import { extractAddress, containsMajorRoad } from "../client/src/lib/extract-address";

const cases: [string, string | null, string | null][] = [
  // 2026-10-14 ~13:00 board misfires: real location E Adamo Dr (SR 60) &
  // Orient Rd, plus 2904 Melbourne Blvd. Never "drive" / "Mo Drive" / "Oria Road".
  ["Signal 4, Adam O. Drive and drive. For the runway and 2904 Melbourne Boulevard...", "2904 Melbourne Boulevard", "Adamo Dr"],
  ["Signal 4 at a Mo Drive in Orient Road", "Orient Road", "Adamo Dr"],
  ["signal four at a Mo Drive in Oria Road", "Orient Rd", "Adamo Dr"],
  ["signal for for Adamo and Orient.", "Adamo Dr", "Orient Rd"],
  ["signal 4 at State Road 60 and Orient Road", "Orient Road", "Adamo Dr"],
  ["signal 4 at Orient Road and SR 60", "Orient Road", "Adamo Dr"],
  // Not aliased away from Orient (SR 60 is also Kennedy / Brandon Blvd).
  ["signal 4 on st rd 60 eastbound", "State Road 60", null],
  ["give me a mo, drive safe", null, null],
  // The reported call: Gandy Blvd & Dale Mabry
  ["signal four, gandhi boulevard in dale mason", "Gandy Blvd", "Dale Mabry"],
  ["signal four, gandhi boulevard in dale mason. No paper is being pulled into the parking lot.", "Gandy Blvd", "Dale Mabry"],
  // Cross-street pairs
  ["signal 4 at dale mabry and linebaugh", "Dale Mabry", "Linebaugh"],
  ["signal 4 at dealt maybury highway and sligh", "Dale Mabry highway", "Sligh Ave"],
  ["signal 4 on hillsbough and 40th", "40th St", "Hillsborough Ave"],
  ["west shore and gandy boulevard, florida tag 10-50", "West Shore Blvd", "Gandy Blvd"],
  ["signal four, cypress and dale mabry", "Dale Mabry", "cypress"],
  // 2026-10-01 live miss: real call at Cypress & Dale Mabry came out as
  // "Cypress and Delmigras" and never dispatched (no keyword matched).
  ["on the corner of cypress and delmigras", "Dale Mabry", "cypress"],
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
  // "Dale Labrie" -> Dale Mabry (2026-09-30, real DISP-2 quarantine miss).
  ["signal 4, Dale Labrie and Henderson", "Dale Mabry", "Henderson"],
  // Anderson and Henderson are both real Tampa roads: "Anderson" is never
  // rewritten to "Henderson" (owner decision 2026-10-01).
  ["signal our Dale Labrie Anderson, signal 4, Dale Labrie Anderson", "Dale Mabry", null],
  ["signal 4 at Dale Mabry and Anderson", "Dale Mabry", null],
  ["unit responding, officer Anderson on scene", null, null],
  // negative: "Henderson" as a person's name is not a street
  ["unit responding, officer Henderson on scene", null, null],
  // "Dale may be" (2026-09-30, live DISP-5 quarantine miss, near-verbatim)
  ["no signal for Dale may be thank you for your 25th progress to residents", "Dale Mabry", null],
  // negative: a person named Dale must not become Dale Mabry
  ["officer dale may be late to the briefing", null, null],
  // "304 East Handler" (2026-10-01, real quarantine misses across
  // DISP-1/2/5/7, user-confirmed canonical name; near-verbatim transcripts)
  ["signal 304 East handler, 304 East handler. Signal 4 at 304 East Handler.", "304 East handler", null],
  ["Signal. 304 East Tambler, 304 East Tambler. signal 4 at 304 East and", "304 East Handler", null],
  // Armenia Ave & Broad St (2026-10-01, real DISP-2/3 quarantine misses,
  // user-confirmed; near-verbatim transcript)
  ["Broad Street, Siegel 4, Armenia and Broad Street. Signal 4, Barat Street and Armenian Avenue.", "Broad Street", "Armenia Ave"],
  // negative: "Armenian" without "Avenue" (e.g. describing a person) must NOT rewrite
  ["suspect described as an Armenian male", null, null],
  // Broad St only in a street context
  ["signal 4 at armenia and broad", "Armenia Ave", "Broad St"],
  ["signal 4 at west broad", "Broad St", null],
  // negatives: bare "broad"/"barat" and "handler" as an ordinary word
  ["they did it in broad daylight", null, null],
  ["a broad range of units responding", null, null],
  ["caller is mr barat on scene", null, null],
  ["k9 handler responding", null, null],
  ["the k9 handler is on scene with the deputy", null, null],
  ["officer kenney on scene", null, null],
  // Delmarie/"South down Mabry" and Kenney (2026-10-01, real quarantine misses)
  ["1406, North Delmarie Highway and Run 4", "1406, North Dale Mabry Hwy", "Run"],
  ["south down Maybury, good 1-6-5", "Dale Mabry", null],
  ["signal for West Shore, Louisville, and Kenney Boulevard", "West Shore Blvd", "Kennedy Blvd"],
  // "8401 North Carolina Street" (2026-10-01, real quarantine misses on
  // four independent boxes, near-verbatim) - real address is "3401 S
  // Carolina St" (user-confirmed 2026-10-02).
  ["signal 48401 North Carolina Street Signal 4 at 8401 North Carolina Street.", "3401 S Carolina St", null],
  ["There are no injuries. 8401 North Carolina Street.", "3401 S Carolina St", null],
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
  // 2026-10-02 quarantine review - parser false positives (real quarantined
  // transcripts, near-verbatim). "Florida tag/plate" is a plate read, not
  // Florida Ave; "Union <n>" is a unit callsign, not a street; "Hillsborough
  // County Sheriff's office" is the agency, not Hillsborough Ave.
  ["In the West Shore and Wal-Craft It's not Florida tag, but I can't see what the state is.", "West Shore Blvd", null],
  ["Times, Florida tag, Kilo Zoo, Edward, IDA-17, South Black, Jared", null, null],
  ["I'm going to be on a white Honda. That's a pilot. Thanks, Lorcan. You can't be as worried as I am. Florida tag", null, null],
  ["running a florida plate on a silver BMW", null, null],
  ["Union 2, Union 3, copy that update in your home. You can be turned off the signal 3, can you help me out the signal 8 now?", null, null],
  ["Union 5-1 to me. for tax and clean might we get And that's it. 54 for wreck injury, Apollo 13.", null, null],
  ["I'm going to give her a 9.9. Stand apart. I hope our commander, Hillsborough County Sheriff's office.", null, null],
  // ...while real Florida Ave / Union St / Hillsborough Ave addresses still extract
  ["signal 4 at florida and fowler", "Florida Ave", "Fowler Ave"],
  ["Signal 4 at Hillsborough and Florida", "Hillsborough Ave", "Florida Ave"],
  ["crash at 9000 north florida avenue", "9000 north Florida Ave", null],
  ["signal 4 at 1200 Union Street", "1200 Union Street", null],
  ["signal 4 at union street and rome avenue", "union street", "rome avenue"],
  ["signal 4 at 3415 West Hillsborough Avenue", "3415 West Hillsborough Ave", null],
  ["signal 4 on hillsborough near the county line", "Hillsborough Ave", null],
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
  ["Times, Florida tag, Kilo Zoo, Edward, IDA-17", false],
  ["It's not Florida tag, but I can't see what the state is.", false],
  ["I hope our commander, Hillsborough County Sheriff's office.", false],
  ["signal 4 at florida and fowler", true],
  ["signal 4 at bruce viana", false], // not in MAJOR_ROAD_RE; extraction still works
  ["they did it in broad daylight", false],
  ["officer dale may be late to the briefing", false],
];
for (const [t, want] of roadCases) {
  const got = containsMajorRoad(t);
  if (got !== want) { fail++; console.log("ROAD FAIL:", t.slice(0, 60), "got", got, "want", want); }
  else console.log("road ok (" + got + "):", t.slice(0, 60));
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
