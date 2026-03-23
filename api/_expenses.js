// api/_expenses.js
// Helper module for reading and writing expenses.json on GitHub.
//
// expenses.json stores manually-entered expense records per vehicle.
//
// Schema:
// [
//   {
//     expense_id:  string  (crypto random hex),
//     vehicle_id:  string,
//     date:        string  (YYYY-MM-DD),
//     category:    "maintenance" | "insurance" | "repair" | "fuel" | "registration" | "other",
//     amount:      number  (dollars),
//     notes:       string,
//     created_at:  string  (ISO timestamp),
//   }
// ]

const GITHUB_REPO    = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const EXPENSES_PATH  = "expenses.json";

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
 * Load expenses.json from the GitHub repo.
 * @returns {Promise<{ data: Array, sha: string|null }>}
 */
export async function loadExpenses() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${EXPENSES_PATH}`;
  const resp = await fetch(apiUrl, { headers: ghHeaders() });

  if (!resp.ok) {
    if (resp.status === 404) {
      return { data: [], sha: null };
    }
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GET expenses.json failed: ${resp.status} ${text}`);
  }

  const file = await resp.json();
  let data;
  try {
    data = JSON.parse(
      Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8")
    );
    if (!Array.isArray(data)) data = [];
  } catch {
    data = [];
  }

  return { data, sha: file.sha };
}

/**
 * Save expenses.json back to the GitHub repo.
 * @param {Array} data
 * @param {string|null} sha
 * @param {string} message
 */
export async function saveExpenses(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("_expenses: GITHUB_TOKEN not set — expenses.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${EXPENSES_PATH}`;
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
    throw new Error(`GitHub PUT expenses.json failed: ${resp.status} ${text}`);
  }
}
