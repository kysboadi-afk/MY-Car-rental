export function isFeatureEnabled(flagName, defaultValue = true) {
  const raw = process.env[flagName];
  if (raw == null) return !!defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return !!defaultValue;
  return !["0", "false", "off", "no", "disabled"].includes(normalized);
}

export function shouldSendBookingLifecycleSms(source) {
  const mode = String(process.env.SMS_BOOKING_LIFECYCLE_PRIMARY || "all").trim().toLowerCase();
  if (!mode || mode === "all") return true;
  if (mode === "stripe_webhook") return source === "stripe_webhook";
  if (mode === "non_webhook") return source !== "stripe_webhook";
  if (mode === "v2_bookings") return source === "v2_bookings";
  if (mode === "send_reservation_email") return source === "send_reservation_email";
  return true;
}

