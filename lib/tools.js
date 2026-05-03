// lib/tools.js
// OpenAI function-calling tool definitions for the AI admin assistant.
// Each tool has:
//   - definition   → OpenAI ChatCompletionTool schema
//   - description  → human-readable summary (also shown in audit log)
//
// Execution is handled by api/_admin-actions.js, which imports this file
// to build the tools array passed to OpenAI and to dispatch tool calls.

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_revenue",
      description:
        "Get revenue totals for a specific month or overall. Returns total revenue, number of paid bookings, and a per-vehicle breakdown.",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description:
              'Optional ISO month string "YYYY-MM" (e.g. "2025-03"). When omitted returns all-time revenue.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bookings",
      description:
        "List bookings, optionally filtered by vehicle, status, or customer search. Returns booking details including customer name, dates, status, amount, and hasSavedCard (true if the customer's card is saved for off-session charges).",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Optional vehicle ID to filter by (e.g. "camry").',
          },
          status: {
            type: "string",
            description:
              'Optional booking status filter: "reserved_unpaid" | "booked_paid" | "active_rental" | "completed_rental" | "cancelled_rental".',
          },
          search: {
            type: "string",
            description: "Search bookings by customer name, phone number, or email address.",
          },
          limit: {
            type: "number",
            description: "Maximum number of bookings to return (default 20, max 100).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_vehicles",
      description:
        "List all vehicles with their current status, pricing, and booking count.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_vehicle",
      description:
        "Create a new car in the main rental fleet. ONLY call this after collecting ALL required fields from the admin: name, price_per_day (> 0), purchase_price (> 0), purchase_date (YYYY-MM-DD). Type is always \"car\". Requires admin confirmation showing a full summary before executing. Do NOT call with missing or zero values.",
      parameters: {
        type: "object",
        properties: {
          vehicle_id: {
            type: "string",
            description: "Optional. Explicit vehicle ID to use (lowercase letters, digits, hyphens, or underscores; 2–50 chars; e.g. \"camry2014\"). If omitted, one is auto-generated from the name. When provided, this exact ID is used — always pass this when following the ADD_NEW_VEHICLE flow.",
          },
          name: {
            type: "string",
            description: 'Display name for the vehicle (e.g. "Camry 2014 SE").',
          },
          type: {
            type: "string",
            description:
              'Vehicle type. Must be "car" for standard rentals.',
          },
          price_per_day: {
            type: "number",
            description: "Daily rental rate in USD. Must be greater than 0.",
          },
          weekly_rate: {
            type: "number",
            description: "Optional. Weekly rental rate in USD (e.g. 350). Set when a discounted weekly price is offered.",
          },
          deposit: {
            type: "number",
            description: "Optional. Security deposit amount in USD (e.g. 150). Set to 0 or omit if no deposit is required.",
          },
          purchase_price: {
            type: "number",
            description: "The price paid to acquire the vehicle in USD. Must be greater than 0.",
          },
          purchase_date: {
            type: "string",
            description: "Date the vehicle was purchased, in YYYY-MM-DD format (e.g. \"2024-01-10\").",
          },
          bouncie_device_id: {
            type: "string",
            description: "Optional. Bouncie GPS tracker IMEI to assign to this vehicle for mileage and maintenance tracking.",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed the vehicle summary.",
          },
        },
        required: ["name", "price_per_day", "purchase_price", "purchase_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_vehicle",
      description:
        "Add a new vehicle to the fleet. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: "Unique slug identifier (lowercase letters, digits, hyphens; e.g. \"camry2014\"). If omitted, one is auto-generated from vehicleName.",
          },
          vehicleName: {
            type: "string",
            description: 'Display name (e.g. "Camry 2014 SE").',
          },
          type: {
            type: "string",
            description:
              'Vehicle type: "car" | "economy" | "luxury" | "suv" | "truck" | "van" | "other". Defaults to "car".',
          },
          dailyRate: {
            type: "number",
            description: "Daily rental rate in USD.",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["vehicleName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_vehicle",
      description:
        "Update a vehicle's details. Non-critical updates (name, bouncie_device_id, metadata) execute automatically in auto mode. Pricing changes (price_per_day / daily_rate) always require confirmation. Availability changes (status: inactive) require strict approval.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: "The vehicle ID to update.",
          },
          updates: {
            type: "object",
            description:
              "Fields to update. Allowed keys: vehicle_name, status (active|maintenance|inactive), daily_rate, price_per_day (alias for daily_rate), bouncie_device_id (Bouncie IMEI — set to null to remove), metadata (arbitrary key/value pairs to merge into the vehicle record).",
            properties: {
              vehicle_name:      { type: "string" },
              status:            { type: "string" },
              daily_rate:        { type: "number" },
              price_per_day:     { type: "number" },
              bouncie_device_id: { type: ["string", "null"] },
              metadata:          { type: "object" },
            },
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["vehicleId", "updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_sms",
      description:
        "Send an SMS message to a phone number via TextMagic. Use for customer follow-ups, alerts, or reminders.",
      parameters: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description: "Recipient phone number in E.164 format (e.g. +12125550000).",
          },
          message: {
            type: "string",
            description: "The SMS message body (max 160 chars recommended).",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["phone", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_insights",
      description:
        "Run the business intelligence engine and return revenue trends, booking statistics, vehicle performance, and detected problems.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fraud_report",
      description:
        "Score all bookings for fraud risk. Returns flagged bookings with risk scores and reasons.",
      parameters: {
        type: "object",
        properties: {
          flaggedOnly: {
            type: "boolean",
            description: "When true (default), return only flagged bookings (risk_score >= 31).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_maintenance_status",
      description:
        "Get maintenance status for a specific vehicle by name. Returns scheduled appointments, service history, mileage-based maintenance alerts, and any open maintenance records. Use this tool whenever the admin asks about maintenance, service, oil change, brakes, tires, or vehicle condition for a named vehicle. Works for ALL vehicles — does not require GPS/Bouncie tracking.",
      parameters: {
        type: "object",
        properties: {
          vehicleName: {
            type: "string",
            description:
              'Vehicle name or partial name to look up (e.g. "Camry 2013", "camry"). Case-insensitive.',
          },
        },
        required: ["vehicleName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_maintenance_status",
      description:
        "Run the fleet-wide maintenance status checker. Loops through all tracked vehicles, computes OK / DUE_SOON / OVERDUE status based on miles since last service vs. each vehicle's maintenance_interval (default 5000 mi), upserts the maintenance table, and escalates OVERDUE vehicles to action_status = 'pending'. Returns structured alerts with critical (OVERDUE) and warning (DUE_SOON) entries. Call this after recording mileage, after a booking completes, or when the admin asks for a fleet maintenance overview.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mileage",
      description:
        "Get current odometer readings, maintenance status, and usage trends for all Bouncie-tracked vehicles. Returns per-vehicle mileage stats and any active maintenance or high-usage alerts.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_gps_tracking",
      description:
        "Get real-time GPS tracking data for all Bouncie-tracked fleet vehicles. Returns live location (latitude/longitude), speed (mph), heading, movement status (is_moving), odometer reading, and last sync time for each vehicle. Use this whenever the admin asks about current location, whether a car is moving, where a vehicle is right now, GPS signal status, or any live tracking question.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_maintenance",
      description:
        "Record that a specific maintenance service (oil change, brake inspection, or tire replacement) was performed on a vehicle. By default uses the vehicle's current odometer reading; supply mileage to record the service at a specific odometer value instead. Resets the per-service miles counter. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'The vehicle ID to update (e.g. "camry2013").',
          },
          serviceType: {
            type: "string",
            description: 'The type of service completed: "oil" | "brakes" | "tires".',
          },
          mileage: {
            type: "number",
            description: "Optional. The exact odometer reading at which the service was performed. If omitted, the vehicle's current odometer is used.",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["vehicleId", "serviceType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_booking",
      description:
        "Flag a booking as suspicious or problematic. Sets the booking's flagged field to true. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: "The booking ID to flag.",
          },
          reason: {
            type: "string",
            description: "The reason for flagging the booking.",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["bookingId", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_booking_status",
      description:
        "Update the status of a booking. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: "The booking ID to update.",
          },
          status: {
            type: "string",
            description:
              'New status: "reserved_unpaid" | "booked_paid" | "active_rental" | "completed_rental" | "cancelled_rental".',
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["bookingId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_booking_times",
      description:
        "Update the pickup_time and/or return_time for a booking without changing the dates or repricing. Use this to correct an incorrect time on an active or future rental. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: 'The booking_ref of the booking to update (e.g. "bk-abc123").',
          },
          pickupTime: {
            type: "string",
            description: 'New pickup time in HH:MM (24-hour) or "H:MM AM/PM" format, e.g. "08:00" or "8:00 AM". Omit to leave unchanged.',
          },
          returnTime: {
            type: "string",
            description: 'New return time in HH:MM (24-hour) or "H:MM AM/PM" format, e.g. "08:00" or "8:00 AM". Omit to leave unchanged.',
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["bookingId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_vehicle_action",
      description:
        "Record a strategic decision about a vehicle (review for sale or flag as needing attention). Sets decision_status and action_status badges on the vehicle. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: "The vehicle ID.",
          },
          action: {
            type: "string",
            description: '"review_for_sale" — vehicle is a candidate for sale. "needs_attention" — vehicle requires attention from the owner.',
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["vehicleId", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_action_status",
      description:
        "Progress the action lifecycle for a vehicle: pending → in_progress → resolved. Only forward transitions are allowed. Use this when the admin starts working on an issue (pending → in_progress) or when the issue is resolved (in_progress → resolved). Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: "The vehicle ID.",
          },
          action_status: {
            type: "string",
            description: '"pending" | "in_progress" | "resolved". Must be a forward step from the current status.',
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["vehicleId", "action_status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message_to_driver",
      description:
        "Send an SMS message to the driver/renter of a specific booking (looked up by booking ID). Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: "The booking ID whose renter should receive the message.",
          },
          message: {
            type: "string",
            description: "The SMS message body (max 160 chars recommended).",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["bookingId", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_expenses",
      description:
        "Get expense records for the fleet. Returns total spend, breakdown by group and category, and a list of individual expense entries. Each expense includes category_name and category_group from the two-level hierarchy. Use to answer questions about costs, maintenance spend, fuel, insurance, or profitability.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Optional vehicle ID to filter expenses (e.g. "camry2013").',
          },
          category: {
            type: "string",
            description: 'Optional category name filter (e.g. "Oil Change", "Fuel"). Also accepts legacy flat values: "maintenance" | "insurance" | "repair" | "fuel" | "registration" | "other".',
          },
          group: {
            type: "string",
            description: 'Optional group filter (e.g. "Maintenance", "Usage", "Ownership", "Repairs", "Cleaning", "Extras", "Incidents", "Advanced").',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_expense_categories",
      description:
        "List all expense categories (both active and inactive) from the two-level hierarchy. Returns categories grouped by group_name. Use before add_expense to find the right category_id, or to understand what categories are available.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_analytics",
      description:
        "Get fleet analytics: utilization rates, revenue trends over time, and per-vehicle performance. Use to answer questions about which vehicles earn the most, booking trends by month, or overall fleet productivity.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: '"fleet" (default) — overview of all vehicles. "vehicle" — deep-dive for a single vehicle (requires vehicleId). "revenue_trend" — monthly revenue over last N months.',
          },
          vehicleId: {
            type: "string",
            description: 'Required when action is "vehicle". The vehicle ID to analyse.',
          },
          months: {
            type: "number",
            description: 'Number of months for revenue_trend (default 6, max 24).',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customers",
      description:
        "Search and list customers. Returns customer profiles with booking history, spend, and any flags or bans. Use to answer questions about a specific renter or to identify high-value or problematic customers.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Search by name, phone number, or email address.",
          },
          flagged: {
            type: "boolean",
            description: "When true, return only flagged customers.",
          },
          banned: {
            type: "boolean",
            description: "When true, return only banned customers.",
          },
          limit: {
            type: "number",
            description: "Maximum customers to return (default 50, max 200).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_protection_plans",
      description:
        "List all protection plan tiers available for rentals. Returns plan names, daily rates, liability caps, and active status.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_system_settings",
      description:
        "Get system configuration settings: pricing rates, tax rates, automation toggles, and notification preferences. Use to answer questions about current rates, deposit amounts, or which automations are enabled.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: 'Optional category filter: "pricing" | "tax" | "automation" | "notification".',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sms_templates",
      description:
        "List all SMS automation templates used by the system (booking confirmations, reminders, late notices, retention messages, etc.). Returns the current message text and whether each template is enabled.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_blocked_dates",
      description:
        "Get the blocking timeline for fleet vehicles. Each booking is broken down into per-segment rows: source='base' for the original rental period and source='extension' for each paid extension. Manual and maintenance blocks are also included. Use this to see the correct base rental dates, extension chain, and any manual holds — no revenue_records reconstruction needed.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Optional vehicle ID to filter (e.g. "camry"). Omit to get all vehicles.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_price_quote",
      description:
        "Compute a rental price quote using the live pricing system. Returns a detailed breakdown (daily/weekly/monthly tiers, tax, total). Use this whenever the admin asks 'how much for X days?' or any pricing question. Never calculate rental totals manually — always call this tool to ensure the quote matches what the customer will be charged.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Vehicle ID to quote (e.g. "camry", or a newly created vehicle ID).',
          },
          pickup: {
            type: "string",
            description: 'Pickup date in YYYY-MM-DD format.',
          },
          returnDate: {
            type: "string",
            description: 'Return date in YYYY-MM-DD format.',
          },
        },
        required: ["vehicleId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "register_bouncie_device",
      description:
        "Assign a Bouncie GPS tracker IMEI to a specific vehicle. Validates the IMEI format (must be exactly 15 digits), checks for duplicate assignments across the fleet, saves the device ID, and confirms the assignment with a post-write verification. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'The vehicle ID to assign the Bouncie device to (e.g. "camry2013").',
          },
          imei: {
            type: "string",
            description: "The 15-digit IMEI printed on the Bouncie device (digits only, no spaces or dashes).",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["vehicleId", "imei"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resend_booking_confirmation",
      description:
        "Re-send a booking confirmation email to both the renter and the owner for an existing booking. Use this when the customer reports they never received their confirmation, or when a booking was added manually and no email was sent. Looks up the booking by bookingId and sends a plain confirmation email via SMTP.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: 'The bookingId of the booking (e.g. "bk-bb-2026-0407").',
          },
        },
        required: ["bookingId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_manual_booking",
      description:
        "Manually create a booking record for a cash, phone, or website payment where the booking was not logged in the system. Blocks the dates on the calendar, saves the booking, and syncs to Supabase. Use this when: (1) a customer pays in cash / books over the phone, OR (2) a customer paid on the website but the booking record is missing from the system (e.g. the send-reservation-email call failed). For website payments, pass the Stripe paymentIntentId so the record is properly linked.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Vehicle to book. One of: "camry", "camry2013".',
          },
          name: {
            type: "string",
            description: "Customer full name (required).",
          },
          phone: {
            type: "string",
            description: "Customer phone number (optional).",
          },
          email: {
            type: "string",
            description: "Customer email address (optional).",
          },
          pickupDate: {
            type: "string",
            description: "Rental start date in YYYY-MM-DD format (required).",
          },
          pickupTime: {
            type: "string",
            description: 'Pickup time, e.g. "10:00 AM" or "08:00" (required).',
          },
          returnDate: {
            type: "string",
            description: "Rental end date in YYYY-MM-DD format (required).",
          },
          returnTime: {
            type: "string",
            description: 'Return time, e.g. "5:00 PM" or "08:00" (required).',
          },
          amountPaid: {
            type: "number",
            description: "Total amount paid in dollars (optional, e.g. 350).",
          },
          totalPrice: {
            type: "number",
            description: "Optional full rental price in dollars. Provide this for reservation/deposit payments so the booking can be marked as reserved_unpaid when amountPaid is lower than totalPrice.",
          },
          paymentIntentId: {
            type: "string",
            description: 'Stripe Payment Intent ID from the website payment (e.g. "pi_3ABC..."). Provide this when the customer paid on the website so the booking is linked to the real Stripe transaction. Omit for cash/phone bookings.',
          },
          stripeFee: {
            type: "number",
            description: "Optional Stripe processing fee in dollars for this payment (e.g. 1.75).",
          },
          stripeNet: {
            type: "number",
            description: "Optional Stripe net amount in dollars for this payment (e.g. 48.25).",
          },
          notes: {
            type: "string",
            description: 'Any notes about the booking, e.g. "Cash payment — collected in person" or "Website payment — emails not received" (optional).',
          },
          sendConfirmationEmail: {
            type: "boolean",
            description: "Set false when the admin explicitly says not to send/resend confirmation emails.",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["vehicleId", "name", "pickupDate", "pickupTime", "returnDate", "returnTime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_expense",
      description:
        "Log a new expense record for a fleet vehicle (e.g. oil change, insurance payment, fuel cost). Call get_expense_categories first to find the correct category_id. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          vehicle_id: {
            type: "string",
            description: 'Vehicle ID the expense belongs to (e.g. "camry").',
          },
          date: {
            type: "string",
            description: "Date of the expense in YYYY-MM-DD format.",
          },
          category_id: {
            type: "string",
            description: "UUID of the expense category (preferred). Obtain from get_expense_categories.",
          },
          category: {
            type: "string",
            description: 'Legacy flat category (fallback only): "maintenance" | "insurance" | "repair" | "fuel" | "registration" | "other". Use category_id instead when possible.',
          },
          amount: {
            type: "number",
            description: "Expense amount in USD (e.g. 75.50).",
          },
          notes: {
            type: "string",
            description: "Optional notes about the expense (max 500 chars).",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["vehicle_id", "date", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_expense_category",
      description:
        "Create, rename, or enable/disable an expense category. Use to add custom categories, fix typos in names, or hide categories that are no longer needed. Requires admin confirmation.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "toggle"],
            description: '"create" — add a new category. "update" — rename an existing one. "toggle" — enable or disable.',
          },
          id: {
            type: "string",
            description: "Category UUID (required for update/toggle). Obtain from get_expense_categories.",
          },
          name: {
            type: "string",
            description: "Category name (required for create/update).",
          },
          group_name: {
            type: "string",
            description: 'Group this category belongs to (required for create). E.g. "Maintenance", "Usage", "Ownership".',
          },
          is_active: {
            type: "boolean",
            description: "New active state (required for toggle).",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_expense",
      description:
        "Permanently delete an expense record by its expense_id. Use get_expenses first to find the expense_id. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          expense_id: {
            type: "string",
            description: "The expense_id of the record to delete (hex string from get_expenses results).",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["expense_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "block_dates",
      description:
        "Manually block a date range on the calendar for a vehicle so it shows as unavailable to customers. Use this when a vehicle is unavailable for any reason not tied to an existing booking (e.g. personal use, maintenance downtime). Requires admin confirmation.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Vehicle ID to block (e.g. "camry").',
          },
          from: {
            type: "string",
            description: "Start date in YYYY-MM-DD format (inclusive).",
          },
          to: {
            type: "string",
            description: "End date in YYYY-MM-DD format (inclusive).",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["vehicleId", "from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_dates",
      description:
        "Remove a manually-blocked date range from the calendar, making those dates bookable again. Only removes ranges that exactly match the from/to dates provided. Requires admin confirmation.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Vehicle ID to unblock (e.g. "camry").',
          },
          from: {
            type: "string",
            description: "Start date of the block to remove (YYYY-MM-DD).",
          },
          to: {
            type: "string",
            description: "End date of the block to remove (YYYY-MM-DD).",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["vehicleId", "from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_system_setting",
      description:
        "Change a system setting value (e.g. tax rate, pricing tiers, automation toggles, notification toggles). Use get_system_settings first to see current values and valid keys. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: 'Setting key to update (e.g. "la_tax_rate", "camry_daily_rate", "notify_sms_on_approve").',
          },
          value: {
            description: "New value for the setting (number, boolean, or string depending on the setting).",
          },
          description: {
            type: "string",
            description: "Optional description update for the setting.",
          },
          category: {
            type: "string",
            description: 'Optional category for the setting (e.g. "pricing", "tax", "automation", "notification").',
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_sms_template",
      description:
        "Edit the message text and/or enable/disable an SMS automation template. Use get_sms_templates first to find the template key and see the current message. Requires admin confirmation.",
      parameters: {
        type: "object",
        properties: {
          templateKey: {
            type: "string",
            description: "The template key to update (e.g. \"BOOKING_CONFIRMED\", \"LATE_NOTICE\"). Use get_sms_templates to see all valid keys.",
          },
          message: {
            type: "string",
            description: "New message text (max 1000 chars). Use {variable} placeholders as shown by get_sms_templates. Omit to leave message unchanged.",
          },
          enabled: {
            type: "boolean",
            description: "Set to true to enable or false to disable this template. Omit to leave unchanged.",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["templateKey"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_customer",
      description:
        "Update a customer record — ban/unban, flag/unflag, add notes, update contact info, or set risk level. Use get_customers first to find the customer id. Requires admin confirmation.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The customer id (UUID from get_customers results).",
          },
          updates: {
            type: "object",
            description: "Fields to update on the customer record.",
            properties: {
              banned:      { type: "boolean",  description: "Ban (true) or unban (false) the customer." },
              ban_reason:  { type: "string",   description: "Reason for the ban (required when banning)." },
              flagged:     { type: "boolean",  description: "Flag (true) or unflag (false) the customer." },
              flag_reason: { type: "string",   description: "Reason for the flag." },
              notes:       { type: "string",   description: "Internal admin notes about this customer." },
              risk_flag:   { type: "string",   enum: ["low", "medium", "high"], description: "Customer risk level." },
              name:        { type: "string",   description: "Update customer name." },
              email:       { type: "string",   description: "Update customer email." },
              phone:       { type: "string",   description: "Update customer phone number." },
            },
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["id", "updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recount_customer_counts",
      description:
        "Recalculate customer booking counts strictly from the bookings table (COUNT WHERE customer_id). Also backfills bookings.customer_id for any unlinked rows. Use when customer booking counts look wrong or after a Stripe pipeline fix that may have left stale counts. Does NOT require confirmation.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_vehicle",
      description:
        "Permanently delete a vehicle from the fleet. This removes the vehicle from Supabase and vehicles.json. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: "The vehicle ID to permanently delete (e.g. a custom car created via create_vehicle).",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["vehicleId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "charge_customer_fee",
      description:
        "Charge a customer's saved card for an extra fee (damages, late return, key replacement, smoking penalty, etc.). " +
        "Uses the Stripe payment method saved during their original booking checkout. " +
        "Always confirm booking exists with get_bookings before charging. " +
        "Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          booking_id: {
            type: "string",
            description: 'The booking_ref / bookingId of the booking to charge (e.g. "bk-abc123").',
          },
          charge_type: {
            type: "string",
            enum: ["key_replacement", "smoking", "late_fee", "custom"],
            description:
              '"key_replacement" ($150 predefined), "smoking" ($50 predefined), ' +
              '"late_fee" (requires amount), "custom" (requires amount).',
          },
          amount: {
            type: "number",
            description:
              "USD amount to charge. Optional for key_replacement ($150) and smoking ($50) — the predefined fee is used when omitted. " +
              "Required for late_fee and custom.",
          },
          notes: {
            type: "string",
            description: "Optional short description shown in the charge record and customer email (max 500 chars).",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["booking_id", "charge_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_charges",
      description:
        "List extra charges that have been applied to customer bookings (damages, late fees, etc.). " +
        "Optionally filter by booking_id.",
      parameters: {
        type: "object",
        properties: {
          booking_id: {
            type: "string",
            description: "Optional booking_ref to filter charges for a specific booking.",
          },
          limit: {
            type: "number",
            description: "Maximum number of charges to return (default 50, max 200).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_extension_payment",
      description:
        "Manually record a rental extension payment (cash, phone, or any non-Stripe method). " +
        "Updates amountPaid and returnDate on the booking, creates an extension revenue record, " +
        "and syncs bookings.json and Supabase. Use this when a renter pays cash or over the phone " +
        "to extend their rental — do NOT use charge_customer_fee for extensions. " +
        "Always confirm the booking exists with get_bookings first. Requires admin confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          bookingId: {
            type: "string",
            description: "The booking ID of the active rental being extended.",
          },
          vehicleId: {
            type: "string",
            description: 'Optional vehicle ID (e.g. "camry") — helps locate the booking faster.',
          },
          extensionAmount: {
            type: "number",
            description: "Amount paid for the extension in USD (e.g. 55 for one extra day at $55/day).",
          },
          newReturnDate: {
            type: "string",
            description: "New return date in YYYY-MM-DD format (must be after the current return date).",
          },
          newReturnTime: {
            type: "string",
            description: 'New return time, e.g. "11:00 AM". Optional — leave blank to keep existing return time.',
          },
          notes: {
            type: "string",
            description: "Optional note about the extension, e.g. \"Cash payment collected in person\".",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true when the admin has explicitly confirmed this action.",
          },
        },
        required: ["bookingId", "extensionAmount", "newReturnDate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reconcile_stripe",
      description:
        "Rebuild financial data from Stripe API. Fetches all succeeded PaymentIntents, expands balance_transaction for each, and updates revenue records with stripe_fee and stripe_net. " +
        "Also applies fee=0/net=gross for cash payments. Returns verification totals (Stripe gross, fees, net) and per-vehicle analytics. " +
        "Use this when the admin asks to reconcile payments, sync Stripe data, check Stripe fees, or rebuild financial records.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["reconcile", "preview", "cash_update", "analytics"],
            description:
              '"reconcile" (default) — full sync from Stripe; ' +
              '"preview" — dry-run showing what would change; ' +
              '"cash_update" — set stripe_fee=0/stripe_net=gross for cash records only; ' +
              '"analytics" — recompute totals from DB without calling Stripe.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_site_content",
      description:
        "Fetch the current public website settings: business name, logo URL, phone number, email, hero text, about text, social links, promo banner, and policy blurbs. " +
        "Use this before updating site content so you know the current values.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_site_content",
      description:
        "Update one or more public website settings that appear on every page. Changes are live immediately after saving. " +
        "Requires admin confirmation. " +
        "Supported keys: business_name, logo_url, phone, whatsapp, email, hero_title, hero_subtitle, about_text, " +
        "instagram_url, facebook_url, tiktok_url, twitter_url, promo_banner_enabled, promo_banner_text, " +
        "policies_cancellation, policies_damage, policies_fuel, policies_age, service_area_notes, pickup_instructions. " +
        "To change the logo: set logo_url to a fully-qualified image URL (https://…). " +
        "To change the phone number on all pages: set phone to the new number (e.g. '+18005551234').",
      parameters: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            description:
              "Key-value pairs of site settings to update. Only include keys that need to change. " +
              "Example: { logo_url: 'https://…/logo.png', phone: '+18005551234', business_name: 'New Name LLC' }",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute the update. Ask the admin to confirm before setting this.",
          },
        },
        required: ["settings"],
      },
    },
  },
];
