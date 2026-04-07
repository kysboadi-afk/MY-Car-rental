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
        "List bookings, optionally filtered by vehicle, status, or customer search. Returns booking details including customer name, dates, status, and amount.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Optional vehicle ID to filter by (e.g. "slingshot", "camry").',
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
          name: {
            type: "string",
            description: 'Display name for the vehicle (e.g. "Honda Civic 2015").',
          },
          type: {
            type: "string",
            description:
              'Vehicle type. Must be "car" for standard rentals. Do NOT use "slingshot" — slingshots are managed separately.',
          },
          price_per_day: {
            type: "number",
            description: "Daily rental rate in USD. Must be greater than 0.",
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
              'Vehicle name or partial name to look up (e.g. "Camry 2013", "slingshot", "camry"). Case-insensitive.',
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
        "Get current odometer readings, maintenance status, and usage trends for all Bouncie-tracked vehicles (cars only; slingshots are excluded). Returns per-vehicle mileage stats and any active maintenance or high-usage alerts.",
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
        "Get expense records for the fleet. Returns total spend, breakdown by category and vehicle, and a list of individual expense entries. Use to answer questions about costs, maintenance spend, or profitability.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Optional vehicle ID to filter expenses (e.g. "camry2013").',
          },
          category: {
            type: "string",
            description: 'Optional category filter: "maintenance" | "insurance" | "repair" | "fuel" | "registration" | "other".',
          },
        },
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
        "Get the blocked/booked date ranges for fleet vehicles. Shows which dates are unavailable for booking, either due to existing reservations or manual blocks.",
      parameters: {
        type: "object",
        properties: {
          vehicleId: {
            type: "string",
            description: 'Optional vehicle ID to filter (e.g. "camry", "slingshot"). Omit to get all vehicles.',
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
            description: 'Vehicle ID to quote (e.g. "camry", "slingshot", or a newly created vehicle ID).',
          },
          pickup: {
            type: "string",
            description: 'Pickup date in YYYY-MM-DD format. Required for non-slingshot vehicles.',
          },
          returnDate: {
            type: "string",
            description: 'Return date in YYYY-MM-DD format. Required for non-slingshot vehicles.',
          },
          durationHours: {
            type: "number",
            description: "Rental duration in hours for Slingshot vehicles: 3, 6, 24, 48, or 72.",
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
            description: 'Vehicle to book. One of: "slingshot", "slingshot2", "slingshot3", "camry", "camry2013".',
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
            description: 'Pickup time, e.g. "10:00 AM" (optional).',
          },
          returnDate: {
            type: "string",
            description: "Rental end date in YYYY-MM-DD format (required).",
          },
          returnTime: {
            type: "string",
            description: 'Return time, e.g. "5:00 PM" (optional).',
          },
          amountPaid: {
            type: "number",
            description: "Total amount paid in dollars (optional, e.g. 350).",
          },
          paymentIntentId: {
            type: "string",
            description: 'Stripe Payment Intent ID from the website payment (e.g. "pi_3ABC..."). Provide this when the customer paid on the website so the booking is linked to the real Stripe transaction. Omit for cash/phone bookings.',
          },
          notes: {
            type: "string",
            description: 'Any notes about the booking, e.g. "Cash payment — collected in person" or "Website payment — emails not received" (optional).',
          },
          confirmed: {
            type: "boolean",
            description: "Must be true to execute after admin confirmation.",
          },
        },
        required: ["vehicleId", "name", "pickupDate", "returnDate"],
      },
    },
  },
];
