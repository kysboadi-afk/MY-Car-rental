import { getSupabaseAdmin } from "./_supabase.js";

const EXACT_ALLOWED_ORIGINS = new Set([
  "https://www.slytrans.com",
  "https://slytrans.com",
  "https://slycarrentals.com",
  "https://www.slycarrentals.com",
  "https://admin.slycarrentals.com",
]);

const FLEET_SIZE_BUCKETS = {
  "1-3 vehicles": 1,
  "4-10 vehicles": 4,
  "11-25 vehicles": 11,
  "26+ vehicles": 26,
};

function normalizeText(value, maxLength = 5000) {
  return String(value || "").trim().slice(0, maxLength);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (EXACT_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    const host = String(url.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
    return host.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

function setCors(origin, res) {
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  setCors(origin, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const {
    name,
    email,
    phone,
    fleetSize,
    priority,
    message,
    honeypot,
    source,
  } = req.body || {};

  if (honeypot) {
    return res.status(400).json({ error: "Submission rejected." });
  }

  const normalizedName = normalizeText(name, 160);
  const normalizedEmail = normalizeText(email, 320).toLowerCase();
  const normalizedPhone = normalizeText(phone, 64);
  const normalizedFleetSize = normalizeText(fleetSize, 64);
  const normalizedPriority = normalizeText(priority, 160);
  const normalizedMessage = normalizeText(message, 4000);
  const normalizedSource = normalizeText(source, 80) || "fleet_control_early_access";

  if (!normalizedName || !normalizedEmail || !normalizedPhone || !normalizedFleetSize || !normalizedPriority || !normalizedMessage) {
    return res.status(400).json({ error: "Missing required fields: name, email, phone, fleetSize, priority, message." });
  }

  if (!looksLikeEmail(normalizedEmail)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const supabaseUrlPresent = Boolean(process.env.SUPABASE_URL);
  const supabaseServiceRoleKeyPresent = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.info("operator-leads Supabase env presence", {
    supabaseUrlPresent,
    supabaseServiceRoleKeyPresent,
    appEnv: process.env.APP_ENV || null,
  });

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(503).json({
      error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your Vercel environment variables.",
    });
  }

  const payload = {
    name: normalizedName,
    email: normalizedEmail,
    phone: normalizedPhone,
    fleet_size: FLEET_SIZE_BUCKETS[normalizedFleetSize] ?? null,
    source: normalizedSource,
    metadata: {
      fleet_size_label: normalizedFleetSize,
      priority: normalizedPriority,
      message: normalizedMessage,
      origin: origin || null,
      user_agent: req.headers["user-agent"] || null,
    },
  };

  const { data, error } = await supabase
    .from("operator_leads")
    .insert(payload)
    .select("id, status, created_at")
    .single();

  if (error) {
    console.error("operator-leads insert failed:", error);
    return res.status(500).json({ error: "Failed to store operator lead." });
  }

  return res.status(200).json({
    success: true,
    leadId: data?.id || null,
    status: data?.status || "new_lead",
    createdAt: data?.created_at || null,
    message: "Thanks — your request was received. We will reach out shortly with the next step.",
  });
}
