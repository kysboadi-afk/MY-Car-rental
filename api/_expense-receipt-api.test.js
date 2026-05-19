import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_SECRET = "test-admin-secret";

let expenseRow;
let uploadError = null;
let removeError = null;
let signedUrl = "https://signed.example.test/receipt";
const VALID_PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const calls = {
  upload: [],
  remove: [],
  signed: [],
};

class FakeExpensesQuery {
  constructor(table) {
    this.table = table;
    this._update = null;
    this._delete = false;
    this._eq = null;
  }

  select() {
    return this;
  }

  update(values) {
    this._update = values;
    return this;
  }

  delete() {
    this._delete = true;
    return this;
  }

  eq(column, value) {
    this._eq = { column, value };
    return this;
  }

  async maybeSingle() {
    return this._execute(true);
  }

  async single() {
    return this._execute(true);
  }

  then(resolve, reject) {
    return this._execute(false).then(resolve, reject);
  }

  async _execute(returnData) {
    if (this.table !== "expenses") return { data: null, error: new Error("Unexpected table") };
    const matches = expenseRow && this._eq?.column === "expense_id" && this._eq.value === expenseRow.expense_id;

    if (this._delete) {
      if (matches) expenseRow = null;
      return { error: null };
    }

    if (this._update) {
      if (matches) {
        expenseRow = { ...expenseRow, ...this._update };
      }
      return returnData ? { data: expenseRow ? { ...expenseRow } : null, error: null } : { error: null };
    }

    return { data: matches ? { ...expenseRow } : null, error: null };
  }
}

const fakeSupabase = {
  from(table) {
    return new FakeExpensesQuery(table);
  },
  storage: {
    from(bucket) {
      assert.equal(bucket, "expense-receipts");
      return {
        async upload(path, buffer, options) {
          calls.upload.push({ path, size: buffer.length, options });
          return uploadError ? { error: uploadError } : { error: null };
        },
        async remove(paths) {
          calls.remove.push(paths);
          return removeError ? { error: removeError } : { error: null };
        },
        async createSignedUrl(path, ttl) {
          calls.signed.push({ path, ttl });
          return { data: { signedUrl }, error: null };
        },
      };
    },
  },
};

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => fakeSupabase,
  },
});

mock.module("./_admin-auth.js", {
  namedExports: {
    isAdminAuthorized: (secret) => secret === "test-admin-secret",
    isAdminConfigured: () => true,
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (err) => err?.message || "error",
    isSchemaError: () => false,
  },
});

mock.module("./_expenses.js", {
  namedExports: {
    loadExpenses: mock.fn(async () => ({ data: [], sha: null })),
    saveExpenses: mock.fn(async () => {}),
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: mock.fn(async () => {}),
  },
});

const { default: uploadExpenseReceipt } = await import("./upload-expense-receipt.js");
const { default: getExpenseReceiptUrl } = await import("./get-expense-receipt-url.js");
const { default: deleteExpenseReceipt } = await import("./delete-expense-receipt.js");
const { default: deleteExpense } = await import("./delete-expense.js");

function makeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeReq(body) {
  return {
    method: "POST",
    headers: { origin: "https://slycarrentals.com" },
    body,
  };
}

beforeEach(() => {
  expenseRow = {
    expense_id: "exp-1",
    vehicle_id: "camry",
    date: "2026-05-14",
    category: "maintenance",
    amount: 120,
    notes: "Oil change",
    receipt_url: null,
    receipt_filename: null,
    receipt_uploaded_at: null,
    receipt_size: null,
    receipt_mime_type: null,
  };
  uploadError = null;
  removeError = null;
  signedUrl = "https://signed.example.test/receipt";
  calls.upload.length = 0;
  calls.remove.length = 0;
  calls.signed.length = 0;
});

test("upload-expense-receipt: uploads file, stores metadata, and returns updated expense", async () => {
  const res = makeRes();
  const fileData = `data:image/png;base64,${VALID_PNG_BUFFER.toString("base64")}`;

  await uploadExpenseReceipt(makeReq({
    secret: "test-admin-secret",
    expenseId: "exp-1",
    fileData,
    mimeType: "image/png",
    fileName: "May receipt.png",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].path, "exp-1/receipt-file");
  assert.equal(res._body.expense.receipt_filename, "May_receipt.png");
  assert.equal(res._body.expense.receipt_mime_type, "image/png");
  assert.equal(res._body.expense.receipt_url, "exp-1/receipt-file");
});

test("upload-expense-receipt: rejects file bytes that do not match mime type", async () => {
  const res = makeRes();

  await uploadExpenseReceipt(makeReq({
    secret: "test-admin-secret",
    expenseId: "exp-1",
    fileData: `data:image/png;base64,${Buffer.from("not-a-real-png").toString("base64")}`,
    mimeType: "image/png",
    fileName: "bad.png",
  }), res);

  assert.equal(res._status, 400);
  assert.match(res._body.error, /do not match MIME type/i);
});

test("upload-expense-receipt: rejects unsupported mime type", async () => {
  const res = makeRes();

  await uploadExpenseReceipt(makeReq({
    secret: "test-admin-secret",
    expenseId: "exp-1",
    fileData: `data:text/plain;base64,${Buffer.from("bad").toString("base64")}`,
    mimeType: "text/plain",
    fileName: "bad.txt",
  }), res);

  assert.equal(res._status, 400);
  assert.match(res._body.error, /mimeType must be one of/i);
});

test("get-expense-receipt-url: returns a signed URL for stored receipts", async () => {
  expenseRow.receipt_url = "exp-1/receipt-file";
  expenseRow.receipt_filename = "repair.pdf";
  expenseRow.receipt_uploaded_at = "2026-05-14T01:23:45.000Z";
  expenseRow.receipt_size = 4096;
  expenseRow.receipt_mime_type = "application/pdf";

  const res = makeRes();
  await getExpenseReceiptUrl(makeReq({ secret: "test-admin-secret", expenseId: "exp-1" }), res);

  assert.equal(res._status, 200);
  assert.equal(calls.signed.length, 1);
  assert.equal(calls.signed[0].path, "exp-1/receipt-file");
  assert.equal(res._body.url, signedUrl);
  assert.equal(res._body.isPdf, true);
  assert.equal(res._body.isImage, false);
});

test("delete-expense-receipt: removes the storage object and clears metadata", async () => {
  expenseRow.receipt_url = "exp-1/receipt-file";
  expenseRow.receipt_filename = "repair.pdf";
  expenseRow.receipt_uploaded_at = "2026-05-14T01:23:45.000Z";
  expenseRow.receipt_size = 4096;
  expenseRow.receipt_mime_type = "application/pdf";

  const res = makeRes();
  await deleteExpenseReceipt(makeReq({ secret: "test-admin-secret", expenseId: "exp-1" }), res);

  assert.equal(res._status, 200);
  assert.deepEqual(calls.remove[0], ["exp-1/receipt-file"]);
  assert.equal(res._body.expense.receipt_url, null);
  assert.equal(res._body.expense.receipt_filename, null);
  assert.equal(res._body.expense.receipt_mime_type, null);
});

test("delete-expense-receipt: fails without clearing metadata when storage delete fails", async () => {
  expenseRow.receipt_url = "exp-1/receipt-file";
  expenseRow.receipt_filename = "repair.pdf";
  expenseRow.receipt_uploaded_at = "2026-05-14T01:23:45.000Z";
  expenseRow.receipt_size = 4096;
  expenseRow.receipt_mime_type = "application/pdf";
  removeError = new Error("cannot delete");

  const res = makeRes();
  await deleteExpenseReceipt(makeReq({ secret: "test-admin-secret", expenseId: "exp-1" }), res);

  assert.equal(res._status, 500);
  assert.equal(expenseRow.receipt_url, "exp-1/receipt-file");
  assert.equal(expenseRow.receipt_filename, "repair.pdf");
});

test("delete-expense: cleans up stored receipts before removing the expense row", async () => {
  expenseRow.receipt_url = "exp-1/receipt-file";
  expenseRow.receipt_filename = "repair.pdf";
  expenseRow.receipt_uploaded_at = "2026-05-14T01:23:45.000Z";
  expenseRow.receipt_size = 4096;
  expenseRow.receipt_mime_type = "application/pdf";

  const res = makeRes();
  await deleteExpense({
    method: "POST",
    headers: { origin: "https://slycarrentals.com" },
    body: { secret: "test-admin-secret", expense_id: "exp-1" },
  }, res);

  assert.equal(res._status, 200);
  assert.deepEqual(calls.remove[0], ["exp-1/receipt-file"]);
  assert.equal(expenseRow, null);
});

test("delete-expense: aborts delete when receipt cleanup fails", async () => {
  expenseRow.receipt_url = "exp-1/receipt-file";
  removeError = new Error("storage down");

  const res = makeRes();
  await deleteExpense({
    method: "POST",
    headers: { origin: "https://slycarrentals.com" },
    body: { secret: "test-admin-secret", expense_id: "exp-1" },
  }, res);

  assert.equal(res._status, 500);
  assert.ok(expenseRow);
  assert.equal(expenseRow.expense_id, "exp-1");
});
