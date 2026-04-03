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
        "List bookings, optionally filtered by vehicle or status. Returns booking details including customer name, dates, status, and amount.",
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
              'Vehicle type: "slingshot" | "economy" | "luxury" | "suv" | "truck" | "van" | "other".',
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
        "Update a vehicle's details (name, status, pricing, or Bouncie tracker IMEI). Requires admin confirmation before executing.",
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
              "Fields to update. Allowed keys: vehicle_name, status (active|maintenance|inactive), daily_rate, price_per_day (alias for daily_rate), bouncie_device_id (Bouncie IMEI — set to null to remove).",
            properties: {
              vehicle_name:      { type: "string" },
              status:            { type: "string" },
              daily_rate:        { type: "number" },
              price_per_day:     { type: "number" },
              bouncie_device_id: { type: ["string", "null"] },
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
        "Record that a specific maintenance service (oil change, brake inspection, or tire replacement) was performed on a vehicle at its current odometer reading. Resets the per-service miles counter. Requires admin confirmation before executing.",
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
];
