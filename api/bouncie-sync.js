import { getSupabaseAdmin } from "./_supabase.js";

export default async function handler(req, res) {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("vehicles")
      .select("*")
      .limit(1);

    if (error) {
      console.error("SUPABASE ERROR:", error);
      return res.status(500).json({
        error: "Supabase error",
        details: error,
      });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("SUPABASE FATAL:", err);
    return res.status(500).json({
      error: "Supabase fatal",
      message: err.message,
      stack: err.stack,
    });
  }
}
