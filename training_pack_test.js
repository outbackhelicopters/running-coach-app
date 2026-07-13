// Exercises the new "training block overview" fields, the pace guide, and
// the calendar-export buttons through the real server + real frontend
// (same jsdom-over-HTTP harness as full_stack_test.js).
process.env.PG_MEM = "1";
process.env.JWT_SECRET = "training-pack-test-secret-training-pack-test-secret";
process.env.PORT = "8093";

const fs = require("fs");
const { JSDOM } = require("jsdom");
const BASE = "http://localhost:8093";
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
  coach.document.getElementById("naName").value = "John Blore";
  coach.document.getElementById("naEmail").value = "john@example.com";
  coach.document.getElementById("naStage").value = "6";
  coach.document.getElementById("naSave").click();
  await wait(400);
  const athleteId = coach.location.hash.split("/").pop();
  log("1) athlete created", !!athleteId);

  // --- Fill in the new Training block overview card ---
  coach.document.querySelector('.tab-btn[data-tab="overview"]').click();
  await wait(150);
  coach.document.getElementById("tbWelcome").value = "John, the biggest focus of this block is building consistency.";
  coach.document.getElementById("tbRecentRace").value = "Sydney Hoka Half Marathon – 2:22";
  coach.document.getElementById("tbWeeklyVolume").value = "Approximately 5km per week";
  coach.document.getElementById("tbFocusAreas").value = "Building consistent running habits\nImproving aerobic fitness";
  coach.document.getElementById("tbGoalA").value = "Sub 1:20";
  coach.document.getElementById("tbGoalB").value = "Strong personal performance";
  coach.document.getElementById("tbGoalC").value = "Complete the race comfortably";
  coach.document.getElementById("tbSave").click();
  await wait(300);
  log("2) training block overview saved without error", coach.document.body.textContent.includes("Training block overview saved"));

  // --- Pace zones (existing feature — verify still works, feeds the pace guide) ---
  coach.document.querySelector('.tab-btn[data-tab="plan"]').click();
  await wait(150);
  coach.document.querySelector('[data-zone="Easy"]').value = "5:45-6:15/km";
  coach.document.querySelector('[data-zone="Threshold"]').value = "5:10-5:20/km";
  coach.document.getElementById("saveZones").click();
  await wait(200);

  // --- Add a week, set its real start date, add a session via the new day dropdown ---
  coach.document.getElementById("addWeekBtn").click();
  await wait(300);
  const weekStartInput = coach.document.querySelector(".weekStartDate");
  weekStartInput.value = "2026-07-13"; // a real Monday
  weekStartInput.dispatchEvent(new coach.Event("change", { bubbles: true }));
  await wait(300);
  log("3) week start date saved", coach.document.body.textContent.includes("Week start date saved"));

  coach.document.querySelector(".addSessionBtn").click();
  await wait(100);
  const daySelect = coach.document.getElementById("smDay");
  log("4) day field is now a dropdown with weekday options", daySelect.tagName === "SELECT" && daySelect.options.length === 8);
  daySelect.value = "Wednesday";
  coach.document.getElementById("smType").value = "Tempo Run";
  coach.document.getElementById("smDistance").value = "5";
  coach.document.getElementById("smPace").value = "5:10-5:20/km";
  coach.document.getElementById("smMain").value = "3km tempo pace";
  coach.document.getElementById("smSave").click();
  await wait(300);

  // --- View as athlete: does the training-pack content actually show up? ---
  await goto(coach, `#/athlete-view/${athleteId}/dashboard`);
  const dashText = coach.document.body.textContent;
  log("5) welcome message shows on athlete dashboard", dashText.includes("building consistency"));
  log("6) A/B/C goals show on athlete dashboard", dashText.includes("Sub 1:20") && dashText.includes("Strong personal performance") && dashText.includes("Complete the race comfortably"));
  log("7) focus areas show on athlete dashboard", dashText.includes("Building consistent running habits"));
  log("8) recent race + weekly volume show", dashText.includes("Sydney Hoka Half Marathon") && dashText.includes("Approximately 5km per week"));
  log("9) pace guide table shows on athlete dashboard", dashText.includes("5:45-6:15/km") && dashText.includes("5:10-5:20/km"));

  // --- Calendar buttons: present, and clicking doesn't throw ---
  await goto(coach, `#/athlete-view/${athleteId}/training`);
  const weekCalBtn = coach.document.getElementById("avAddWeekCal");
  log("10) 'Add week to calendar' button present", !!weekCalBtn);
  let calError = null;
  const origConsoleError = coach.console.error;
  try {
    weekCalBtn.click();
    await wait(200);
  } catch (e) { calError = e; }
  log("11) clicking 'Add week to calendar' does not throw", !calError);
  if (calError) console.log("     [debug]", calError.message);

  const toggle = coach.document.querySelector('[data-toggle="0"]');
  toggle.click();
  await wait(50);
  const sessionCalBtn = coach.document.querySelector('.avAddSessionCal[data-si="0"]');
  log("12) per-session 'Add to calendar' button present", !!sessionCalBtn);
  let sessionCalError = null;
  try { sessionCalBtn.click(); await wait(200); } catch (e) { sessionCalError = e; }
  log("13) clicking per-session 'Add to calendar' does not throw", !sessionCalError);
  if (sessionCalError) console.log("     [debug]", sessionCalError.message);

  console.log(failures ? `\n=== ${failures} CHECK(S) FAILED ===` : "\n=== ALL TRAINING PACK CHECKS PASSED ===");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
