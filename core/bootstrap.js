require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { Bot, InlineKeyboard, InputFile } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

let ws = null;
try {
  ws = require("ws");
} catch (_) {
  // Optional. Supabase can use its default transport.
}

/* =========================================================
   ENV / CONFIG
========================================================= */

const requiredEnv = [
  "BOT_TOKEN",
  "API_ID",
  "API_HASH",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
];

for (const key of requiredEnv) {
  if (!String(process.env[key] || "").trim()) {
    throw new Error(`ENV wajib belum diisi: ${key}`);
  }
}

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(x => /^\d+$/.test(x))
);

if (!ADMIN_IDS.size) {
  throw new Error(
    "ADMIN_IDS wajib berisi minimal satu Telegram user ID owner."
  );
}

const BOT_VERSION = String(
  process.env.BOT_VERSION ||
    process.env.npm_package_version ||
    "3.0.0"
).trim();

const START_BANNER_FILE_ID = String(
  process.env.START_BANNER_FILE_ID || ""
).trim();

const START_BANNER_URL = String(
  process.env.START_BANNER_URL ||
    "https://cdn.phototourl.com/free/2026-09-17-491f8197-8c02-4344-8754-8314826f54f4.jpg"
).trim();

const supabaseOptions = ws
  ? { realtime: { transport: ws } }
  : {};

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseOptions
);

const bot = new Bot(process.env.BOT_TOKEN);

/* =========================================================
   RUNTIME STATE
========================================================= */

// Account ID -> GramJS TelegramClient
const clients = new Map();

// Admin Telegram ID -> current text/media flow
const flows = new Map();

// Admin Telegram ID -> { type, resolve, reject, timer }
const waiters = new Map();

// Scheduler key -> task object. Key is accountId:formatId.
const schedulerTasks = new Map();

// Account ID -> currently loading GramJS client Promise
const clientLoads = new Map();

// Account ID -> Promise used as a simple async mutex
const accountLocks = new Map();

// Telegram admin ID -> last UI message
const uiMessages = new Map();

// Telegram admin ID -> serialized UI render operation. Prevents concurrent
// /start calls from both observing an empty uiMessages entry and sending
// duplicate dashboards.
const uiLocks = new Map();

// Telegram admin ID -> current interactive GramJS login run. This keeps one
// login state per admin chat and gives the cancel flow a safe cancellation flag.
const loginRuns = new Map();

// In-memory promotion reports for the failure-detail button.
const promotionReports = new Map();
const MAX_PROMOTION_REPORTS = 200;

const ACCOUNT_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 8;
const GROUP_PAGE_SIZE = 8;
const ADMIN_PAGE_SIZE = 12;

/* =========================================================
   BASIC HELPERS
========================================================= */

