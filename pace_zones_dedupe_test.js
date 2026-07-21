// Reproduces the bug reported by the coach: every pace zone on the
// athlete's "Pace guide" card was showing repeated 4x (e.g. "Easy" listed
// four times in a row with the same pace). Root cause: the "Save pace
// zones" handler selected rows with `#paceZoneRows [data-zi]`, which also
// matches the label input, pace input, and Remove button inside each row
// (all four elements carry data-zi) — so a single click of "Save" wrote
// every zone 4 times. Fixed by scoping the selector to `.row-actions[data-zi]`
// (the row wrapper only). normalizePaceZones() also now de-dupes by zone
// name as a second line of defense, so any already-corrupted data self-heals
// the next time it's read or re-saved.
// Same jsdom-over-real-HTTP harness as the other *_test.js files.
process.env.PG_MEM = "1";
process.env.JWT_SECRET = "pace-zones-dedupe-test-secret-pace-zones-dedupe";
process.env.PORT = "8102";

const fs = require("fs");
const { JSDOM } = require("jsdom");
const BASE = "http://localhost:8102";
const html = fs.readFileSync(__dirname + "/index.html", "utf8");

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
let failures = 0;
function log(label, ok) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
}
async function goto(win, hash) {
  win.location.hash = hash;
  win.dispatchEvent(new win.Event("hashchange"));
  await wait(350);
}
function newBrowser(label) {
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: BASE + "/", pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = (url, opts) => fetch(typeof url === "string" && url.startsWith("/") ? BASE + url : url, opts);
  window.onerror = (msg) => console.log(`  [${label} window.onerror] ${msg}`);
  window.addEventListener("unhandledrejection", (e) => console.log(`  [${label} unhandled] ${e.reason}`));
  return window;
}

(async () => {
  require("./server/index.js");
  await wait(400);

  const coach = newBrowser("coach");
  await wait(300);
  await goto(coach, "#/dashboard");
  coach.document.getElementById("authEmail").value = "tom@example.com";
  coach.document.getElementById("authPassword").value = "coachpassword1";
  coach.document.getElementById("authPasswordConfirm").value = "coachpassword1";
  coach.document.getElementById("authSubmit").click();
  await wait(400);

  coach.document.getElementById("addAthleteBtn").click();
  await wait(50);
  coach.document.getElementById("naName").value = "Pat Zoner";
  coach.document.getElementById("naEmail").value = "pat@example.com";
  coach.document.getElementById("naStage").value = "6";
  coach.document.getElementById("naSave").click();
  await wait(400);
  const athleteId = coach.location.hash.split("/").pop();

  coach.document.querySelector('.tab-btn[data-tab="plan"]').click();
  await wait(150);

  // Default zones render blank: Easy, Marathon, Threshold, Interval, Recovery
  // — 5 rows. Fill in the "Easy" row's pace and hit Save ONCE (this alone
  // used to quadruple every zone, before any duplicate rows were involved).
  coach.document.querySelector('.zoneLabel[data-zi="0"]').value = "Easy";
  coach.document.querySelector('.zonePace[data-zi="0"]').value = "5:00-5:40/km";
  coach.document.getElementById("saveZones").click();
  await wait(300);

  const rec = await coach.apiFetch(`/api/athletes/${athleteId}`);
  const savedZones = (rec.plan && rec.plan.paceZones) || [];
  log("1) a single 'Save pace zones' click saves 5 zones, not 20", savedZones.length === 5);
  log("2) 'Easy' was saved exactly once, not 4 times", savedZones.filter(z => z.label === "Easy").length === 1);
  log("3) the saved 'Easy' zone kept the right pace", (savedZones.find(z => z.label === "Easy") || {}).pace === "5:00-5:40/km");

  // Re-open the tab: the coach's editor should also show each zone once.
  coach.document.querySelector('.tab-btn[data-tab="overview"]').click();
  await wait(150);
  coach.document.querySelector('.tab-btn[data-tab="plan"]').click();
  await wait(150);
  const easyRowsInEditor = Array.from(coach.document.querySelectorAll(".zoneLabel")).filter((inp) => inp.value.trim() === "Easy");
  log("4) coach's Plan tab editor shows the 'Easy' row once", easyRowsInEditor.length === 1);

  coach.document.querySelector('.tab-btn[data-tab="overview"]').click();
  await wait(150);
  coach.document.getElementById("setPasswordBtn").click();
  await wait(100);
  coach.document.getElementById("apPassword").value = "athletepass1";
  coach.document.getElementById("apSave").click();
  await wait(400);
  coach.document.getElementById("ovPaymentStatus").value = "active";
  coach.document.getElementById("ovPaymentSave").click();
  await wait(300);

  const athlete = newBrowser("athlete");
  await wait(300);
  await goto(athlete, "#/login");
  athlete.document.getElementById("alEmail").value = "pat@example.com";
  athlete.document.getElementById("alPassword").value = "athletepass1";
  athlete.document.getElementById("alSubmit").click();
  await wait(400);
  await goto(athlete, `#/athlete-view/${athleteId}/dashboard`);

  const paceRows = Array.from(athlete.document.querySelectorAll("table.simple tr")).filter((tr) => tr.querySelector("th") && tr.querySelector("th").textContent.trim() === "Easy");
  log("5) athlete's Pace guide card shows 'Easy' exactly once, not 4x", paceRows.length === 1);
  log("6) the single 'Easy' row still has the right pace", paceRows[0] && paceRows[0].querySelector("td").textContent.trim() === "5:00-5:40/km");

  // ---- Defensive dedupe: simulate an athlete whose data was already
  // corrupted by the old bug (before this fix shipped) and confirm the
  // display self-heals without needing any manual cleanup. ----
  const corrupted = await coach.apiFetch(`/api/athletes/${athleteId}`);
  corrupted.plan.paceZones = [
    { label: "Tempo", pace: "4:00-4:08/km" }, { label: "Tempo", pace: "4:00-4:08/km" },
    { label: "Tempo", pace: "4:00-4:08/km" }, { label: "Tempo", pace: "4:00-4:08/km" },
  ];
  await coach.apiFetch(`/api/athletes/${athleteId}`, { method: "PUT", body: JSON.stringify(corrupted) });
  await wait(200);
  await goto(athlete, `#/athlete-view/${athleteId}/training`);
  await goto(athlete, `#/athlete-view/${athleteId}/dashboard`);
  const tempoRows = Array.from(athlete.document.querySelectorAll("table.simple tr")).filter((tr) => tr.querySelector("th") && tr.querySelector("th").textContent.trim() === "Tempo");
  log("7) pre-existing corrupted data (4x 'Tempo') also displays once, no manual fix needed", tempoRows.length === 1);

  console.log(failures === 0 ? "\n=== ALL PACE-ZONE DEDUPE CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
