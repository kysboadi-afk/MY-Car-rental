const VEHICLE_ID_ALIASES = {
  camry: "camry2012",
  camry2012: "camry2012",
  "Camry 2012": "camry2012",
  camry2013: "camry2013",
  "Camry 2013 SE": "camry2013",
};

export function normalizeVehicleId(vehicleId) {
  const raw = String(vehicleId || "").trim();
  if (!raw) return "";
  return VEHICLE_ID_ALIASES[raw] || raw;
}
