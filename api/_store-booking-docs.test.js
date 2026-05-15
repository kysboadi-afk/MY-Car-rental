import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let upsertCalls = [];
let upsertResponses = [];

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from(table) {
        assert.equal(table, "pending_booking_docs");
        return {
          upsert: async (payload) => {
            upsertCalls.push(payload);
            const response = upsertResponses.shift();
            return response || { error: null };
          },
        };
      },
    }),
  },
});

const { default: handler } = await import("./store-booking-docs.js");

function makeReq(body = {}) {
  return {
    method: "POST",
    headers: {
      origin: "https://www.slytrans.com",
      "user-agent": "MobileSafari/17.0",
    },
    body,
  };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(key, value) { this._headers[key] = value; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

beforeEach(() => {
  upsertCalls = [];
  upsertResponses = [];
});

test("store-booking-docs retries transient Supabase failures and normalizes MIME types", async () => {
  upsertResponses = [
    { error: { message: "fetch failed" } },
    { error: null },
  ];

  const res = makeRes();
  await handler(makeReq({
    bookingId: "bk_123",
    idBase64: Buffer.from("front-id").toString("base64"),
    idFileName: "front.HEIC",
    idMimeType: "",
    idBackBase64: Buffer.from("back-id").toString("base64"),
    idBackFileName: "back.jpg",
    idBackMimeType: "image/jpeg",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(upsertCalls.length, 2);
  assert.equal(upsertCalls[0].id_mimetype, "image/heic");
  assert.equal(upsertCalls[0].id_back_mimetype, "image/jpeg");
});

test("store-booking-docs rejects oversized combined uploads", async () => {
  const tooLarge = "A".repeat(19 * 1024 * 1024);
  const res = makeRes();

  await handler(makeReq({
    bookingId: "bk_456",
    idBase64: tooLarge,
    idFileName: "front.jpg",
    idMimeType: "image/jpeg",
    idBackBase64: Buffer.from("back-id").toString("base64"),
    idBackFileName: "back.jpg",
    idBackMimeType: "image/jpeg",
  }), res);

  assert.equal(res._status, 413);
  assert.equal(res._body.code, "DOC_FILE_TOO_LARGE");
});
