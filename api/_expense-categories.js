// api/_expense-categories.js
// Shared helper for the two-level expense category system.
//
// Provides:
//   DEFAULT_CATEGORIES  — canonical default list (used when Supabase is unavailable)
//   LEGACY_CATEGORY_MAP — maps old flat text values to new categories
//   loadCategories(sb)  — loads from Supabase or returns defaults
//   enrichExpenseCategory(expense) — attaches category_name / category_group from old text

// ── Default categories (mirrors migration 0126) ───────────────────────────────
export const DEFAULT_CATEGORIES = [
  // Ownership
  { name: "Loan / Lease",           group_name: "Ownership",   is_default: true, is_active: true  },
  { name: "Insurance",              group_name: "Ownership",   is_default: true, is_active: true  },
  { name: "Registration",           group_name: "Ownership",   is_default: true, is_active: true  },
  { name: "Taxes",                  group_name: "Ownership",   is_default: true, is_active: true  },
  // Usage
  { name: "Fuel",                   group_name: "Usage",       is_default: true, is_active: true  },
  { name: "EV Charging",            group_name: "Usage",       is_default: true, is_active: true  },
  { name: "Parking",                group_name: "Usage",       is_default: true, is_active: true  },
  { name: "Tolls",                  group_name: "Usage",       is_default: true, is_active: true  },
  // Maintenance
  { name: "Oil Change",             group_name: "Maintenance", is_default: true, is_active: true  },
  { name: "Tires",                  group_name: "Maintenance", is_default: true, is_active: true  },
  { name: "Brakes",                 group_name: "Maintenance", is_default: true, is_active: true  },
  { name: "Fluids",                 group_name: "Maintenance", is_default: true, is_active: true  },
  { name: "Filters",                group_name: "Maintenance", is_default: true, is_active: true  },
  { name: "Battery",                group_name: "Maintenance", is_default: true, is_active: true  },
  { name: "Inspection / Emissions", group_name: "Maintenance", is_default: true, is_active: true  },
  // Repairs
  { name: "Repair (General)",       group_name: "Repairs",     is_default: true, is_active: true  },
  { name: "Parts",                  group_name: "Repairs",     is_default: true, is_active: true  },
  { name: "Labor",                  group_name: "Repairs",     is_default: true, is_active: true  },
  { name: "Diagnostics",            group_name: "Repairs",     is_default: true, is_active: true  },
  // Cleaning
  { name: "Car Wash",               group_name: "Cleaning",    is_default: true, is_active: true  },
  { name: "Detailing",              group_name: "Cleaning",    is_default: true, is_active: true  },
  // Extras
  { name: "Accessories",            group_name: "Extras",      is_default: true, is_active: true  },
  { name: "Mods / Upgrades",        group_name: "Extras",      is_default: true, is_active: true  },
  { name: "Subscriptions",          group_name: "Extras",      is_default: true, is_active: true  },
  // Incidents
  { name: "Fines / Tickets",        group_name: "Incidents",   is_default: true, is_active: true  },
  { name: "Towing",                 group_name: "Incidents",   is_default: true, is_active: true  },
  { name: "Accident / Damage",      group_name: "Incidents",   is_default: true, is_active: true  },
  { name: "Insurance Deductible",   group_name: "Incidents",   is_default: true, is_active: true  },
  // Advanced (hidden by default)
  { name: "Depreciation",           group_name: "Advanced",    is_default: true, is_active: false },
  { name: "Mileage",                group_name: "Advanced",    is_default: true, is_active: false },
  { name: "Rental / Replacement",   group_name: "Advanced",    is_default: true, is_active: false },
  // Legacy fallback (hidden)
  { name: "Other",                  group_name: "Other",       is_default: true, is_active: false },
];

// Maps old flat category text → { name, group_name } in the new hierarchy
export const LEGACY_CATEGORY_MAP = {
  maintenance:  { name: "Oil Change",       group_name: "Maintenance" },
  insurance:    { name: "Insurance",        group_name: "Ownership"   },
  repair:       { name: "Repair (General)", group_name: "Repairs"     },
  fuel:         { name: "Fuel",             group_name: "Usage"       },
  registration: { name: "Registration",     group_name: "Ownership"   },
  other:        { name: "Other",            group_name: "Other"       },
};

/**
 * Load all expense categories from Supabase (all rows, including inactive).
 * Falls back to DEFAULT_CATEGORIES when Supabase is unavailable.
 *
 * @param {object|null} sb  Supabase admin client (may be null)
 * @param {object}      [opts]
 * @param {boolean}     [opts.activeOnly=false]  When true, filter is_active=true only
 * @returns {Promise<Array>}
 */
export async function loadCategories(sb, { activeOnly = false } = {}) {
  if (sb) {
    let q = sb.from("expense_categories").select("*").order("group_name").order("name");
    if (activeOnly) q = q.eq("is_active", true);
    const { data, error } = await q;
    if (!error && data) return data;
    // Fall through on error (table may not yet exist after migration)
    console.warn("_expense-categories: Supabase query failed, using defaults:", error?.message);
  }
  const list = DEFAULT_CATEGORIES.map((c, i) => ({
    id:         `default-${i}`,
    name:       c.name,
    group_name: c.group_name,
    is_default: c.is_default,
    is_active:  c.is_active,
    created_at: null,
  }));
  return activeOnly ? list.filter((c) => c.is_active) : list;
}

/**
 * Given an expense object, return category_name and category_group derived
 * from its category_id join or legacy category text.
 *
 * @param {object} expense  Expense row (may have expense_categories relation or legacy category field)
 * @returns {{ category_name: string, category_group: string }}
 */
export function enrichExpenseCategory(expense) {
  // Supabase JOIN result
  if (expense.expense_categories) {
    return {
      category_name:  expense.expense_categories.name        || expense.category || "",
      category_group: expense.expense_categories.group_name  || "",
    };
  }
  // Legacy text fallback
  const legacy = LEGACY_CATEGORY_MAP[expense.category] || null;
  return {
    category_name:  legacy?.name       || (expense.category ? expense.category.charAt(0).toUpperCase() + expense.category.slice(1) : ""),
    category_group: legacy?.group_name || "",
  };
}
