// Exercises the three real bugs found in the full app audit:
//  1) an athlete browsing weeks in their own Training tab must NOT
//     overwrite the coach's "current week" (used by the coach's dashboard
//     stats, Plan Builder "Current" tag, and the athlete's own streak calc).
//  2) the "Monthly catch-up" reminder must keep re-firing every ~30 days,
//     not just once ever (it used to go silent forever after the very
//     first review was logged).
//  3) the shared Resources / Content Library must actually be visible to
//     athletes, not just the coach who built it.
// Same jsdom-over-real-HTTP harness as the other *_test.js files.
process.env.PG_MEM = "1";
process.env.JWT_SECRET = "audit-fixes-test-secret-audit-fixes-test-secret";
process.env.PORT = "8101";

const fs = require("fs");
const { JSDOM } = require("jsdom");
const BASE = "http://localhost:8101";
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
  coach.document.getElementById("naName").value = "Jess Runner";
  coach.document.getElementById("naEmail").value = "jess@example.com";
  coach.document.getElementById("naStage").value = "6";
  coach.document.getElementById("naSave").click();
  await wait(400);
  const athleteId = coach.location.hash.split("/").pop();

  // Build 3 weeks so we have somewhere to browse to.
  coach.document.querySelector('.tab-btn[data-tab="plan"]').click();
  await wait(150);
  for (let i = 0; i < 3; i++) {
    coach.document.getElementById("addWeekBtn").click();
    await wait(250);
  }
  // Explicitly set week 1 (index 0) as current.
  const setCurBtns = coach.document.querySelectorAll(".setCurrentWeek");
  // weeks render in order; week index 0 has no "setCurrentWeek" button since
  // it's already current by default (currentWeekIndex starts at 0) — confirm that.
  log("1) week 1 is current by default", coach.document.querySelectorAll(".week-current").length === 1 && coach.document.querySelector(".week-current h3").textContent.includes("Week 1"));

  // Give week 1 a session so weekly-completion math has something real in it.
  const addBtns = coach.document.querySelectorAll(".addSessionBtn");
  addBtns[0].click();
  await wait(100);
  coach.document.getElementById("smDay").value = "Monday";
  coach.document.getElementById("smType").value = "Easy Run";
  coach.document.getElementById("smDistance").value = "5";
  coach.document.getElementById("smSave").click();
  await wait(300);

  coach.document.querySelector('.tab-btn[data-tab="overview"]').click();
  await wait(150);
  coach.document.getElementById("setPasswordBtn").click();
  await wait(100);
  coach.document.getElementById("apPassword").value = "athletepass1";
  coach.document.getElementById("apSave").click();
  await wait(400);

  // ---------- Athlete browses forward to week 3 just to look ----------
  const athlete = newBrowser("athlete");
  await wait(300);
  await goto(athlete, "#/login");
  athlete.document.getElementById("alEmail").value = "jess@example.com";
  athlete.document.getElementById("alPassword").value = "athletepass1";
  athlete.document.getElementById("alSubmit").click();
  await wait(400);

  await goto(athlete, `#/athlete-view/${athleteId}/training`);
  log("2) athlete's training tab opens on week 1 (the real current week)", athlete.document.body.textContent.includes("Week 1"));
  athlete.document.getElementById("avNextWeek").click();
  await wait(200);
  athlete.document.getElementById("avNextWeek").click();
  await wait(200);
  log("3) athlete is now browsing week 3 locally", athlete.document.getElementById("avWeekSelect").value === "2");

  // ---------- Coach: did browsing corrupt their view of "current week"? ----------
  await goto(coach, `#/dashboard/athlete/${athleteId}`);
  coach.document.querySelector('.tab-btn[data-tab="plan"]').click();
  await wait(150);
  log("4) coach's Plan Builder still shows Week 1 as current (not corrupted by athlete browsing)", coach.document.querySelector(".week-current h3").textContent.includes("Week 1"));

  await goto(coach, "#/dashboard");
  log("5) coach dashboard 'Weekly Training Review' still keyed off Week 1", coach.document.body.textContent.includes("Week 1"));

  // ---------- Athlete navigates away and back — browsing position resets ----------
  await goto(athlete, `#/athlete-view/${athleteId}/dashboard`);
  await goto(athlete, `#/athlete-view/${athleteId}/training`);
  log("6) athlete's training tab resets back to week 1 on fresh navigation", athlete.document.body.textContent.includes("Week 1") && athlete.document.getElementById("avWeekSelect").value === "0");

  // ---------- Monthly review reminder keeps re-firing ----------
  await goto(coach, `#/dashboard/athlete/${athleteId}`);
  coach.document.querySelector('.tab-btn[data-tab="overview"]').click();
  await wait(150);
  coach.document.getElementById("ovStartDate").value = "2026-05-01"; // well over 27 days ago relative to "today" in this environment
  coach.document.getElementById("ovSave").click();
  await wait(300);

  coach.document.querySelector('.tab-btn[data-tab="reviews"]').click();
  await wait(150);
  coach.document.getElementById("rvMonth").value = "June 2026";
  coach.document.getElementById("rvNotes").value = "Good progress, on track for goal race.";
  coach.document.getElementById("addReview").click();
  await wait(300);

  // Manually backdate that review's createdAt to 45 days ago so it reads as overdue again.
  const a1 = await (await fetch(BASE + `/api/athletes/${athleteId}`, { headers: { Authorization: "Bearer " + JSON.parse(coach.localStorage.getItem("rc_session_v1")).token } })).json();
  a1.reviews[a1.reviews.length - 1].createdAt = Date.now() - 45 * 86400000;
  await fetch(BASE + `/api/athletes/${athleteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + JSON.parse(coach.localStorage.getItem("rc_session_v1")).token },
    body: JSON.stringify(a1),
  });

  await goto(coach, "#/dashboard");
  log("7) monthly catch-up reminder re-fires once the logged review is old enough", coach.document.body.textContent.includes("Monthly catch-up"));

  // ---------- Resources are visible to the athlete, not just the coach ----------
  await goto(coach, "#/dashboard/resources");
  coach.document.getElementById("addResourceBtn").click();
  await wait(50);
  coach.document.getElementById("rsCategory").value = "Pace guide";
  coach.document.getElementById("rsTitle").value = "How to read your pace zones";
  coach.document.getElementById("rsBody").value = "Easy pace should feel conversational...";
  coach.document.getElementById("rsSave").click();
  await wait(300);

  await goto(athlete, `#/athlete-view/${athleteId}/resources`);
  await wait(300);
  log("8) athlete's Resources tab exists and shows the coach's shared resource", athlete.document.body.textContent.includes("How to read your pace zones"));

  console.log(failures ? `\n=== ${failures} CHECK(S) FAILED ===` : "\n=== ALL AUDIT-FIX CHECKS PASSED ===");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
