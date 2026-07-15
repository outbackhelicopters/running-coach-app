// Exercises the new "change coach login email" feature in Settings:
// wrong current password is rejected, right password updates the email,
// and the coach can then log in with the new email (and no longer the old
// one). Same jsdom-over-real-HTTP harness as the other *_test.js files.
process.env.PG_MEM = "1";
process.env.JWT_SECRET = "coach-email-test-secret-coach-email-test-secret";
process.env.PORT = "8095";

const fs = require("fs");
const { JSDOM } = require("jsdom");
const BASE = "http://localhost:8095";
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
  log("1) coach account created and logged in", !!coach.document.querySelector(".pipeline"));

  await goto(coach, "#/settings");
  log("2) settings page has the new 'Change login email' card", !!coach.document.getElementById("newEmail") && !!coach.document.getElementById("emailCurPw"));

  // Wrong current password should be rejected, email must stay unchanged.
  coach.document.getElementById("newEmail").value = "tom.real@gmail.com";
  coach.document.getElementById("emailCurPw").value = "wrongpassword";
  coach.document.getElementById("changeEmailBtn").click();
  await wait(400);
  log("3) wrong current password is rejected", coach.document.body.textContent.includes("Current password is incorrect") || coach.document.body.textContent.includes("Couldn't update email"));

  // Correct current password should succeed.
  coach.document.getElementById("newEmail").value = "tom.real@gmail.com";
  coach.document.getElementById("emailCurPw").value = "coachpassword1";
  coach.document.getElementById("changeEmailBtn").click();
  await wait(400);
  log("4) correct current password updates the email", coach.document.body.textContent.includes("Login email updated"));

  // Log out, confirm old email no longer works, new one does.
  coach.document.getElementById("coachLogoutLink").click();
  await wait(300);
  await goto(coach, "#/dashboard");
  coach.document.getElementById("authEmail").value = "tom@example.com";
  coach.document.getElementById("authPassword").value = "coachpassword1";
  coach.document.getElementById("authSubmit").click();
  await wait(400);
  log("5) old email no longer logs in", !coach.document.querySelector(".pipeline"));

  await goto(coach, "#/dashboard");
  coach.document.getElementById("authEmail").value = "tom.real@gmail.com";
  coach.document.getElementById("authPassword").value = "coachpassword1";
  coach.document.getElementById("authSubmit").click();
  await wait(400);
  log("6) new email logs in successfully", !!coach.document.querySelector(".pipeline"));

  console.log(failures ? `\n=== ${failures} CHECK(S) FAILED ===` : "\n=== ALL COACH EMAIL CHECKS PASSED ===");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
