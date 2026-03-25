// api/upload-vehicle-image.js
// Upload a vehicle cover image to Supabase Storage and return the public URL.
//
// POST /api/upload-vehicle-image
// Body (JSON): {
//   secret:    string  — admin password
//   vehicleId: string  — vehicle slug (used to name the file)
//   imageData: string  — base64-encoded image (data URI or raw base64)
//   mimeType:  string  — e.g. "image/jpeg", "image/png", "image/webp"
//   fileName:  string  — original file name (optional, used for extension fallback)
// }
//
// Returns: { url: string } — publicly accessible Supabase Storage URL

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const BUCKET           = "vehicle-images";
const MAX_SIZE_BYTES   = 5 * 1024 * 1024; // 5 MB limit
const ALLOWED_MIMETYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  const { secret, vehicleId, imageData, mimeType } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!vehicleId || typeof vehicleId !== "string") {
    return res.status(400).json({ error: "vehicleId is required" });
  }

  if (!imageData || typeof imageData !== "string") {
    return res.status(400).json({ error: "imageData (base64) is required" });
  }

  const mime = (mimeType || "image/jpeg").toLowerCase();
  if (!ALLOWED_MIMETYPES.includes(mime)) {
    return res.status(400).json({ error: `mimeType must be one of: ${ALLOWED_MIMETYPES.join(", ")}` });
  }

  // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
  const base64Data = imageData.replace(/^data:[^;]+;base64,/, "");

  let buffer;
  try {
    buffer = Buffer.from(base64Data, "base64");
  } catch {
    return res.status(400).json({ error: "Invalid base64 image data" });
  }

  if (buffer.length > MAX_SIZE_BYTES) {
    return res.status(400).json({ error: `Image too large. Maximum size is ${MAX_SIZE_BYTES / 1024 / 1024} MB.` });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel." });
  }

  // Build file path: vehicle-images/<vehicleId>-<timestamp>-<random>.<ext>
  const ext = mime.split("/")[1].replace("jpeg", "jpg");
  const filePath = `${vehicleId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

  try {
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, buffer, {
        contentType: mime,
        upsert: true,
      });

    if (uploadErr) {
      console.error("upload-vehicle-image: Supabase upload error:", uploadErr);
      return res.status(500).json({ error: `Upload failed: ${uploadErr.message}` });
    }

    const { data: publicUrlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(filePath);

    const url = publicUrlData?.publicUrl || "";
    return res.status(200).json({ success: true, url });
  } catch (err) {
    console.error("upload-vehicle-image error:", err);
    return res.status(500).json({ error: err.message || "An unexpected error occurred." });
  }
}
