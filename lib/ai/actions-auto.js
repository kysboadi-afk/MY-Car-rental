// lib/ai/actions-auto.js
// Automated action engine.
// Takes computed insights + detected problems and either suggests or executes actions.
//
// AUTO_MODE = false → return suggestions only (safe default)
// AUTO_MODE = true  → execute low-risk actions automatically via the provided executor

/**
 * Evaluate insights and problems, then suggest (or execute) corrective actions.
 *
 * @param {object}   params
 * @param {object}   params.insights   - output from computeInsights()
 * @param {string[]} params.problems   - output from detectProblems()
 * @param {boolean}  params.autoMode   - if true, execute low-risk actions
 * @param {Function} params.execute    - async (toolName, args) => result — only called when autoMode=true
 * @param {string}   params.secret     - admin secret (passed to execute)
 * @returns {Promise<{ suggestions: string[], actions_taken: string[] }>}
 */
export async function runAutoActions({ insights, problems, autoMode = false, execute, secret }) {
  const suggestions    = [];
  const actions_taken  = [];

  // Helper to record or execute
  async function attempt(description, toolName, args) {
    suggestions.push(description);
    if (autoMode && execute) {
      try {
        const result = await execute(toolName, args, secret);
        actions_taken.push(`✅ ${description} — ${JSON.stringify(result).slice(0, 80)}`);
      } catch (err) {
        actions_taken.push(`❌ ${description} — Failed: ${err.message}`);
      }
    }
  }

  // ── Revenue-based suggestions ────────────────────────────────────────────
  const { revenue, vehicles } = insights || {};

  if (revenue?.weeklyChangePct !== null && revenue?.weeklyChangePct <= -30) {
    suggestions.push("Consider running a promotional discount to recover weekly revenue");
  }

  if (revenue?.monthlyChangePct !== null && revenue?.monthlyChangePct <= -20) {
    suggestions.push("Monthly revenue is down — review vehicle availability and pricing");
  }

  // ── Vehicle-based suggestions ─────────────────────────────────────────────
  if (vehicles?.stats) {
    for (const [vehicleId, stats] of Object.entries(vehicles.stats)) {
      // Underperforming vehicle (no recent bookings + active) → suggest price drop
      if (stats.recentBookings30d === 0 && stats.status === "active" && stats.totalBookings > 0) {
        // Only execute price suggestion (no automated pricing changes — too risky)
        suggestions.push(
          `${stats.name} has had no bookings in 30 days — consider lowering its daily rate to attract customers`
        );
      }
    }
  }

  // ── Mileage / maintenance suggestions ────────────────────────────────────
  for (const problem of problems || []) {
    if (problem.includes("oil change due")) {
      suggestions.push(`${problem} — schedule an oil change before the next rental`);
    } else if (problem.includes("brake inspection due")) {
      suggestions.push(`${problem} — brake checks are safety-critical; service ASAP`);
    } else if (problem.includes("tire replacement due") || problem.includes("tires due soon")) {
      suggestions.push(`${problem} — tire wear affects safety and customer ratings`);
    } else if (problem.includes("idle")) {
      suggestions.push(`${problem} — verify the vehicle is available for booking or check the Bouncie device`);
    } else if (problem.includes("averaging") && problem.includes("miles/day")) {
      suggestions.push(`${problem} — high daily mileage accelerates wear; monitor service intervals closely`);
    }
  }

  // ── Problem-based suggestions ────────────────────────────────────────────
  for (const problem of problems || []) {
    if (problem.includes("no new bookings in the last 3 days")) {
      suggestions.push("No recent bookings detected — check that the booking page is live and prices are competitive");
    }
    if (problem.includes("pending payment/approval")) {
      suggestions.push("Review and approve or decline pending bookings promptly to avoid customer drop-off");
    }
  }

  // ── Deduplication ────────────────────────────────────────────────────────
  const unique = (arr) => [...new Set(arr)];

  return {
    suggestions:   unique(suggestions),
    actions_taken: unique(actions_taken),
    autoMode,
  };
}
