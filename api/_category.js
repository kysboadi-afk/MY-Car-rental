import { getSupabaseAdmin } from "./_supabase.js";
import { loadVehicles } from "./_vehicles.js";
import { normalizeVehicleId } from "./_vehicle-id.js";

const VALID_CATEGORIES = new Set(["car", "slingshot"]);

export function normalizeFleetCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_CATEGORIES.has(normalized) ? normalized : null;
}

export async function resolveBookingCategory({ category, vehicleId } = {}) {
  const explicit = normalizeFleetCategory(category);
  if (explicit) return explicit;

  const normalizedVehicleId = normalizeVehicleId(vehicleId) || vehicleId || null;
  if (!normalizedVehicleId) return null;

  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb
        .from("vehicles")
        .select("data")
        .eq("vehicle_id", normalizedVehicleId)
        .maybeSingle();
      if (!error) {
        const resolved = normalizeFleetCategory(data?.data?.category);
        if (resolved) return resolved;
      }
    } catch {
      // fall through to vehicles.json lookup
    }
  }

  if (process.env.GITHUB_TOKEN) {
    try {
      const { data } = await loadVehicles();
      const resolved = normalizeFleetCategory(
        data?.[normalizedVehicleId]?.category
        || Object.values(data || {}).find((v) => v?.vehicle_id === normalizedVehicleId)?.category
      );
      if (resolved) return resolved;
    } catch {
      // ignore lookup failures
    }
  }

  return null;
}
