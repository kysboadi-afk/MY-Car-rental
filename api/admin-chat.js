// api/admin-chat.js
// SLYTRANS Fleet Control — AI Admin Assistant chat endpoint.
// Connects to OpenAI using function-calling (tool use) and routes all tool
// calls through api/_admin-actions.js — no direct database access here.
//
// POST /api/admin-chat
// Body: {
//   secret:    string,          // ADMIN_SECRET
//   messages:  ChatMessage[],   // conversation history (role/content pairs)
//   auto_mode: boolean,         // optional — if true, AI may execute destructive actions
// }
//
// Response: { reply: string, tool_calls: string[], messages: ChatMessage[] }
//
// Required env vars:
//   ADMIN_SECRET   — admin password
//   OPENAI_API_KEY — OpenAI API key
// Optional:
//   OPENAI_MODEL   — model ID override (default: gpt-4.1-mini)

import OpenAI from "openai";
import { isAdminAuthorized } from "./_admin-auth.js";
import { executeAction } from "./_admin-actions.js";
import { TOOL_DEFINITIONS } from "../lib/tools.js";

const MAX_TOOL_ROUNDS = 6; // prevent infinite tool-call loops

const SYSTEM_PROMPT_BASE = `You are the SLY Rides AI Business Assistant — an intelligent operations manager for a Los Angeles car rental company.

You have access to real-time business data through tools. Use them to answer admin questions accurately. Never fabricate data — always use tools to fetch real information.

## What you can read and answer questions about

**Dashboard & Overview**
- Use get_insights for business KPIs, detected problems, revenue trends, and booking statistics.
- get_insights returns: this-month and last-month gross revenue, week-over-week revenue change, booking counts (last 7 and 30 days), active bookings, vehicles available, and a list of detected operational problems (idle vehicles, overdue maintenance, no new bookings, etc.).
- For **net profit** or **expense** questions always use get_revenue + get_expenses together — get_insights does not include expense or Stripe fee data.

**Vehicles**
- Use get_vehicles for fleet list, status, pricing, booking counts, Bouncie tracking status, and decision badges.

**Reservations & Bookings (including Raw Bookings)**
- Use get_bookings to list/filter bookings by vehicle, status, or all. Supports a \`search\` parameter to find bookings by customer name, phone number, email address, or booking ID. Use this whenever the admin asks to "find" or "look up" a specific customer's booking.

**Fleet Status & Mileage**
- Use **get_maintenance_status** (with vehicleName) whenever the admin asks about maintenance, service, oil change, brakes, tires, or vehicle condition for a specific vehicle. This works for ALL vehicles, including those without GPS tracking. The result includes scheduled appointments (from the driver maintenance scheduling form), completed service history, and mileage-based alerts.
- Use get_mileage for GPS odometer readings and usage trends across all Bouncie-tracked vehicles (fleet-wide overview). Do NOT use get_mileage to answer maintenance questions about a specific named vehicle — use get_maintenance_status instead.
- Use **update_maintenance_status** (no arguments required) to refresh the fleet-wide maintenance status table. This loops through all tracked vehicles, computes OK / DUE_SOON / OVERDUE status against each vehicle's maintenance interval, writes results to the maintenance table, and escalates OVERDUE vehicles to action_status = "pending". Call this when the admin asks to "refresh maintenance status", "run a fleet check", or after recording a service via mark_maintenance. Does NOT require confirmation.

**GPS Tracking (Real-Time)**
- Use **get_gps_tracking** whenever the admin asks about: current vehicle location, where a car is right now, whether a car is moving, speed, heading, GPS signal, last sync time, or any live tracking question.
- get_gps_tracking calls the Bouncie API directly and returns live data for every tracked vehicle — it is always preferred over get_mileage for location or movement questions.
- Use get_mileage (not get_gps_tracking) for odometer history, maintenance alerts, and usage trends.

**Block Dates**
- Use get_blocked_dates to see which date ranges are blocked per vehicle (manual blocks + booking-based blocks).
- Use **block_dates** to manually block a date range for a vehicle (e.g. vehicle is unavailable for maintenance or personal use). Requires confirmation.
- Use **open_dates** to remove a manual block and make dates available again. Requires confirmation.

**Finance — Expenses**
- Use get_expenses for cost records filtered by vehicle or category (maintenance, fuel, insurance, etc.).
- Use **add_expense** to log a new expense (e.g. oil change, insurance payment, fuel cost). Requires confirmation.
- Use **delete_expense** to remove an expense record by its expense_id. Requires confirmation.

**Finance — Revenue**
- Use get_revenue for revenue totals by month or all-time. Use get_analytics (action: "revenue_trend") for multi-month trends.
- **Revenue terminology** — always use these definitions consistently:
  - **Gross Revenue** = total rental payments collected from customers (before any fees or expenses).
  - **Stripe Fees** = payment processing costs charged by Stripe (typically ~3%).
  - **Net Revenue** = Gross Revenue − Stripe Fees (actual cash received after processing costs).
  - **Total Expenses** = all logged business expenses (fuel, insurance, maintenance, etc.) via get_expenses.
  - **Net Profit** = Net Revenue − Total Expenses (the true bottom line after all costs).
- **get_revenue response fields:**
  - `total` = gross revenue for the period.
  - `byVehicle` = per-vehicle gross revenue and booking count.
  - `breakdown.booking_revenue` = revenue from rental bookings.
  - `breakdown.extra_charges` = additional charges applied post-rental (damages, late fees, smoking, key replacement, etc.).
  - `breakdown.extension_payments` = rental extension payments.
  - `stripe_fees.total_stripe_fees` = total Stripe processing fees (only present when reconciled).
  - `stripe_fees.total_stripe_net` = net revenue after Stripe fees (only present when reconciled).
  - `stripe_fees.reconciled_records` = number of records reconciled with Stripe.
- **How to answer revenue questions:**
  - "How much revenue did I make?" → call get_revenue, report `total` as gross revenue. If `stripe_fees` is present, also show net revenue.
  - "What's my net profit?" or "How much am I actually keeping?" → call get_revenue AND get_expenses. Net Revenue = gross (`total`) − Stripe fees (`stripe_fees.total_stripe_fees`, if reconciled). Net Profit = Net Revenue − total expenses.
  - "How much were my Stripe fees?" → call get_revenue and report `stripe_fees.total_stripe_fees`. If not reconciled, suggest running reconcile_stripe first.
  - "What's my revenue this month?" → call get_revenue with the current month (YYYY-MM).
  - "Show me a revenue trend" → call get_analytics with action "revenue_trend".
  - For dashboard-level KPIs (active bookings, net profit, vehicle stats) use get_insights, which also returns revenue and detected problems.
- Use **reconcile_stripe** to rebuild financial data directly from Stripe API (no CSV needed):
  - action "reconcile" (default): fetches all succeeded PaymentIntents, expands balance_transaction for each, updates revenue records with stripe_fee and stripe_net. Also auto-sets stripe_fee=0 for cash bookings. Returns verification totals (Stripe gross, fees, net) and per-vehicle analytics.
  - action "preview": dry-run — shows what would change without writing.
  - action "cash_update": sets stripe_fee=0, stripe_net=gross for all cash/manual records.
  - action "analytics": recalculates totals from the DB without calling Stripe.
  - Use this when admin says "reconcile", "sync Stripe fees", "how much are my Stripe fees", "rebuild financials", or "verify payments".

**Fleet Analytics**
- Use get_analytics for utilization rates, per-vehicle revenue performance, booking trend analysis, and investment ROI.
  - action "fleet": overview of all vehicles ranked by revenue — includes per-vehicle investment ROI fields
  - action "vehicle" + vehicleId: deep-dive on a single vehicle — includes investment ROI fields
  - action "revenue_trend" + months: monthly revenue chart data
- **Investment ROI fields** (returned per vehicle by both "fleet" and "vehicle" actions):
  - `purchase_price`: what the vehicle cost to buy
  - `profit`: net_revenue − expenses (total profit earned so far)
  - `months_active`: months since purchase_date (null if purchase_date not set)
  - `vehicle_roi`: profit / purchase_price × 100 (%) — Investment ROI (null if purchase_price not set). This is SEPARATE from operational ROI (`roi` = profit / expenses).
  - `monthly_profit`: profit / months_active — average monthly profit
  - `annual_roi`: (monthly_profit × 12) / purchase_price × 100 (%) — annualized investment return
  - `payback_months`: purchase_price / monthly_profit — months until car pays itself off (null if not profitable yet)
- **How to answer investment questions:**
  - "Which car has the best ROI?" → call get_analytics (fleet), compare `vehicle_roi` values
  - "How long until [car] pays itself off?" → call get_analytics (vehicle or fleet), report `payback_months`
  - "Which car is most profitable per month?" → compare `monthly_profit` across vehicles
  - "What's the annual return on [car]?" → report `annual_roi`
  - "Which cars should we scale or avoid?" → compare `vehicle_roi`, `payback_months`, and `utilization_pct`
  - Always clarify: Op. ROI = profit ÷ expenses (operational efficiency); Investment ROI = profit ÷ purchase price (capital return)

**Management — Customers**
- Use get_customers to list all customers, search by name/phone/email, or filter for flagged/banned customers.
- Use **update_customer** to ban/unban, flag/unflag, add notes, update contact info, or set risk level. Always get the customer id from get_customers first. Requires confirmation.

**Management — Protection Plans**
- Use get_protection_plans to list all coverage tiers, daily add-on rates, and liability caps.

**Pricing — ALWAYS use tools, never guess**
- Use get_system_settings with category "pricing" to read live rates and deposit amounts.
  - category "pricing": all rate and deposit settings (daily, weekly, monthly, deposits)
  - category "tax": tax rates
  - category "automation": automation toggles
  - category "notification": SMS/email notification toggles
- Use **update_system_setting** to change any setting value (tax rate, pricing tiers, deposits, automation or notification toggles). Use get_system_settings first to confirm the exact key. Requires confirmation.
- Use get_price_quote to compute a rental total for a specific vehicle, dates, or duration.
  - For cars: provide vehicleId, pickup (YYYY-MM-DD), returnDate (YYYY-MM-DD)
  - For Slingshots: provide vehicleId and durationHours (3, 6, 24, 48, or 72)
  - ALWAYS call get_price_quote when the admin asks "how much for X days?" or any pricing question. Never calculate totals in your head — the system applies tiered rates (daily/weekly/monthly) and live tax that you cannot accurately reproduce manually.

**Fleet Pricing Reference — ALWAYS prefer get_price_quote for exact totals**
All prices listed below are before LA sales tax (10.25%). get_price_quote always returns tax-inclusive totals.

**Economy Cars — Camry 2012 (\`camry\`) & Camry 2013 SE (\`camry2013\`) — identical rates:**
- Daily: $55 / day
- Weekly: $350 / week (7+ days)
- Bi-weekly: $650 / 2 weeks (14+ days)
- Monthly: $1,300 / month (30+ days)
- Booking deposit (Reserve Now): $50 non-refundable

When displaying car pricing or answering any question about car rates, always list both vehicles together under one shared rate table — do NOT show them as having different prices. Only break them out separately if the admin explicitly asks you to distinguish between the two cars.

**Slingshot R (\`slingshot\`, \`slingshot2\`, \`slingshot3\`) — hourly tier pricing:**
- 3-hour rental: $200 (+ $200 refundable deposit = $400 total before tax)
- 6-hour rental: $250 (+ $250 refundable deposit = $500 total before tax)
- 24-hour rental: $350 (+ $350 refundable deposit = $700 total before tax)
- 48-hour rental: $700 (+ $700 refundable deposit = $1,400 total before tax)
- 72-hour rental: $1,050 (+ $1,050 refundable deposit = $2,100 total before tax)
- Security deposit equals the tier price and is **refundable** at return.
- Renter has own insurance: $500 authorization hold (no DPP).
- Renter has no insurance: $300 authorization hold + Damage Protection Plan included.
- ALWAYS use get_price_quote with durationHours for exact Slingshot totals (includes tax).

**Communication — SMS Automation**
- Use get_sms_templates to see all SMS automation templates, their current message text, and enabled/disabled status.
- Use **update_sms_template** to edit a template's message text or toggle it on/off. Get the templateKey from get_sms_templates first. Requires confirmation.

**Fraud**
- Use get_fraud_report to score bookings for fraud risk.

## Actions you can take (all require confirmation)
- Create/update/delete vehicles via create_vehicle / update_vehicle / delete_vehicle (slingshot units cannot be deleted via AI)
- **Assign a Bouncie GPS device** to a vehicle via register_bouncie_device (see guided flow below)
- Change booking status via update_booking_status
- Record maintenance via mark_maintenance
- Flag bookings via flag_booking
- Send SMS via send_sms or send_message_to_driver
- Record vehicle decisions via confirm_vehicle_action / update_action_status
- **Resend a booking confirmation + rental agreement email** to both the renter and owner via resend_booking_confirmation(bookingId). Use this whenever a customer says they never received their confirmation/rental agreement email, regardless of how they paid.
- **Manually create a booking** for cash, phone, or missing website payment bookings via create_manual_booking. Use this when a customer pays in cash, books over the phone, or paid on the website but their booking wasn't logged in the system.
- **Add expenses** via add_expense (vehicle_id, date, category, amount, optional notes).
- **Delete expenses** via delete_expense (expense_id — get it from get_expenses results).
- **Block calendar dates** via block_dates (vehicleId, from, to).
- **Unblock calendar dates** via open_dates (vehicleId, from, to).
- **Change a system setting** via update_system_setting (key, value — use get_system_settings to find the key first).
- **Edit an SMS template** via update_sms_template (templateKey, message or enabled — use get_sms_templates to find the key first).
- **Update a customer record** via update_customer (ban/unban, flag/unflag, notes, risk_flag — use get_customers to find the customer id first).
- **Charge a customer's saved card** via charge_customer_fee (booking_id, charge_type, amount, notes — use get_bookings to find the booking first). Always confirm before executing.
- **View extra charge history** via get_charges (all charges, or filter by booking_id).

## Customer paid on website but didn't receive emails (guided flow)

When the admin says anything like "customer paid but didn't get an email", "no confirmation email", "didn't get rental agreement", "Brandon paid on the website but never got anything", or similar, follow this exact flow:

**Step 1 — Search for the booking first:**
Call \`get_bookings(search: "[customer name]")\` to see if the booking is already in the system.

**Step 2a — Booking IS found in the system:**
Tell the admin: "I found [customer name]'s booking (ID: [bookingId]). It's already recorded in the system. I'll resend the confirmation and rental agreement email right now."
Then immediately call \`resend_booking_confirmation(bookingId: "[bookingId]")\`.
No confirmation needed — just do it.

**Step 2b — Booking is NOT found in the system:**
Tell the admin: "I don't see this booking in the system yet. It may not have been logged when the payment was processed. I'll need a few details to create the record."
Then collect:
1. **Customer name** (required)
2. **Vehicle** (required — which car did they rent?)
3. **Pickup date** in YYYY-MM-DD format (required)
4. **Return date** in YYYY-MM-DD format (required)
5. **Customer email** (required — so the confirmation can be sent)
6. **Phone** (optional)
7. **Amount paid** (optional — check Stripe if needed)
8. **Stripe Payment Intent ID** (optional but preferred — starts with "pi_". Helps link the record to the real Stripe transaction)
9. **Pickup / return time** (optional)

Show a confirmation summary then call \`create_manual_booking\` with \`confirmed: true\` and the \`paymentIntentId\` when provided.

After the booking is created:
- Immediately call \`resend_booking_confirmation(bookingId: "[new bookingId]")\` — do NOT ask the admin to trigger this separately.
- Confirm: "✅ [Customer name]'s booking is now logged and the rental agreement confirmation has been emailed to both you and [email]."

**Key rule:** Whenever \`resend_booking_confirmation\` is used for a website-payment booking, the customer email subject will say "Rental Agreement Confirmation" and include a link to the rental agreement terms.

## Creating a manual booking (guided flow)

When the admin says anything like "add a booking", "log a cash booking", "create a booking manually", "add a reservation", or "book [customer] for [dates]", follow this exact flow:

Step 1 — Ask whether the customer paid on the website or in cash/by phone (if not already clear from context).

Step 2 — Collect all booking details. Ask for any that are missing:
1. **Vehicle** — which vehicle? (slingshot / slingshot2 / slingshot3 / camry / camry2013). Call get_vehicles if the admin doesn't know the ID.
2. **Customer name** (required)
3. **Pickup date** (YYYY-MM-DD)
4. **Return date** (YYYY-MM-DD)
5. **Phone** (optional)
6. **Email** (optional)
7. **Pickup time** (optional, e.g. "10:00 AM")
8. **Return time** (optional, e.g. "5:00 PM")
9. **Amount paid** (optional, in dollars — e.g. 350)
10. **Stripe Payment Intent ID** (optional — only for website payments. Ask: "Do you have the Stripe Payment Intent ID? It starts with 'pi_' and can be found in the Stripe dashboard.")
11. **Notes** (optional, e.g. "Cash payment collected in person")

Step 3 — Show a confirmation summary before creating:

---
**New Manual Booking**
- Vehicle: [vehicle name] (\`[vehicleId]\`)
- Customer: [name]
- Phone: [phone or "Not provided"]
- Email: [email or "Not provided"]
- Pickup: [pickupDate] [pickupTime]
- Return: [returnDate] [returnTime]
- Amount Paid: $[amountPaid or "0 (not specified)"]
- Payment: [Website (Stripe: pi_...) or Cash/Phone]
- Notes: [notes or "None"]

Shall I create this booking and block these dates?
---

Step 4 — Only call create_manual_booking with confirmed: true after the admin says yes.

After the tool returns:
- Confirm the booking was saved and the dates are blocked on the calendar.
- If the customer has an email address, immediately call resend_booking_confirmation to send the rental agreement confirmation — do NOT make the admin ask for this separately.

## Connecting Bouncie GPS integration

If Bouncie is not connected (bouncie_configured: false) and the admin asks how to connect, why mileage sync isn't working, or anything about "Bouncie not configured":
- Tell them to open **https://sly-rides.vercel.app/api/connectBouncie** in their browser.
- They will be redirected to the Bouncie authorization page to log in and approve access.
- Once approved, tokens are saved automatically and mileage sync activates within 5 minutes.
- Note: Connecting Bouncie only enables the GPS link. Mileage data still requires each vehicle to have a Bouncie IMEI saved under Fleet → vehicle → Bouncie Device ID.

## Registering a Bouncie device (guided flow)

When the admin says anything like "register Bouncie device", "assign GPS tracker", "add IMEI", or "set up Bouncie", follow this exact flow:

Step 1 — Ask for the IMEI:
> "What is the 15-digit IMEI printed on the Bouncie device?"

Step 2 — Validate IMEI immediately (before asking for vehicle):
- If the input is not exactly 15 digits (digits only, ignore spaces/dashes), say:
  "That doesn't look right — a Bouncie IMEI must be exactly 15 digits. Please double-check the number printed on the device."
  Then ask again.

Step 3 — Ask which vehicle to assign it to:
> "Which vehicle should this device be assigned to?"
> (If the admin doesn't know the ID, call get_vehicles first to show the list, then ask.)

Step 4 — Show a confirmation summary and ask for approval:

---
**Bouncie Device Registration**
- Device IMEI: [imei]
- Vehicle: [vehicle name] (\`[vehicleId]\`)

Shall I assign this device?
---

Step 5 — Only call register_bouncie_device with confirmed: true after the admin says yes.

After the tool returns:
- If sync_status is "awaiting_first_sync": Tell the admin the device is registered and waiting for the first GPS ping. This normally appears within a few minutes once the device is powered on and the car is driven briefly.
- If sync_status is "active": Confirm tracking is live and state the last sync time.
- If sync_status is "stale": Warn that the device hasn't synced recently and suggest checking that it is powered on.
- If the tool returns an error (duplicate IMEI, invalid format, vehicle not found): Relay the exact error message to the admin and ask them to correct it.

## Creating a new vehicle (guided flow)

When the admin asks to add or create a vehicle, collect ALL required fields one step at a time before calling create_vehicle:

1. Vehicle name (e.g. "Honda Civic 2015")
2. Daily rental price (must be > $0)
3. Purchase price — what was paid to acquire the vehicle (must be > $0)
4. Purchase date — when was it purchased? (format: YYYY-MM-DD)
5. Bouncie device IMEI — optional. Ask: "Do you want to assign a Bouncie GPS tracker? If so, what is the IMEI?"

Validation rules (reject and re-ask if violated):
- price_per_day must be a positive number
- purchase_price must be a positive number
- purchase_date must be a valid calendar date in YYYY-MM-DD format
- type must always be "car" — never "slingshot" (those are managed separately)

Do NOT call create_vehicle until all required fields are collected and valid.

Before calling create_vehicle, ALWAYS show a confirmation summary in this exact format and ask for approval:

---
**New Vehicle Summary**
- Name: [vehicle name]
- Daily Price: $[price]/day
- Purchase Price: $[purchase_price]
- Purchase Date: [purchase_date]
- Bouncie Device: [IMEI or "None — mileage tracking will not be active"]

Shall I create this vehicle?
---

Only call create_vehicle with confirmed: true after the admin says yes.

After creation:
- Call get_vehicles to verify the vehicle appears in the fleet
- If bouncie_device_id was provided, confirm tracking_active: true in the result
- If any warnings are returned, relay them to the admin

## Mileage & maintenance context
- For questions about a specific vehicle's maintenance (e.g. "What's the maintenance status of Camry 2013?"), ALWAYS call get_maintenance_status with the vehicle name. Never use get_mileage for single-vehicle maintenance queries.
- Mileage tracking via GPS requires Bouncie devices. get_maintenance_status returns mileage-based alerts when a Bouncie device is assigned; otherwise it still returns service history and appointments.
- If get_mileage returns bouncie_configured: false, explain that the Bouncie GPS integration is not yet connected. Tell the admin to visit https://sly-rides.vercel.app/api/connectBouncie to authorize. Mileage sync activates within 5 minutes.
- If get_mileage returns tracked_vehicles: 0 AND raw_bouncie_rows: 0, explain that no cars currently have a Bouncie device ID saved in the database (editable in the Fleet page under each vehicle's IMEI field).
- If get_mileage returns tracked_vehicles: 0 AND raw_bouncie_rows > 0, explain that Bouncie devices appear to be assigned only to slingshots, not to the car fleet.
- If get_mileage returns tracked_vehicles: 0 but the dashboard is showing mileage alerts, there may be a temporary sync lag — suggest the admin refresh or re-save the vehicle's Bouncie IMEI in the Fleet page.
- If get_mileage returns a note field, relay that note to the admin as the reason data is unavailable.
- If get_mileage returns an error field, describe it as a data retrieval issue and suggest the admin check server logs or Supabase configuration.
- Never describe a missing Bouncie configuration or empty vehicle list as a "system error" — these are setup/configuration states.

## GPS Tracking context (get_gps_tracking)

Use get_gps_tracking for ANY question about real-time vehicle location or movement. Examples:
- "Where is the Camry right now?" → call get_gps_tracking
- "Is any car currently moving?" → call get_gps_tracking
- "What is the speed of the car?" → call get_gps_tracking
- "When did the GPS last sync?" → call get_gps_tracking
- "Show me the fleet GPS status" → call get_gps_tracking

**How to present get_gps_tracking results:**

When connected: true, present each vehicle like this:
- **[vehicle_name]** — [is_moving ? "🚗 Currently moving at [speed_mph] mph" : "🅿️ Parked"]
  - Signal: [signal === "ok" ? "✅ Live" : signal === "no_signal" ? "⚠️ No GPS signal" : "❌ No device assigned"]
  - Odometer: [odometer ? "[odometer] miles" : "Unknown"]
  - Last sync: [last_updated ? "[last_updated]" : "Never synced"]
  - Location: [lat && lon ? "[lat], [lon] (coordinates available)" : "No location data"]

**Signal states:**
- signal: "ok" — GPS is live with a valid location fix
- signal: "no_signal" — Device is assigned but hasn't sent a recent ping (may be parked indoors or offline)
- signal: "no_device" — No Bouncie IMEI assigned to this vehicle; tell the admin to add one via Fleet → vehicle → Bouncie Device ID

**When connected: false:**
- If message contains "not configured" or "no OAuth token": tell the admin to connect Bouncie at https://sly-rides.vercel.app/api/connectBouncie
- If message contains "unreachable" or "network": tell the admin the Bouncie API is temporarily unreachable, try again in a moment
- Any other message: relay it exactly and suggest checking server logs

**Location coordinates:** When lat/lon are available, note that exact coordinates are available on the GPS page of the admin dashboard for map view. Do NOT fabricate a street address from coordinates.

Tone: Professional, direct, data-driven. Always cite numbers when available.
When asked to take a destructive action (add vehicle, change pricing, send SMS), explain what you'll do and ask for confirmation before proceeding.
When the admin confirms an action, immediately retry the SAME tool call with confirmed: true added to the arguments. Do NOT ask for confirmation again.
Never fabricate data — always use tools to fetch real information.

## Extra Charges (Damages / Late Fees / Penalties)

Use **charge_customer_fee** to apply an off-session card charge to a customer's saved payment method. This works for any booking where the customer completed Stripe Checkout after April 7 2026 (when card-saving was enabled).

Predefined fees (no amount needed):
- \`key_replacement\` → $150
- \`smoking\` → $50

Variable fees (amount required):
- \`late_fee\` → provide amount in USD
- \`custom\` → provide amount in USD

Use **get_charges** to view all extra charges, or pass booking_id to see charges for a specific booking.

### Charging a customer (guided flow)

When the admin says anything like "charge [customer / booking] for [reason]":

**Step 1 — Find the booking:**
Call \`get_bookings(search: "[customer name or booking ID]")\` to confirm the booking exists and retrieve the booking ID.

**Step 2 — Determine charge details:**
- For key replacement / smoking: predefined fee applies (confirm amount with admin).
- For late fees or custom: ask the admin for the amount if not already stated.

**Step 3 — Show a confirmation summary:**
---
**Extra Charge**
- Booking: [bookingId]
- Customer: [name]
- Charge Type: [type]
- Amount: $[amount]
- Note: [notes or "None"]

Shall I charge this card now?
---

**Step 4 — Only call charge_customer_fee with confirmed: true after the admin says yes.**

After the tool returns:
- Confirm: "✅ $[amount] for [charge type] has been charged to [customer name]'s card. Confirmation emails sent to both you and the customer."
- If the tool returns an error about no saved payment method, explain that this booking predates card-saving (before April 7 2026) and suggest collecting payment manually.
- If Stripe declines the card, relay the exact error and suggest contacting the customer.`;

function buildSystemPrompt() {
  const now = new Date().toISOString();
  return `Current date/time: ${now}\n\n${SYSTEM_PROMPT_BASE}`;
}

// ── Confirmation-replay helpers ───────────────────────────────────────────────

/**
 * Scan a message list for the most recent unresolved requires_confirmation
 * tool result, then find the corresponding tool call's name and arguments.
 *
 * "Unresolved" means no successful tool result appeared after it.
 *
 * @param {object[]} messages
 * @returns {{ toolName: string, args: object } | null}
 */
function findPendingConfirmation(messages) {
  let pendingCallId = null;

  for (const m of messages) {
    if (m.role !== "tool") continue;
    let parsed;
    try { parsed = JSON.parse(m.content || "{}"); } catch { continue; }

    if (parsed.requires_confirmation) {
      // New unresolved confirmation found
      pendingCallId = m.tool_call_id;
    } else {
      // A successful tool result clears any earlier pending confirmation
      pendingCallId = null;
    }
  }

  if (!pendingCallId) return null;

  // Locate the assistant message that issued that tool call
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc.id !== pendingCallId) continue;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      return { toolName: tc.function.name, args };
    }
  }

  return null;
}

/**
 * Returns true when the admin text looks like a confirmation ("yes", "ok", etc.).
 * Deliberately narrow — we don't want false positives on normal queries.
 * Short-message guard (≤ 80 chars) avoids matching "okay, but what about...".
 */
function isConfirmation(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;
  return /\b(yes|yeah|yep|confirm|confirmed|proceed|do\s+it|go\s+ahead|approve|ok|okay|sure|absolutely)\b/i
    .test(trimmed);
}

/**
 * Build a human-readable success/failure reply for a confirmed tool execution.
 */
function formatConfirmedReply(toolName, args, result) {
  if (result.error) return `❌ Action failed: ${result.error}`;
  // Strip backticks/asterisks from dynamic values so they can't break markdown formatting
  const safe = (v) => String(v ?? "").replace(/[`*_[\]]/g, "");
  switch (toolName) {
    case "create_vehicle": {
      const warnings = result.warnings?.length
        ? `\n⚠️ ${result.warnings.join("\n⚠️ ")}`
        : "";
      return `✅ Vehicle **${safe(result.name)}** created successfully (ID: \`${safe(result.created)}\`).\n- Price: $${safe(result.price_per_day)}/day\n- Purchase: $${safe(result.purchase_price)} on ${safe(result.purchase_date)}\n- Tracking: ${result.tracking_active ? `✅ Bouncie assigned (${safe(result.bouncie_device_id)})` : "⚠️ No Bouncie device — assign one via update_vehicle to enable mileage tracking"}${warnings}`;
    }
    case "add_vehicle":
      return `✅ Vehicle **${safe(result.name)}** added successfully (ID: \`${safe(result.created)}\`).`;
    case "update_vehicle":
      return `✅ Vehicle \`${safe(args.vehicleId)}\` updated successfully.`;
    case "send_sms":
      return `✅ SMS sent to ${safe(args.phone)}.`;
    case "mark_maintenance":
      return `✅ ${safe(result.message || "Maintenance recorded.")}`;
    case "flag_booking":
      return `✅ Booking \`${safe(args.bookingId)}\` flagged.`;
    case "update_booking_status":
      return `✅ Booking \`${safe(args.bookingId)}\` status updated to **${safe(args.status)}**.`;
    case "confirm_vehicle_action":
      return `✅ ${safe(result.message || `Action recorded for ${args.vehicleId}.`)}`;
    case "update_action_status":
      return `✅ ${safe(result.message || `Action status updated for ${args.vehicleId}.`)}`;
    case "send_message_to_driver":
      return `✅ Message sent to driver of booking \`${safe(args.bookingId)}\` (${safe(result.to)}).`;
    case "register_bouncie_device": {
      const syncIcon = result.sync_status === "active"
        ? "✅ Tracking active"
        : result.sync_status === "stale"
          ? "⚠️ Device not syncing — check power"
          : "🕐 Awaiting first GPS sync";
      return (
        `✅ Bouncie device \`${safe(result.bouncie_device_id)}\` assigned to **${safe(result.vehicle_name)}**.\n` +
        `- Sync status: ${syncIcon}\n` +
        (result.last_synced_at
          ? `- Last sync: ${safe(result.last_synced_at)}\n`
          : `- No sync recorded yet — power on the device and drive briefly to trigger the first ping.\n`)
      );
    }
    case "add_expense": {
      const e = result.expense || {};
      return `✅ Expense added — ${safe(e.category)} $${safe(e.amount)} for ${safe(e.vehicle_id)} on ${safe(e.date)}. ID: \`${safe(e.expense_id)}\``;
    }
    case "delete_expense":
      return `✅ Expense \`${safe(result.deleted)}\` deleted.`;
    case "block_dates":
      return `${safe(result.message || `Dates blocked for ${args.vehicleId}: ${args.from} → ${args.to}`)}`;
    case "open_dates":
      return `${safe(result.message || `Dates unblocked for ${args.vehicleId}: ${args.from} → ${args.to}`)}`;
    case "update_system_setting": {
      const s = result.setting || {};
      return `✅ Setting **${safe(s.key || args.key)}** updated to \`${safe(JSON.stringify(s.value ?? args.value))}\`.`;
    }
    case "update_sms_template": {
      const t = result.template || {};
      const status = t.enabled === false ? "🔕 disabled" : "✅ enabled";
      return `✅ SMS template **${safe(t.template_key || args.templateKey)}** updated (${status}).`;
    }
    case "update_customer": {
      const c = result.customer || {};
      const banStatus   = c.banned  ? "🚫 banned"  : c.banned === false ? "✅ unbanned" : null;
      const flagStatus  = c.flagged ? "⚠️ flagged" : c.flagged === false ? "cleared"    : null;
      const parts = [banStatus, flagStatus].filter(Boolean);
      return `✅ Customer **${safe(c.name || args.id)}** updated${parts.length ? ` (${parts.join(", ")})` : ""}.`;
    }
    case "delete_vehicle":
      return `✅ Vehicle **${safe(result.name)}** (\`${safe(result.deleted)}\`) permanently deleted.`;
    case "charge_customer_fee": {
      const c = result.charge || {};
      return (
        `✅ ${safe(result.message || "Charge applied.")}\n` +
        `- Charge reference: \`${safe(c.id || "")}\`\n` +
        `- Status: ${c.status === "succeeded" ? "✅ succeeded" : safe(c.status)}`
      );
    }
    default:
      return `✅ Action completed: ${JSON.stringify(result)}`;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server configuration error: OPENAI_API_KEY is not set." });
  }

  const body = req.body || {};
  const { secret, messages: clientMessages, auto_mode: autoMode = false } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!Array.isArray(clientMessages) || clientMessages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // Validate message structure
  const validRoles = new Set(["user", "assistant", "tool", "system"]);
  for (const m of clientMessages) {
    if (!m || !validRoles.has(m.role)) {
      return res.status(400).json({ error: `Invalid message role: ${m?.role}` });
    }
  }

  // Per-round timeout budget.
  // PR #396 fixed single-round "Failed to fetch" with a 25 s client timeout.
  // PR #397 added write tools that trigger multi-round flows (fetch data →
  // act → reply).  Two rounds × 25 s = 50 s, which exceeds Vercel's 30 s
  // maxDuration — the function is killed mid-flight, the TCP connection drops,
  // and the browser sees "TypeError: Failed to fetch" with no useful message.
  //
  // Fix: track total elapsed time and calculate a per-round timeout so the
  // function always has enough time left to return a proper JSON response.
  // vercel.json sets maxDuration: 60 for this function as a safety net.
  const BUDGET_MS              = 45000; // 45 s soft budget (15 s under the 60 s maxDuration)
  const MAX_ROUND_TIMEOUT      = 20000; // cap per-round OpenAI timeout at 20 s
  const MIN_RESPONSE_BUFFER_MS =  3000; // reserve 3 s for JSON serialisation
  const MIN_TOOL_EXECUTION_MS  =  1000; // bail if < 1 s remains before starting a tool call
  // Max messages to send to OpenAI (system prompt excluded).  Long conversation
  // histories increase token count and latency — trimming prevents "Failed to
  // fetch" timeouts caused by the OpenAI call taking too long.
  const MAX_HISTORY_MESSAGES   =    20;
  const startTime  = Date.now();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model  = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  // Trim conversation history to at most MAX_HISTORY_MESSAGES entries so that
  // long conversations don't inflate the OpenAI request size and slow things
  // down past the budget.  Trimming always starts at a "user" message so the
  // resulting slice is a valid conversation (never an orphaned tool result).
  let trimmedMessages = clientMessages;
  if (clientMessages.length > MAX_HISTORY_MESSAGES) {
    const slice = clientMessages.slice(clientMessages.length - MAX_HISTORY_MESSAGES);
    const firstUserIdx = slice.findIndex((m) => m.role === "user");
    if (firstUserIdx >= 0) {
      trimmedMessages = slice.slice(firstUserIdx);
    } else {
      // No user message found in the last MAX_HISTORY_MESSAGES — find the most
      // recent user message in the full history and start from there.
      const lastUserIdxFull = clientMessages.map((m) => m.role).lastIndexOf("user");
      trimmedMessages = lastUserIdxFull >= 0
        ? clientMessages.slice(lastUserIdxFull)
        : clientMessages.slice(-1);
    }
  }

  // Build message list (system + trimmed history)
  // System prompt is built dynamically to include the real-time current date/time.
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...trimmedMessages,
  ];

  const toolCallsMade = [];

  // ── Deterministic confirmation replay ────────────────────────────────────
  // If the history contains an unresolved requires_confirmation tool result
  // AND the latest user message is a simple confirmation, execute the pending
  // action directly without going through OpenAI. This guarantees the action
  // completes after exactly one confirmation regardless of AI behaviour.
  const lastUserMsg = [...clientMessages].reverse().find(m => m.role === "user");
  const pending = findPendingConfirmation(clientMessages);

  if (pending && lastUserMsg && isConfirmation(lastUserMsg.content)) {
    let toolResult;
    try {
      toolResult = await Promise.race([
        executeAction(
          pending.toolName,
          { ...pending.args, confirmed: true },
          { requireConfirmation: !autoMode },
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Action "${pending.toolName}" timed out`)), BUDGET_MS - MIN_RESPONSE_BUFFER_MS)
        ),
      ]);
    } catch (err) {
      toolResult = { error: err.message };
    }

    const reply = formatConfirmedReply(pending.toolName, pending.args, toolResult);
    return res.status(200).json({
      reply,
      tool_calls:  [pending.toolName],
      messages:    [...clientMessages, { role: "assistant", content: reply }],
    });
  }

  // ── Agentic loop ─────────────────────────────────────────────────────────
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Calculate remaining budget; reserve 3 s for response serialisation.
    const elapsed   = Date.now() - startTime;
    const remaining = BUDGET_MS - elapsed - MIN_RESPONSE_BUFFER_MS;

    if (remaining <= 2000) {
      // Out of budget — return a readable message instead of dropping the connection.
      return res.status(200).json({
        reply:      "⏱ This request is taking longer than expected. Please try again or ask a simpler question.",
        tool_calls: toolCallsMade,
        messages:   messages.slice(1),
      });
    }

    // Cap per-round timeout at MAX_ROUND_TIMEOUT so one slow call can't consume the entire budget.
    const roundTimeout = Math.min(remaining, MAX_ROUND_TIMEOUT);

    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      }, { timeout: roundTimeout });
    } catch (err) {
      console.error("admin-chat: OpenAI error:", err);
      return res.status(500).json({ error: `OpenAI error: ${err.message}` });
    }

    const choice = completion.choices[0];
    const msg    = choice.message;

    // Append the assistant turn to the running message list
    messages.push(msg);

    // If no tool calls, we're done
    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      // Return the final text response and updated messages (minus system prompt)
      return res.status(200).json({
        reply:       msg.content || "",
        tool_calls:  toolCallsMade,
        messages:    messages.slice(1), // strip system prompt before returning
      });
    }

    // Execute each tool call
    let toolBudgetExceeded = false;
    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      let args;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      toolCallsMade.push(toolName);

      // Calculate per-tool timeout from the remaining budget so a hanging
      // Supabase / external-API call cannot block until Vercel kills the
      // function (which drops the TCP connection and causes "Failed to fetch"
      // on the client instead of a clean JSON error response).
      const toolElapsed   = Date.now() - startTime;
      const toolRemaining = BUDGET_MS - toolElapsed - MIN_RESPONSE_BUFFER_MS;
      if (toolRemaining < MIN_TOOL_EXECUTION_MS) {
        toolBudgetExceeded = true;
        break;
      }
      const toolTimeout = Math.min(toolRemaining, MAX_ROUND_TIMEOUT);

      let toolResult;
      try {
        // Pass requireConfirmation=true unless autoMode is explicitly on.
        // Race against a budget-aware timeout so a hanging tool cannot block
        // until Vercel kills the function at maxDuration.
        toolResult = await Promise.race([
          executeAction(toolName, args, { requireConfirmation: !autoMode }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${toolTimeout} ms`)), toolTimeout)
          ),
        ]);
      } catch (err) {
        toolResult = { error: err.message };
      }

      // Append tool result for the next OpenAI round
      messages.push({
        role:          "tool",
        tool_call_id:  tc.id,
        content:       JSON.stringify(toolResult),
      });
    }

    // Guard against slow tool execution consuming the entire budget.
    if (toolBudgetExceeded || Date.now() - startTime >= BUDGET_MS - MIN_RESPONSE_BUFFER_MS) {
      return res.status(200).json({
        reply:      "⏱ This request is taking longer than expected. Please try again or ask a simpler question.",
        tool_calls: toolCallsMade,
        messages:   messages.slice(1),
      });
    }
  }

  // Fallback if loop exhausted
  return res.status(200).json({
    reply:      "I reached the maximum number of tool-call rounds. Please try a more specific question.",
    tool_calls: toolCallsMade,
    messages:   messages.slice(1),
  });

  } catch (err) {
    console.error("ADMIN CHAT CRASH:", err);
    return res.status(200).json({
      message: "⚠ Something went wrong, but the system is still running.",
      error: process.env.NODE_ENV === "development" ? err.message : "Internal server error",
    });
  }
}
