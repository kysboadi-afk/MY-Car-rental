// api/_vehicles.js
// Helper module for reading and writing vehicles.json on GitHub.
//
// vehicles.json stores metadata about each vehicle in the fleet:
// purchase date, purchase price, operational status, etc.
//
// Schema:
// {
//   "<vehicleId>": {
//     vehicle_id:     string,
//     vehicle_name:   string,
//     type:           "slingshot" | "economy",
//     vehicle_year:   number | null  (model year, e.g. 2021),
//     purchase_date:  string  (YYYY-MM-DD or ""),
//     purchase_price: number  (dollars),
//     status:         "active" | "maintenance" | "inactive",
//   }
// }

const GITHUB_REPO    = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const VEHICLES_PATH  = "vehicles.json";

const EMPTY_VEHICLES = {
  slingshot:  { vehicle_id: "slingshot",  vehicle_name: "Slingshot R",      type: "slingshot", vehicle_year: null, purchase_date: "", purchase_price: 0, status: "active" },
  slingshot2: { vehicle_id: "slingshot2", vehicle_name: "Slingshot R (2)",  type: "slingshot", vehicle_year: null, purchase_date: "", purchase_price: 0, status: "active" },
  slingshot3: { vehicle_id: "slingshot3", vehicle_name: "Slingshot R (3)",  type: "slingshot", vehicle_year: null, purchase_date: "", purchase_price: 0, status: "active" },
  camry:      { vehicle_id: "camry",      vehicle_name: "Camry 2012",       type: "economy",   vehicle_year: null, purchase_date: "", purchase_price: 0, status: "active" },
  camry2013:  { vehicle_id: "camry2013",  vehicle_name: "Camry 2013 SE",    type: "economy",   vehicle_year: null, purchase_date: "", purchase_price: 0, status: "active" },
};

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Load vehicles.json from the GitHub repo.
 * @returns {Promise<{ data: object, sha: string|null }>}
 */
export async function loadVehicles() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${VEHICLES_PATH}`;
  const resp = await fetch(apiUrl, { headers: ghHeaders() });

  if (!resp.ok) {
    if (resp.status === 404) {
      return { data: { ...EMPTY_VEHICLES }, sha: null };
    }
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GET vehicles.json failed: ${resp.status} ${text}`);
  }

  const file = await resp.json();
  let data;
  try {
    data = JSON.parse(
      Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8")
    );
  } catch {
    data = { ...EMPTY_VEHICLES };
  }

  // Backfill any missing vehicle keys
  for (const [key, defaults] of Object.entries(EMPTY_VEHICLES)) {
    if (!data[key]) data[key] = { ...defaults };
  }

  return { data, sha: file.sha };
}

/**
 * Save vehicles.json back to the GitHub repo.
 * @param {object} data
 * @param {string|null} sha
 * @param {string} message
 */
export async function saveVehicles(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("_vehicles: GITHUB_TOKEN not set — vehicles.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${VEHICLES_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content };
  if (sha) body.sha = sha;

  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT vehicles.json failed: ${resp.status} ${text}`);
  }
}
