// Exercises the reworked homepage CTAs: no more "Book a Free Consultation",
// "Start Coaching" leads to the full public questionnaire (which now works
// for a brand-new, not-yet-in-the-system visitor), and a separate minimal
// "Get in touch" contact form exists with just name/email/question. Same
// jsdom-over-real-HTTP harness as the other *_test.js files in this repo.
process.env.PG_MEM = "1";
process.env.JWT_SECRET = "homepage-cta-test-secret-homepage-cta-test-secret";
process.env.PORT = "8094";

const fs = require("fs");
const { JSDOM } = require("jsdom");
const BASE = "http://localhost:8094";
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

  // ---------- Coach setup (so we can inspect the pipeline afterward) ----------
  const coach = newBrowser("coach");
  await wait(300);
  await goto(coach, "#/dashboard");
  coach.document.getElementById("authEmail").value = "tom@example.com";
  coach.document.getElementById("authPassword").value = "coachpassword1";
  coach.document.getElementById("authPasswordConfirm").value = "coachpassword1";
  coach.document.getElementById("authSubmit").click();
  await wait(400);

  // ---------- Homepage: check CTAs ----------
  const visitor = newBrowser("visitor");
  await wait(300);
  await goto(visitor, "#/");
  const heroHtml = visitor.document.body.innerHTML;
  log("1) 'Book a Free Consultation' button is gone", !heroHtml.includes("Book a Free Consultation"));
  log("2) hero 'Start Coaching' links to the full questionnaire", visitor.document.querySelector('.hero-photo a[href="#/questionnaire"]') !== null);
  log("3) nav 'Get started' links to the full questionnaire", visitor.document.querySelector('header.site a[href="#/questionnaire"]') !== null);
  log("4) final CTA 'Start Coaching Today' links to the full questionnaire", visitor.document.querySelector('.final-cta a[href="#/questionnaire"]') !== null);
  log("5) pricing 'Get in touch' links to the new minimal contact form", visitor.document.querySelector('.pricing-box a[href="#/contact"]') !== null);

  // ---------- Anonymous visitor completes the FULL questionnaire ----------
  await goto(visitor, "#/questionnaire");
  log("6) questionnaire page renders with no athlete param", !!visitor.document.getElementById("qForm"));
  const qForm = visitor.document.getElementById("qForm");
  qForm.elements["fullName"].value = "Priya Athlete";
  qForm.elements["email"].value = "priya@example.com";
  qForm.elements["phone"].value = "61411111111";
  qForm.elements["targetRace"].value = "City to Surf";
  qForm.elements["goalType"].value = "Finish";
  visitor.document.getElementById("qForm").dispatchEvent(new visitor.Event("submit", { bubbles: true, cancelable: true }));
  await wait(500);
  log("7) questionnaire submitted successfully (Got it screen)", visitor.document.body.textContent.includes("Got it"));

  await goto(coach, "#/dashboard");
  log("8) coach sees the new athlete created straight from the questionnaire", coach.document.body.textContent.includes("Priya Athlete"));

  // ---------- Separate visitor uses the minimal "Get in touch" form ----------
  const visitor2 = newBrowser("visitor2");
  await wait(300);
  await goto(visitor2, "#/contact");
  const cForm = visitor2.document.getElementById("contactForm");
  log("9) contact form has exactly name, email, question fields", !!cForm.elements["name"] && !!cForm.elements["email"] && !!cForm.elements["question"] && !cForm.elements["phone"] && !cForm.elements["reason"]);
  cForm.elements["name"].value = "Sam Curious";
  cForm.elements["email"].value = "sam@example.com";
  cForm.elements["question"].value = "Do you coach trail runners too?";
  cForm.dispatchEvent(new visitor2.Event("submit", { bubbles: true, cancelable: true }));
  await wait(500);
  log("10) contact question submitted successfully", visitor2.document.body.textContent.includes("Thanks"));

  await goto(coach, "#/dashboard");
  log("11) coach sees the new contact-form lead", coach.document.body.textContent.includes("Sam Curious"));

  console.log(failures ? `\n=== ${failures} CHECK(S) FAILED ===` : "\n=== ALL HOMEPAGE CTA CHECKS PASSED ===");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
