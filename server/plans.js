/* ============================================================
   STRIPE PLAN CATALOG — the ONLY place real charge amounts live.
   Never trust a client-submitted price; the server always looks
   the amount up here by region + planId before creating a Stripe
   Checkout Session. index.html's CONFIG.PLANS mirrors these same
   numbers for display purposes only.

   Two separate Stripe accounts exist (one per region) — AU and UK —
   each with its own secret key / webhook secret via env vars:
     STRIPE_SECRET_KEY_AU / STRIPE_WEBHOOK_SECRET_AU
     STRIPE_SECRET_KEY_UK / STRIPE_WEBHOOK_SECRET_UK
   ============================================================ */
const PLANS = {
  AU: {
    currency: "aud",
    symbol: "A$",
    label: "Australia",
    plans: {
      marathon: { id: "marathon", name: "One-off Marathon Plan", unitAmount: 8000, mode: "payment", priceLabel: "A$80.00 one-time" },
      half: { id: "half", name: "One-off Half Marathon Plan", unitAmount: 6500, mode: "payment", priceLabel: "A$65.00 one-time" },
      fiveK: { id: "fiveK", name: "One-off 5K Plan", unitAmount: 4500, mode: "payment", priceLabel: "A$45.00 one-time" },
      premiumSub: {
        id: "premiumSub",
        name: "Premium Personalised Plan",
        unitAmount: 3000,
        mode: "subscription",
        interval: "week",
        intervalCount: 2,
        gatesAccess: true,
        priceLabel: "A$30.00 every 2 weeks",
      },
      premiumOnce: {
        id: "premiumOnce",
        name: "Premium Personalised Plan (one-time)",
        unitAmount: 25000,
        mode: "payment",
        gatesAccess: true,
        priceLabel: "A$250.00 one-time",
      },
    },
  },
  UK: {
    currency: "gbp",
    symbol: "£",
    label: "United Kingdom",
    plans: {
      marathon: { id: "marathon", name: "One-off Marathon Plan", unitAmount: 4500, mode: "payment", priceLabel: "£45.00 one-time" },
      half: { id: "half", name: "One-off Half Marathon Plan", unitAmount: 3000, mode: "payment", priceLabel: "£30.00 one-time" },
      fiveK: { id: "fiveK", name: "One-off 5K Plan", unitAmount: 2000, mode: "payment", priceLabel: "£20.00 one-time" },
      premiumSub: {
        id: "premiumSub",
        name: "Premium Personalised Plan",
        unitAmount: 2900,
        mode: "subscription",
        interval: "month",
        intervalCount: 1,
        gatesAccess: true,
        priceLabel: "£29.00 per month",
      },
      premiumOnce: {
        id: "premiumOnce",
        name: "Premium Personalised Plan (one-time)",
        unitAmount: 12500,
        mode: "payment",
        gatesAccess: true,
        priceLabel: "£125.00 one-time",
      },
    },
  },
};

function getPlan(region, planId) {
  const r = PLANS[region];
  if (!r) return null;
  const p = r.plans[planId];
  if (!p) return null;
  return Object.assign({}, p, { currency: r.currency });
}

function planOrder() {
  return ["marathon", "half", "fiveK", "premiumSub", "premiumOnce"];
}

module.exports = { PLANS, getPlan, planOrder };
