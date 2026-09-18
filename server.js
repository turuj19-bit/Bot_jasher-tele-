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

// Account ID -> scheduler task object
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

const ACCOUNT_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 8;
const GROUP_PAGE_SIZE = 8;
const ADMIN_PAGE_SIZE = 12;

/* =========================================================
   BASIC HELPERS
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeButtonText(value, max = 30) {
  const text = String(value ?? "Tanpa Nama")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

  return Array.from(text)
    .filter(ch => {
      const cp = ch.codePointAt(0);
      return cp !== undefined && cp >= 0x20;
    })
    .slice(0, max)
    .join("");
}

function safeErrorMessage(error, max = 500) {
  const raw = String(error?.message || error || "Kesalahan tidak diketahui");
  return raw.replace(/\s+/g, " ").slice(0, max);
}

function isOwnerId(telegramUserId) {
  return ADMIN_IDS.has(String(telegramUserId));
}

function formatInterval(minutes) {
  const m = Number(minutes || 0);
  if (!m) return "-";
  if (m % 1440 === 0) return `${m / 1440} hari`;
  if (m % 60 === 0) return `${m / 60} jam`;
  return `${m} menit`;
}

function formatDuration(hours) {
  const h = Number(hours || 0);
  if (!h) return "-";
  if (h % 24 === 0) return `${h / 24} hari`;
  return `${h} jam`;
}

function parseMinutes(value) {
  const m = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^([1-9]\d*(?:\.\d+)?)\s*(menit|jam|hari|m|h|d)$/);

  if (!m) return null;

  const unit = {
    menit: 1,
    m: 1,
    jam: 60,
    h: 60,
    hari: 1440,
    d: 1440
  }[m[2]];

  const minutes = Math.round(Number(m[1]) * unit);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return minutes;
}

function parseHours(value) {
  const m = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^([1-9]\d*(?:\.\d+)?)\s*(jam|hari|h|d)$/);

  if (!m) return null;

  const unit = {
    jam: 1,
    h: 1,
    hari: 24,
    d: 24
  }[m[2]];

  const hours = Math.round(Number(m[1]) * unit);
  if (!Number.isFinite(hours) || hours < 1) return null;
  return hours;
}

function parsePositiveTelegramId(value) {
  const raw = String(value || "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("id-ID");
  } catch (_) {
    return String(value);
  }
}

function accountStatusIcon(account) {
  if (account?.status === "connected") return "🟢";
  if (account?.status === "error") return "🟠";
  return "⚪";
}

function promotionStatusIcon(settings) {
  if (settings?.active) return "▶️";
  return "⏹";
}

function ensurePage(value, maxPage = 0) {
  const page = Math.max(0, Number.parseInt(value, 10) || 0);
  return Math.min(page, Math.max(0, maxPage));
}

function buildPageButtons(prefix, page, hasPrev, hasNext, extraButtons = []) {
  const kb = new InlineKeyboard();

  if (hasPrev) kb.text("◀️", `${prefix}:${page - 1}`);
  if (hasNext) kb.text("▶️", `${prefix}:${page + 1}`);
  if (hasPrev || hasNext) kb.row();

  for (const row of extraButtons) {
    if (!row?.length) continue;
    for (const item of row) {
      kb.text(item.text, item.callback);
    }
    kb.row();
  }

  return kb;
}

/* =========================================================
   SESSION ENCRYPTION
   New sessions are always encrypted at application level.
   Existing deployments can start without a new ENV because a
   stable key is derived from existing secrets, but a dedicated
   SESSION_ENCRYPTION_KEY is strongly recommended.
========================================================= */

function encryptionKey() {
  const explicit = String(process.env.SESSION_ENCRYPTION_KEY || "").trim();

  if (explicit) {
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) {
      return Buffer.from(explicit, "hex");
    }

    try {
      const decoded = Buffer.from(explicit, "base64");
      if (decoded.length === 32) return decoded;
    } catch (_) {}

    throw new Error(
      "SESSION_ENCRYPTION_KEY harus berupa 64 karakter hex atau base64 32-byte."
    );
  }

  // Compatibility fallback: avoids breaking old VPS deployments.
  return crypto
    .createHash("sha256")
    .update(
      `${process.env.SUPABASE_SERVICE_ROLE_KEY}|${process.env.API_HASH}|telegram-auto-bot-session-v3`
    )
    .digest();
}

const SESSION_KEY = encryptionKey();

function encryptSession(plainText) {
  if (!plainText) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SESSION_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

function decryptSession(encoded) {
  const raw = String(encoded || "");
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Format session terenkripsi tidak valid.");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");

  const decipher = crypto.createDecipheriv("aes-256-gcm", SESSION_KEY, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}

/* =========================================================
   ADMIN AUTHORIZATION
========================================================= */

async function getAdminByTelegramId(telegramUserId) {
  const { data, error } = await sb
    .from("admins")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .eq("active", true)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function ensureBootstrapOwners() {
  const rows = [];

  for (const id of ADMIN_IDS) {
    rows.push({
      telegram_user_id: Number(id),
      role: "OWNER",
      active: true
    });
  }

  if (!rows.length) return;

  const { error } = await sb
    .from("admins")
    .upsert(rows, { onConflict: "telegram_user_id" });

  if (error) throw error;
}

async function requireAdmin(ctx, options = {}) {
  const telegramUserId = ctx.from?.id;
  const adminRow = telegramUserId
    ? await getAdminByTelegramId(telegramUserId)
    : null;

  if (!adminRow) {
    await ctx.answerCallbackQuery("Akses ditolak.", {
      show_alert: true
    }).catch(() => {});
    return null;
  }

  if (options.ownerOnly && adminRow.role !== "OWNER") {
    await ctx.answerCallbackQuery(
      "Fungsi ini hanya untuk ADMIN UTAMA.",
      { show_alert: true }
    ).catch(() => {});
    return null;
  }

  // Keep optional profile data fresh without using it for authorization.
  const profileUpdate = {
    username: ctx.from?.username || null,
    first_name: ctx.from?.first_name || null
  };

  sb.from("admins")
    .update(profileUpdate)
    .eq("id", adminRow.id)
    .then(result => {
      if (result.error) console.error("ADMIN PROFILE UPDATE:", result.error);
    })
    .catch(error => console.error("ADMIN PROFILE UPDATE:", error));

  return adminRow;
}

/* =========================================================
   UI HELPERS
========================================================= */

async function saveUiMessage(userId, msg, isMedia = false) {
  if (!msg) return;
  uiMessages.set(String(userId), {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    isMedia
  });
}

async function deleteSavedUi(userId) {
  const saved = uiMessages.get(String(userId));
  if (!saved) return;

  try {
    await bot.api.deleteMessage(saved.chatId, saved.messageId);
  } catch (_) {}

  uiMessages.delete(String(userId));
}

async function withUiLock(userId, fn) {
  const key = String(userId);
  const previous = uiLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  uiLocks.set(key, current);

  try {
    return await current;
  } finally {
    if (uiLocks.get(key) === current) {
      uiLocks.delete(key);
    }
  }
}

async function renderUi(userId, text, keyboard, options = {}) {
  const key = String(userId);
  const saved = uiMessages.get(key);

  const extra = {
    reply_markup: keyboard
  };

  if (options.parse_mode) extra.parse_mode = options.parse_mode;

  if (saved) {
    try {
      if (saved.isMedia) {
        await bot.api.editMessageCaption(
          saved.chatId,
          saved.messageId,
          {
            caption: text,
            ...extra
          }
        );
        return;
      }

      await bot.api.editMessageText(
        saved.chatId,
        saved.messageId,
        text,
        extra
      );
      return;
    } catch (e) {
      if (/message is not modified/i.test(String(e.message || e))) {
        return;
      }

      await deleteSavedUi(userId);
    }
  }

  const msg = await bot.api.sendMessage(userId, text, extra);
  await saveUiMessage(userId, msg, false);
}

async function replaceUi(ctx, text, keyboard, options = {}) {
  return renderUi(ctx.from.id, text, keyboard, options);
}

async function renderStart(ctx, text, keyboard) {
  const userId = ctx.from.id;

  return withUiLock(userId, async () => {
    const saved = uiMessages.get(String(userId));

    // Reuse the existing dashboard UI instead of stacking new messages.
    if (saved) {
      return renderUi(userId, text, keyboard, { parse_mode: "HTML" });
    }

    if (START_BANNER_FILE_ID) {
      try {
        const msg = await ctx.replyWithPhoto(START_BANNER_FILE_ID, {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard
        });
        await saveUiMessage(userId, msg, true);
        return msg;
      } catch (e) {
        console.error("START BANNER FILE_ID:", safeErrorMessage(e));
      }
    }

    if (START_BANNER_URL && /^https?:\/\//i.test(START_BANNER_URL)) {
      try {
        const response = await fetch(START_BANNER_URL, {
          redirect: "follow",
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const contentType = String(
          response.headers.get("content-type") || ""
        ).toLowerCase();

        if (!contentType.startsWith("image/")) {
          throw new Error(
            `URL bukan file gambar (content-type: ${contentType || "unknown"})`
          );
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error("File banner kosong.");
        if (buffer.length > 10 * 1024 * 1024) {
          throw new Error("File banner terlalu besar.");
        }

        const msg = await ctx.replyWithPhoto(
          new InputFile(buffer, "start-banner.jpg"),
          {
            caption: text,
            parse_mode: "HTML",
            reply_markup: keyboard
          }
        );

        await saveUiMessage(userId, msg, true);
        return msg;
      } catch (e) {
        console.error("START BANNER URL:", safeErrorMessage(e));
      }
    }

    return renderUi(userId, text, keyboard, { parse_mode: "HTML" });
  });
}

function dashboardText(ctx, stats, extra = "") {
  const first = String(ctx.from?.first_name || "").trim();
  const last = String(ctx.from?.last_name || "").trim();
  const name = [first, last].filter(Boolean).join(" ") || "Admin";
  const username = ctx.from?.username ? `@${ctx.from.username}` : "-";

  return [
    "╭─ 🛡️ <b>ADMIN CONTROL CENTER</b>",
    "│",
    `│ 👤 <b>${escapeHtml(name)}</b>`,
    `│ 🆔 Telegram ID  <code>${escapeHtml(ctx.from.id)}</code>`,
    `│ 🔗 Username     <code>${escapeHtml(username)}</code>`,
    `│ 🤖 Bot          <code>v${escapeHtml(BOT_VERSION)}</code>`,
    "╰────────────────────────────",
    "",
    `<i>${escapeHtml(extra || "Profil admin ditampilkan sesuai nama akun Telegram. Silakan pilih menu di bawah untuk mengatur akun Telegram, format promosi, target grup, dan pengaturan lainnya.")}</i>`,
    "",
    "📊 <b>STATUS SISTEM</b>",
    `👥 Admin aktif   · <b>${stats.admins}</b>`,
    `📱 Akun Telegram · <b>${stats.accounts}</b>`,
    `🟢 Terhubung     · <b>${stats.connected}</b>`,
    `▶️ Promosi jalan  · <b>${stats.running}</b>`,
    `👥 Target grup   · <b>${stats.groups}</b>`,
    "",
    "⌄ <b>MENU UTAMA</b>"
  ].join("\n");
}

async function getDashboardStats() {
  const [admins, accounts, connected, running, groups] = await Promise.all([
    sb.from("admins").select("*", { count: "exact", head: true }).eq("active", true),
    sb.from("telegram_accounts").select("*", { count: "exact", head: true }),
    sb.from("telegram_accounts").select("*", { count: "exact", head: true }).eq("status", "connected"),
    sb.from("account_settings").select("*", { count: "exact", head: true }).eq("active", true),
    sb.from("account_groups").select("*", { count: "exact", head: true }).eq("enabled", true).eq("can_send", true)
  ]);

  for (const r of [admins, accounts, connected, running, groups]) {
    if (r.error) throw r.error;
  }

  return {
    admins: Number(admins.count || 0),
    accounts: Number(accounts.count || 0),
    connected: Number(connected.count || 0),
    running: Number(running.count || 0),
    groups: Number(groups.count || 0)
  };
}

function ownerDashboardMenu() {
  return new InlineKeyboard()
    .text("📱 Akun Telegram", "accounts:list:0")
    .row()
    .text("👥 Admin", "admin:list:0")
    .text("📊 Refresh", "menu:dashboard")
    .row()
    .text("➕ Tambah Akun", "account:add");
}

function adminDashboardMenu() {
  return new InlineKeyboard()
    .text("📱 Akun Telegram", "accounts:list:0")
    .row()
    .text("➕ Tambah Akun", "account:add")
    .text("📊 Refresh", "menu:dashboard");
}

function backDashboardKeyboard() {
  return new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard");
}

function accountListKeyboard(accounts, page, hasNext) {
  const kb = new InlineKeyboard();

  for (const account of accounts) {
    kb
      .text(
        `${accountStatusIcon(account)} ${safeButtonText(account.label, 28)}`,
        `account:open:${account.id}`
      )
      .row();
  }

  if (page > 0) kb.text("◀️", `accounts:list:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `accounts:list:${page + 1}`);
  kb.row();
  kb.text("➕ Tambah Akun", "account:add");

  return kb;
}

function accountMenu(account, settings) {
  const kb = new InlineKeyboard();

  kb
    .text("📊 Status", `account:status:${account.id}`)
    .text("⚙️ Setting", `account:settings:${account.id}`)
    .row();

  if (account.status === "connected") {
    kb.text("🔌 Putuskan", `account:disconnect:${account.id}`);
  } else {
    kb.text("🔗 Connect", `account:connect:${account.id}`);
  }

  kb
    .text("👥 Grup", `group:list:${account.id}:0`)
    .row()
    .text("📝 Format", `promo:format:${account.id}`)
    .text("⏱ Jeda", `promo:delay:${account.id}`)
    .row()
    .text("📅 Durasi", `promo:duration:${account.id}`)
    .text(
      settings?.active ? "⏹ Stop" : "▶️ Start",
      settings?.active
        ? `promo:stop:${account.id}`
        : `promo:start:${account.id}`
    )
    .row()
    .text("📋 Riwayat", `history:list:${account.id}:0`)
    .text("✏️ Label", `account:label:${account.id}`)
    .row()
    .text("🗑 Hapus", `account:remove:${account.id}`)
    .row()
    .text("◀️ Daftar Akun", "accounts:list:0");

  return kb;
}

function settingsMenu(accountId) {
  return new InlineKeyboard()
    .text("✏️ Ubah Label", `account:label:${accountId}`)
    .row()
    .text("📝 Format Promosi", `promo:format:${accountId}`)
    .row()
    .text("⏱ Ubah Jeda", `promo:delay:${accountId}`)
    .text("📅 Ubah Durasi", `promo:duration:${accountId}`)
    .row()
    .text("◀️ Account", `account:open:${accountId}`)
    .text("🏠", "menu:dashboard");
}

function groupListKeyboard(rows, accountId, page, hasNext) {
  const kb = new InlineKeyboard();

  for (const group of rows) {
    const label = `${group.enabled ? "✅" : "⬜"} ${safeButtonText(group.title, 24)}`;
    kb
      .text(label, `group:toggle:${group.id}`)
      .text("🗑", `group:remove:${group.id}`)
      .row();
  }

  if (page > 0) kb.text("◀️", `group:list:${accountId}:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `group:list:${accountId}:${page + 1}`);
  kb.row();
  kb.text("🔄 Scan / Refresh", `group:refresh:${accountId}`);
  kb.text("◀️ Account", `account:open:${accountId}`);

  return kb;
}

function historyKeyboard(accountId, page, hasNext) {
  const kb = new InlineKeyboard();

  if (page > 0) kb.text("◀️", `history:list:${accountId}:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `history:list:${accountId}:${page + 1}`);
  kb.row();
  kb.text("◀️ Account", `account:open:${accountId}`);

  return kb;
}

function adminListKeyboard(admins, page, hasNext) {
  const kb = new InlineKeyboard();

  for (const a of admins) {
    const role = a.role === "OWNER" ? "👑" : "👨‍💼";
    const label = a.telegram_user_id
      ? `${role} ${a.telegram_user_id}`
      : `${role} -`;

    kb.text(
      safeButtonText(label, 32),
      `admin:view:${a.id}`
    ).row();
  }

  if (page > 0) kb.text("◀️", `admin:list:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `admin:list:${page + 1}`);
  kb.row();
  kb.text("➕ Tambah Admin", "admin:add");
  kb.text("❌ Hapus Admin", "admin:delete");

  return kb;
}

function cancelKeyboard(ownerOnly = false) {
  return new InlineKeyboard().text(
    "❌ Batal",
    ownerOnly ? "admin:cancel" : "flow:cancel"
  );
}

/* =========================================================
   ACCOUNT / SETTINGS DATABASE HELPERS
========================================================= */

async function getAccount(accountId) {
  const { data, error } = await sb
    .from("telegram_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getAccountSettings(accountId) {
  const { data, error } = await sb
    .from("account_settings")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function ensureAccountSettings(accountId) {
  const existing = await getAccountSettings(accountId);
  if (existing) return existing;

  const { data, error } = await sb
    .from("account_settings")
    .insert({ account_id: accountId })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function getAccountBundle(accountId) {
  const [account, settings] = await Promise.all([
    getAccount(accountId),
    getAccountSettings(accountId)
  ]);

  return { account, settings: settings || null };
}

async function accountHasAccess(accountId) {
  const account = await getAccount(accountId);
  return account;
}

async function createAccountShell(label, adminId, phone = null) {
  const { data, error } = await sb
    .from("telegram_accounts")
    .insert({
      label: String(label || "Telegram Account").trim(),
      status: "disconnected",
      created_by: adminId,
      phone: phone || null,
      session_string: null
    })
    .select("*")
    .single();

  if (error) throw error;

  await ensureAccountSettings(data.id);
  return data;
}

async function listAccounts(page = 0) {
  const offset = page * ACCOUNT_PAGE_SIZE;

  const [{ data, error }, { count, error: countError }] = await Promise.all([
    sb
      .from("telegram_accounts")
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + ACCOUNT_PAGE_SIZE),
    sb.from("telegram_accounts").select("*", { count: "exact", head: true })
  ]);

  if (error) throw error;
  if (countError) throw countError;

  const rows = data || [];
  const visible = rows.slice(0, ACCOUNT_PAGE_SIZE);

  return {
    rows: visible,
    total: Number(count || 0),
    page,
    hasNext: offset + ACCOUNT_PAGE_SIZE < Number(count || 0)
  };
}

async function listAdmins(page = 0) {
  const offset = page * ADMIN_PAGE_SIZE;

  const [{ data, error }, { count, error: countError }] = await Promise.all([
    sb
      .from("admins")
      .select("*")
      .eq("active", true)
      .order("role", { ascending: true })
      .order("created_at", { ascending: true })
      .range(offset, offset + ADMIN_PAGE_SIZE),
    sb.from("admins").select("*", { count: "exact", head: true }).eq("active", true)
  ]);

  if (error) throw error;
  if (countError) throw countError;

  return {
    rows: (data || []).slice(0, ADMIN_PAGE_SIZE),
    total: Number(count || 0),
    hasNext: offset + ADMIN_PAGE_SIZE < Number(count || 0)
  };
}

async function stopScheduler(accountId) {
  const key = String(accountId);
  const task = schedulerTasks.get(key);
  if (!task) return;

  task.running = false;
  if (task.timeout) clearTimeout(task.timeout);
  schedulerTasks.delete(key);
}

async function withAccountLock(accountId, fn) {
  const key = String(accountId);
  const previous = accountLocks.get(key) || Promise.resolve();
  let release;

  const current = new Promise(resolve => {
    release = resolve;
  });

  accountLocks.set(key, current);

  await previous.catch(() => {});

  try {
    return await fn();
  } finally {
    release();
    if (accountLocks.get(key) === current) {
      accountLocks.delete(key);
    }
  }
}

/* =========================================================
   TELEGRAM USER CLIENT
========================================================= */

async function createTelegramClient(sessionString = "") {
  return new TelegramClient(
    new StringSession(sessionString || ""),
    Number(process.env.API_ID),
    process.env.API_HASH,
    {
      connectionRetries: 10,
      retryDelay: 2000,
      useWSS: false
    }
  );
}

async function markAccountStatus(accountId, status) {
  const { error } = await sb
    .from("telegram_accounts")
    .update({ status })
    .eq("id", accountId);

  if (error) console.error("ACCOUNT STATUS UPDATE:", error);
}

async function clientFor(accountOrId) {
  const accountId = String(
    typeof accountOrId === "object" ? accountOrId?.id : accountOrId
  );

  if (!accountId || accountId === "undefined") return null;

  const existing = clients.get(accountId);

  if (existing) {
    try {
      if (!existing.connected) await existing.connect();
      if (await existing.checkAuthorization()) return existing;
    } catch (_) {}
  }

  if (clientLoads.has(accountId)) {
    return clientLoads.get(accountId);
  }

  const loadPromise = (async () => {
    const account = await getAccount(accountId);
    if (!account?.session_string) return null;

    let sessionString;
    try {
      sessionString = decryptSession(account.session_string);
    } catch (e) {
      console.error(`ACCOUNT ${accountId} SESSION DECRYPT:`, safeErrorMessage(e));
      await markAccountStatus(accountId, "error");
      return null;
    }

    if (!sessionString) return null;

    const client = await createTelegramClient(sessionString);

    try {
      await client.connect();

      if (!(await client.checkAuthorization())) {
        await markAccountStatus(accountId, "error");
        try { await client.disconnect(); } catch (_) {}
        return null;
      }

      clients.set(accountId, client);
      await markAccountStatus(accountId, "connected");
      return client;
    } catch (e) {
      try { await client.disconnect(); } catch (_) {}
      console.warn(`ACCOUNT ${accountId} RECONNECT:`, safeErrorMessage(e, 250));
      return null;
    }
  })();

  clientLoads.set(accountId, loadPromise);

  try {
    return await loadPromise;
  } finally {
    if (clientLoads.get(accountId) === loadPromise) {
      clientLoads.delete(accountId);
    }
  }
}

async function closeClient(accountId) {
  const key = String(accountId);
  const client = clients.get(key);
  if (!client) return;

  try {
    await client.disconnect();
  } catch (_) {}

  clients.delete(key);
}

async function deleteAccountAfterLoginFailure(accountId) {
  const key = String(accountId);

  await stopScheduler(key);
  await closeClient(key);

  // Remove child rows first so the account FK can be deleted cleanly.
  const groupsResult = await sb
    .from("account_groups")
    .delete()
    .eq("account_id", key);
  if (groupsResult.error) throw groupsResult.error;

  const settingsResult = await sb
    .from("account_settings")
    .delete()
    .eq("account_id", key);
  if (settingsResult.error) throw settingsResult.error;

  const accountResult = await sb
    .from("telegram_accounts")
    .delete()
    .eq("id", key);
  if (accountResult.error) throw accountResult.error;
}

async function getMeFromClient(client) {
  const me = await client.getMe();
  if (!me?.id) throw new Error("Telegram tidak mengembalikan identitas akun.");

  return {
    telegramUserId: Number(me.id),
    username: me.username || null,
    firstName: me.firstName || null,
    lastName: me.lastName || null
  };
}

/* =========================================================
   GROUP MANAGEMENT
========================================================= */

function channelCanSend(entity, client) {
  return (async () => {
    const isGroup = Boolean(entity?.className === "Chat");
    const isChannel = Boolean(entity?.className === "Channel");

    if (!isGroup && !isChannel) return false;

    let canSend = true;

    if (isChannel && entity.broadcast) {
      canSend = false;

      try {
        const me = await client.getInputEntity("me");
        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: entity,
            userId: me
          })
        );

        const p = participant?.participant;
        if (
          p?.className === "ChannelParticipantCreator" ||
          p?.className === "ChannelParticipantAdmin"
        ) {
          canSend = true;
        }
      } catch (_) {
        canSend = false;
      }
    }

    if (isGroup || (isChannel && !entity.broadcast)) {
      canSend = true;

      if (isChannel) {
        try {
          const me = await client.getInputEntity("me");
          const participant = await client.invoke(
            new Api.channels.GetParticipant({
              channel: entity,
              userId: me
            })
          );

          const p = participant?.participant;
          if (
            p?.className === "ChannelParticipantBanned" &&
            p.bannedRights?.sendMessages === true
          ) {
            canSend = false;
          }
        } catch (_) {
          // Keep the old behavior: unknown permission is not enough to discard the group.
          canSend = true;
        }
      }
    }

    return canSend;
  })();
}

async function refreshGroups(accountId) {
  const client = await clientFor(accountId);

  if (!client) {
    throw new Error("Akun Telegram belum terhubung. Connect akun terlebih dahulu.");
  }

  const dialogs = await client.getDialogs({ limit: 500 });
  const rows = [];

  for (const dialog of dialogs) {
    const entity = dialog?.entity;
    if (!entity) continue;

    const isGroup = Boolean(dialog.isGroup);
    const isChannel = Boolean(dialog.isChannel);
    if (!isGroup && !isChannel) continue;

    const canSend = await channelCanSend(entity, client);
    const telegramGroupId = String(entity.id?.value ?? entity.id ?? "");

    if (!telegramGroupId) continue;

    rows.push({
      account_id: accountId,
      telegram_group_id: telegramGroupId,
      title: dialog.title || entity.title || "Tanpa Nama",
      can_send: canSend
    });
  }

  if (rows.length) {
    const { error } = await sb
      .from("account_groups")
      .upsert(rows, { onConflict: "account_id,telegram_group_id" });

    if (error) throw error;
  }

  return rows;
}

async function listGroups(accountId, page = 0) {
  const offset = page * GROUP_PAGE_SIZE;

  const [{ data, error }, { count, error: countError }] = await Promise.all([
    sb
      .from("account_groups")
      .select("*")
      .eq("account_id", accountId)
      .order("title", { ascending: true })
      .range(offset, offset + GROUP_PAGE_SIZE),
    sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
  ]);

  if (error) throw error;
  if (countError) throw countError;

  return {
    rows: (data || []).slice(0, GROUP_PAGE_SIZE),
    total: Number(count || 0),
    hasNext: offset + GROUP_PAGE_SIZE < Number(count || 0)
  };
}

/* =========================================================
   PROMOTION FORMAT / MEDIA
========================================================= */

async function downloadBotPhoto(fileId) {
  const file = await bot.api.getFile(fileId);
  if (!file?.file_path) {
    throw new Error("Telegram tidak mengembalikan file_path.");
  }

  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Gagal download foto Telegram: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("File foto Telegram kosong.");
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("File foto terlalu besar.");
  }

  buffer.name = "photo.jpg";
  return buffer;
}

function settingsFormatText(settings) {
  if (!settings) return "Belum ada format.";

  if (settings.media_type === "photo") {
    return `🖼️ Foto${settings.caption ? " + caption" : " tanpa caption"}`;
  }

  return `📝 Teks${settings.message ? "" : " (kosong)"}`;
}

function settingsSummary(account, settings) {
  return [
    `📱 <b>${escapeHtml(account.label)}</b>`,
    `🆔 ID internal: <code>${escapeHtml(account.id)}</code>`,
    `🔗 Telegram ID: <code>${escapeHtml(account.telegram_user_id || "belum")}</code>`,
    `📌 Koneksi: <b>${escapeHtml(account.status || "-")}</b>`,
    `▶️ Promosi: <b>${settings?.active ? "RUNNING" : "STOPPED"}</b>`,
    `📝 Format: <b>${escapeHtml(settingsFormatText(settings))}</b>`,
    `⏱ Jeda: <b>${escapeHtml(formatInterval(settings?.interval_minutes))}</b>`,
    `📅 Durasi: <b>${escapeHtml(formatDuration(settings?.duration_hours))}</b>`,
    settings?.expires_at
      ? `⌛ Berakhir: <b>${escapeHtml(formatDate(settings.expires_at))}</b>`
      : null,
    account.phone
      ? `☎️ Nomor: <code>${escapeHtml(account.phone)}</code>`
      : null
  ].filter(Boolean).join("\n");
}

/* =========================================================
   HISTORY / AUDIT
========================================================= */

async function recordHistory(accountId, adminId, payload = {}) {
  try {
    let account = null;
    if (accountId && !payload.accountLabel) {
      account = await getAccount(accountId);
    }

    const row = {
      account_id: account?.id || accountId || null,
      account_label: account?.label || payload.accountLabel || "Account",
      admin_id: adminId || null,
      group_id: payload.groupId || null,
      group_title: payload.groupTitle || null,
      action: payload.action || payload.actionType || "unknown",
      status: payload.status || "success",
      error: payload.error ? String(payload.error).slice(0, 1000) : null
    };

    const { error } = await sb.from("promotion_history").insert(row);
    if (error) console.error("HISTORY INSERT:", error);
  } catch (e) {
    console.error("HISTORY:", safeErrorMessage(e));
  }
}

async function renderHistory(ctx, accountId, page = 0) {
  const account = await accountHasAccess(accountId);
  if (!account) {
    return replaceUi(
      ctx,
      "❌ Account tidak ditemukan.",
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }

  const offset = page * HISTORY_PAGE_SIZE;

  const [{ data: rows, error }, { count, error: countError }] = await Promise.all([
    sb
      .from("promotion_history")
      .select(
        "id,account_id,account_label,admin_id,group_id,group_title,action,status,error,created_at"
      )
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .range(offset, offset + HISTORY_PAGE_SIZE),
    sb
      .from("promotion_history")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
  ]);

  if (error) throw error;
  if (countError) throw countError;

  const visible = (rows || []).slice(0, HISTORY_PAGE_SIZE);
  const total = Number(count || 0);
  const hasNext = offset + HISTORY_PAGE_SIZE < total;

  const adminIds = [...new Set(visible.map(x => x.admin_id).filter(Boolean))];
  const groupIds = [...new Set(visible.map(x => x.group_id).filter(Boolean))];

  const [adminsResult, groupsResult] = await Promise.all([
    adminIds.length
      ? sb.from("admins").select("id,telegram_user_id,first_name,username").in("id", adminIds)
      : Promise.resolve({ data: [], error: null }),
    groupIds.length
      ? sb.from("account_groups").select("id,title").in("id", groupIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (adminsResult.error) throw adminsResult.error;
  if (groupsResult.error) throw groupsResult.error;

  const adminMap = new Map(
    (adminsResult.data || []).map(x => [String(x.id), x])
  );
  const groupMap = new Map(
    (groupsResult.data || []).map(x => [String(x.id), x.title])
  );

  const lines = [];

  for (const [index, row] of visible.entries()) {
    const status =
      row.status === "success" ? "✅" :
      row.status === "error" ? "❌" :
      row.status === "skipped" ? "⏭️" : "ℹ️";

    const admin = adminMap.get(String(row.admin_id));
    const adminLabel = admin?.telegram_user_id
      ? String(admin.telegram_user_id)
      : "system";

    const groupTitle =
      row.group_title ||
      groupMap.get(String(row.group_id)) ||
      "-";

    const errorLine = row.error
      ? `\n⚠️ ${escapeHtml(String(row.error).slice(0, 120))}`
      : "";

    lines.push(
      `${status} <b>#${offset + index + 1}</b> • <b>${escapeHtml(row.action || "-")}</b>\n` +
      `👤 Admin: <code>${escapeHtml(adminLabel)}</code>\n` +
      `👥 Target: <b>${escapeHtml(groupTitle)}</b>\n` +
      `🕐 ${escapeHtml(formatDate(row.created_at))}${errorLine}`
    );
  }

  const text = [
    `📋 <b>RIWAYAT • ${escapeHtml(account.label)}</b>`,
    `Total log: <b>${total}</b>`,
    `Halaman: <b>${page + 1}</b>`,
    "",
    lines.length ? lines.join("\n\n") : "<i>Belum ada riwayat.</i>"
  ].join("\n");

  return replaceUi(
    ctx,
    text,
    historyKeyboard(accountId, page, hasNext),
    { parse_mode: "HTML" }
  );
}

/* =========================================================
   SCHEDULER / PROMOTION ENGINE
========================================================= */

function extractFloodWaitMs(error) {
  if (!error) return 0;
  const direct = Number(error.seconds || error.value || 0);
  if (Number.isFinite(direct) && direct > 0 && direct < 86400) {
    return direct * 1000 + 1000;
  }

  const text = String(error.message || error || "");
  const match = text.match(/(?:FLOOD_WAIT|wait of)\s*(\d+)\s*(?:seconds?|s)?/i);
  if (!match) return 0;

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) return 0;
  return seconds * 1000 + 1000;
}

function classifySendError(error) {
  const raw = String(error?.message || error || "").trim();
  const msg = raw.toLowerCase();

  if (
    msg.includes("chat_write_forbidden") ||
    msg.includes("chat_send_plain_forbidden") ||
    msg.includes("not enough rights") ||
    msg.includes("can't write") ||
    msg.includes("can't send") ||
    msg.includes("forbidden")
  ) {
    return "Tidak diizinkan mengirim pesan";
  }

  if (
    msg.includes("user_banned_in_channel") ||
    msg.includes("banned")
  ) {
    return "Akun tidak diizinkan mengirim pesan";
  }

  if (
    msg.includes("chat_admin_required") ||
    msg.includes("admin required") ||
    msg.includes("administrator")
  ) {
    return "Tidak memiliki izin yang diperlukan";
  }

  if (
    msg.includes("chat_restricted") ||
    msg.includes("restricted")
  ) {
    return "Group sedang dibatasi";
  }

  if (
    msg.includes("channel_private") ||
    msg.includes("chat_id_invalid") ||
    msg.includes("chat not found") ||
    msg.includes("group not found") ||
    msg.includes("entity") && msg.includes("not found")
  ) {
    return "Group tidak dapat diakses";
  }

  if (extractFloodWaitMs(error) > 0) {
    return "Telegram meminta menunggu sebelum mengirim lagi";
  }

  return raw ? raw.replace(/\s+/g, " ").slice(0, 160) : "Kesalahan tidak diketahui";
}

async function fireAccount(accountId) {
  const account = await getAccount(accountId);
  const settings = await getAccountSettings(accountId);

  if (!account || !settings?.active) {
    return { shouldContinue: false, delayMs: 0 };
  }

  const now = new Date();
  if (
    !settings.expires_at ||
    new Date(settings.expires_at) <= now
  ) {
    await sb
      .from("account_settings")
      .update({
        active: false,
        expires_at: null,
        started_at: null,
      })
      .eq("account_id", accountId);

    return { shouldContinue: false, delayMs: 0 };
  }

  const starterAdminTelegramId = null;
  const client = await clientFor(accountId);
  if (!client) {
    await markAccountStatus(accountId, "error");
    await recordHistory(accountId, null, {
      accountLabel: account.label,
      adminTelegramUserId: starterAdminTelegramId,
      action: "promotion_send",
      status: "error",
      error: "Akun Telegram tidak terhubung atau session tidak valid.",
      details: { retryInSeconds: 120 }
    });

    return { shouldContinue: true, delayMs: 120000 };
  }

  let groupsResult = await sb
    .from("account_groups")
    .select("id,telegram_group_id,title,can_send,enabled")
    .eq("account_id", accountId)
    .eq("enabled", true)
    .eq("can_send", true)
    .order("title", { ascending: true });

  if (groupsResult.error) throw groupsResult.error;

  const groups = groupsResult.data || [];

  if (!groups.length) {
    await recordHistory(accountId, null, {
      accountLabel: account.label,
      adminTelegramUserId: starterAdminTelegramId,
      action: "promotion_send",
      status: "skipped",
      error: "Tidak ada target grup aktif.",
      details: {}
    });

    return {
      shouldContinue: true,
      delayMs: Number(settings.interval_minutes || 10) * 60 * 1000
    };
  }

  const dialogs = await client.getDialogs({ limit: 500 });
  const entityMap = new Map();

  for (const dialog of dialogs) {
    const entity = dialog?.entity;
    if (!entity) continue;
    if (!dialog.isGroup && !dialog.isChannel) continue;

    const rawId = String(entity.id?.value ?? entity.id ?? "");
    if (rawId) entityMap.set(rawId, entity);
  }

  let photoBuffer = null;
  if (settings.media_type === "photo" && settings.media_file_id) {
    try {
      photoBuffer = await downloadBotPhoto(settings.media_file_id);
    } catch (e) {
      const reason = safeErrorMessage(e);
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "error",
        error: `Foto format gagal diambil: ${reason}`,
        details: { media: true }
      });

      return {
        shouldContinue: true,
        delayMs: Number(settings.interval_minutes || 10) * 60 * 1000
      };
    }
  }

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let floodWaitMs = 0;
  const failures = new Map();

  for (const group of groups) {
    const target = entityMap.get(String(group.telegram_group_id));

    if (!target) {
      skippedCount++;
      const reason = "Entity grup tidak ditemukan di dialog Telegram";
      failures.set(reason, (failures.get(reason) || 0) + 1);
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: reason,
        details: { telegram_group_id: group.telegram_group_id }
      });
      continue;
    }

    try {
      if (settings.media_type === "photo" && photoBuffer) {
        await client.sendFile(target, {
          file: photoBuffer,
          caption: settings.caption || "",
          forceDocument: false
        });
      } else {
        const message = String(settings.message || "").trim();
        if (!message) {
          throw new Error("Format teks kosong.");
        }

        await client.sendMessage(target, { message });
      }

      successCount++;
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "success",
        groupId: group.id,
        groupTitle: group.title,
        details: {
          format: settings.media_type,
          telegram_group_id: group.telegram_group_id
        }
      });
    } catch (e) {
      failCount++;
      const reason = classifySendError(e);
      failures.set(reason, (failures.get(reason) || 0) + 1);
      floodWaitMs = Math.max(floodWaitMs, extractFloodWaitMs(e));

      await recordHistory(accountId, null, {
        accountLabel: account.label,
        adminTelegramUserId: starterAdminTelegramId,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: safeErrorMessage(e, 1000),
        details: {
          reason,
          telegram_group_id: group.telegram_group_id
        }
      });
    }
  }

  const reportLines = [
    `📊 <b>${escapeHtml(account.label)}</b>`,
    `✅ Berhasil: <b>${successCount}</b>`,
    `❌ Gagal: <b>${failCount}</b>`,
    `ℹ️ Dilewati: <b>${skippedCount}</b>`
  ];

  if (failures.size) {
    reportLines.push("", "⚠️ <b>Alasan:</b>");
    for (const [reason, count] of failures) {
      reportLines.push(`• ${count} × ${escapeHtml(reason)}`);
    }
  }

  if (starterAdminTelegramId) {
    try {
      await bot.api.sendMessage(
        starterAdminTelegramId,
        reportLines.join("\n"),
        { parse_mode: "HTML" }
      );
    } catch (_) {}
  }

  const baseDelay = Number(settings.interval_minutes || 10) * 60 * 1000;
  const delayMs = Math.max(baseDelay, floodWaitMs);

  return { shouldContinue: true, delayMs };
}

function scheduleAccount(accountId, delayMs = 0) {
  const key = String(accountId);
  const oldTask = schedulerTasks.get(key);

  if (oldTask?.timeout) clearTimeout(oldTask.timeout);

  const task = {
    running: true,
    timeout: null
  };

  schedulerTasks.set(key, task);

  task.timeout = setTimeout(async () => {
    if (schedulerTasks.get(key) !== task || !task.running) return;

    let nextDelay = 60000;
    let shouldContinue = true;

    try {
      const result = await fireAccount(accountId);
      nextDelay = Number(result?.delayMs || 60000);
      shouldContinue = result?.shouldContinue !== false;
    } catch (e) {
      console.error(`PROMOTION ${key}:`, safeErrorMessage(e));
      const settings = await getAccountSettings(accountId).catch(() => null);

      await recordHistory(accountId, null, {
        action: "promotion_send",
        status: "error",
        error: safeErrorMessage(e, 1000)
      });

      nextDelay = Math.max(
        60000,
        Number(settings?.interval_minutes || 10) * 60 * 1000
      );
    }

    const latest = schedulerTasks.get(key);
    if (latest !== task || !task.running) return;

    const settings = await getAccountSettings(accountId).catch(() => null);
    if (!settings?.active) {
      schedulerTasks.delete(key);
      return;
    }

    if (
      settings.expires_at &&
      new Date(settings.expires_at) <= new Date()
    ) {
      await sb
        .from("account_settings")
        .update({
          active: false,
          expires_at: null,
          started_at: null,
        })
        .eq("account_id", accountId);

      schedulerTasks.delete(key);
      return;
    }

    if (!shouldContinue) {
      schedulerTasks.delete(key);
      return;
    }

    task.timeout = setTimeout(() => {
      if (schedulerTasks.get(key) !== task || !task.running) return;

      // Re-use the exact task; scheduleAccount would otherwise replace it.
      task.timeout = null;
      scheduleAccount(key, 0);
    }, Math.max(1000, nextDelay));
  }, Math.max(0, delayMs));
}

async function startPromotion(accountId, adminId) {
  return withAccountLock(accountId, async () => {
    const account = await getAccount(accountId);
    const settings = await getAccountSettings(accountId);

    if (!account) throw new Error("Account tidak ditemukan.");
    if (!settings) throw new Error("Setting account belum tersedia.");

    if (settings.active && schedulerTasks.has(String(accountId))) {
      return { alreadyRunning: true, account, settings };
    }

    const client = await clientFor(accountId);
    if (!client) {
      throw new Error("Account belum connected atau session tidak valid.");
    }

    const formatReady =
      (settings.media_type === "text" && String(settings.message || "").trim()) ||
      (settings.media_type === "photo" && settings.media_file_id);

    if (!formatReady) {
      throw new Error("Format promosi belum dibuat.");
    }

    const { count, error: countError } = await sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("enabled", true)
      .eq("can_send", true);

    if (countError) throw countError;
    if (!Number(count || 0)) {
      throw new Error("Belum ada target grup aktif yang bisa dikirimi.");
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + Number(settings.duration_hours || 1) * 60 * 60 * 1000
    );

    const { data: updated, error } = await sb
      .from("account_settings")
      .update({
        active: true,
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq("account_id", accountId)
      .select("*")
      .single();

    if (error) throw error;

    await recordHistory(accountId, adminId, {
      action: "promotion_start",
      status: "success",
      details: {
        interval_minutes: updated.interval_minutes,
        duration_hours: updated.duration_hours
      }
    });

    // Exactly one scheduler per account. Immediate first fire is retained from old bot behavior.
    scheduleAccount(accountId, 0);

    return { alreadyRunning: false, account, settings: updated };
  });
}

async function stopPromotion(accountId, adminId) {
  return withAccountLock(accountId, async () => {
    const account = await getAccount(accountId);
    if (!account) throw new Error("Account tidak ditemukan.");

    await stopScheduler(accountId);

    const { data: settings, error } = await sb
      .from("account_settings")
      .select("*")
      .eq("account_id", accountId)
      .maybeSingle();

    if (error) throw error;

    const wasRunning = Boolean(settings?.active);

    const { error: updateError } = await sb
      .from("account_settings")
      .update({
        active: false,
        expires_at: null,
        started_at: null,
      })
      .eq("account_id", accountId);

    if (updateError) throw updateError;

    await recordHistory(accountId, adminId, {
      action: "promotion_stop",
      status: "success",
      details: { was_running: wasRunning }
    });

    return { wasRunning };
  });
}

/* =========================================================
   ACCOUNT LOGIN / CONNECT
========================================================= */

function waitForInput(
  adminTelegramId,
  nextType,
  timeoutMs = 5 * 60 * 1000,
  accountId = null
) {
  const userId = String(adminTelegramId);

  return new Promise((resolve, reject) => {
    const old = waiters.get(userId);
    if (old) old.reject(new Error("Input sebelumnya dibatalkan."));

    let settled = false;
    let timer = null;

    const waiter = {
      type: nextType,
      accountId: accountId == null ? null : String(accountId),
      timer: null,
      resolve(value) {
        if (settled) return;
        if (waiters.get(userId) !== waiter) return;

        const normalized =
          nextType === "code"
            ? String(value ?? "").replace(/\s+/g, "").trim()
            : String(value ?? "").trim();

        if (!normalized) {
          settled = true;
          clearTimeout(timer);
          waiters.delete(userId);
          reject(new Error(
            nextType === "code"
              ? "Kode OTP tidak boleh kosong."
              : "Password 2FA tidak boleh kosong."
          ));
          return;
        }

        settled = true;
        clearTimeout(timer);
        waiters.delete(userId);
        resolve(normalized);
      },
      reject(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (waiters.get(userId) === waiter) {
          waiters.delete(userId);
        }
        reject(error);
      }
    };

    timer = setTimeout(() => {
      if (waiters.get(userId) !== waiter || settled) return;
      settled = true;
      waiters.delete(userId);
      flows.delete(userId);
      reject(new Error("Waktu input habis. Silakan mulai lagi."));
    }, timeoutMs);

    waiter.timer = timer;
    waiters.set(userId, waiter);
  });
}

async function startLoading(ctx, phone) {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat?.id || ctx.from.id;
  const safePhone = escapeHtml(phone);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  // Keep the login process inside one editable UI message.
  await deleteSavedUi(userId);

  let frameIndex = 0;
  let stopped = false;
  let timer = null;
  let busy = false;
  let currentBody = [
    "<b>Nomor diterima</b>",
    "",
    `📱 Nomor <code>${safePhone}</code>`,
    "⏳ Menghubungkan ke Telegram...",
    "🔐 Menyiapkan sesi login..."
  ].join("\n");
  let currentKeyboard = cancelKeyboard(false);

  const buildText = frame => `${frame} ${currentBody}`;

  const edit = async text => {
    try {
      await bot.api.editMessageText(chatId, message.message_id, text, {
        parse_mode: "HTML",
        reply_markup: currentKeyboard
      });
    } catch (e) {
      if (!/message is not modified/i.test(String(e?.message || e))) {
        console.warn("LOGIN STATUS UPDATE:", safeErrorMessage(e, 180));
      }
    }
  };

  const schedule = () => {
    if (stopped) return;

    timer = setTimeout(async () => {
      if (stopped) return;

      if (!busy) {
        busy = true;
        frameIndex = (frameIndex + 1) % frames.length;
        try {
          await edit(buildText(frames[frameIndex]));
        } finally {
          busy = false;
        }
      }

      schedule();
    }, 800);
  };

  const message = await bot.api.sendMessage(
    chatId,
    buildText(frames[0]),
    {
      parse_mode: "HTML",
      reply_markup: currentKeyboard
    }
  );
  await saveUiMessage(userId, message, false);

  schedule();

  return {
    async update(text, keyboard = cancelKeyboard(false)) {
      currentBody = String(text);
      currentKeyboard = keyboard;
      if (!stopped) {
        await edit(buildText(frames[frameIndex]));
      }
    },
    async finish(text, keyboard = cancelKeyboard(false)) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      currentBody = String(text);
      currentKeyboard = keyboard;
      await edit(currentBody);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

function stopLoading(loader) {
  loader?.stop?.();
}

async function startLogin(ctx, accountId, phone, options = {}) {
  const adminTelegramId = ctx.from.id;
  const userKey = String(adminTelegramId);
  const existingRun = loginRuns.get(userKey);

  if (existingRun) {
    throw new Error("Proses login akun Telegram lain masih berjalan.");
  }

  const client = await createTelegramClient("");
  const run = {
    accountId: String(accountId),
    client,
    cancelled: false
  };
  loginRuns.set(userKey, run);

  let loginStatus = null;
  let sessionPersisted = false;

  try {
    if (run.cancelled) throw new Error("Login dibatalkan.");

    loginStatus = await startLoading(ctx, phone);
    await client.connect();

    if (run.cancelled) throw new Error("Login dibatalkan.");

    await loginStatus.update(
      [
        "<b>Terhubung ke Telegram</b>",
        "",
        `📱 Nomor <code>${escapeHtml(phone)}</code>`,
        "📩 Meminta kode verifikasi dari Telegram..."
      ].join("\n")
    );

    await client.start({
      phoneNumber: async () => phone,

      phoneCode: async () => {
        if (run.cancelled) throw new Error("Login dibatalkan.");

        // Register the waiter before changing the UI. This prevents a fast
        // OTP message from arriving before the input promise is available.
        flows.set(userKey, {
          t: "login_code",
          accountId: String(accountId)
        });
        const codePromise = waitForInput(
          adminTelegramId,
          "code",
          5 * 60 * 1000,
          accountId
        );

        await loginStatus.finish(
          [
            "✅ <b>Kode OTP Telegram sudah dikirim</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "📨 Periksa aplikasi Telegram pada nomor tersebut.",
            "",
            "🔑 <b>Kirim kode OTP di chat ini.</b>"
          ].join("\n"),
          cancelKeyboard(false)
        );

        const code = await codePromise;
        const normalized = String(code || "").replace(/\s+/g, "").trim();
        if (!normalized) {
          throw new Error("Kode OTP tidak boleh kosong.");
        }
        if (!/^\d+$/.test(normalized)) {
          throw new Error("Kode OTP harus berupa angka.");
        }

        return normalized;
      },

      password: async () => {
        if (run.cancelled) throw new Error("Login dibatalkan.");

        flows.set(userKey, {
          t: "login_password",
          accountId: String(accountId)
        });
        const passwordPromise = waitForInput(
          adminTelegramId,
          "password",
          5 * 60 * 1000,
          accountId
        );

        await loginStatus.finish(
          [
            "🔐 <b>Verifikasi 2 langkah</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "Akun ini meminta password 2FA Telegram.",
            "",
            "🔑 <b>Kirim password 2FA di chat ini.</b>"
          ].join("\n"),
          cancelKeyboard(false)
        );

        const password = await passwordPromise;
        if (!password) {
          throw new Error("Password 2FA tidak boleh kosong.");
        }
        return password;
      },

      onError: async error => {
        const message = safeErrorMessage(error, 300);
        console.error("LOGIN ERROR:", message);

        // GramJS returns to its auth loop after onError unless the callback
        // returns truthy. A manual cancel must therefore explicitly stop the
        // auth loop instead of being mistaken for an OTP failure.
        if (
          run.cancelled ||
          message === "Login dibatalkan." ||
          message === "AUTH_USER_CANCEL" ||
          message === "Waktu input habis. Silakan mulai lagi." ||
          message === "Sesi input login sudah tidak aktif." ||
          message === "Input sebelumnya dibatalkan."
        ) {
          run.cancelled = true;
          return true;
        }

        return false;
      }
    });

    if (run.cancelled) throw new Error("Login dibatalkan.");

    const identity = await getMeFromClient(client);

    const { data: other, error: otherError } = await sb
      .from("telegram_accounts")
      .select("id,label")
      .eq("telegram_user_id", identity.telegramUserId)
      .neq("id", accountId)
      .limit(1)
      .maybeSingle();

    if (otherError) throw otherError;

    if (other) {
      throw new Error(
        `Akun Telegram tersebut sudah dikaitkan sebagai "${other.label}".`
      );
    }

    const derivedLabel =
      [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim() ||
      identity.username ||
      phone;

    const sessionString = client.session.save();
    if (!sessionString) {
      throw new Error("Session Telegram kosong setelah login.");
    }
    const sessionEncrypted = encryptSession(sessionString);

    const { data: updated, error } = await sb
      .from("telegram_accounts")
      .update({
        label: derivedLabel.slice(0, 80),
        telegram_user_id: identity.telegramUserId,
        username: identity.username || null,
        phone,
        session_string: sessionEncrypted,
        status: "connected"
      })
      .eq("id", accountId)
      .select("*")
      .single();

    if (error) throw error;

    clients.set(String(accountId), client);
    sessionPersisted = true;
    flows.delete(userKey);

    await recordHistory(accountId, options.adminId || null, {
      action: "account_connect",
      status: "success",
      details: {
        telegram_user_id: identity.telegramUserId,
        username: identity.username
      }
    });

    await loginStatus?.finish(
      [
        "✅ <b>Login berhasil</b>",
        "",
        `📱 Nomor <code>${escapeHtml(phone)}</code>`,
        `👤 Akun <code>${escapeHtml(derivedLabel)}</code>`,
        "🔒 Session berhasil disimpan.",
        "🟢 Status: connected"
      ].join("\n"),
      cancelKeyboard(false)
    );

    // UI rendering should never undo a successfully persisted login.
    try {
      await showAccount(ctx, updated.id, "✅ Account Telegram berhasil terhubung.");
    } catch (uiError) {
      console.error("LOGIN SUCCESS UI:", safeErrorMessage(uiError, 300));
    }
  } catch (e) {
    flows.delete(userKey);

    const waiter = waiters.get(userKey);
    if (waiter?.accountId === String(accountId)) {
      waiter.reject(e);
    }

    const cancelled =
      run.cancelled ||
      safeErrorMessage(e, 200) === "Login dibatalkan." ||
      safeErrorMessage(e, 200) === "AUTH_USER_CANCEL";

    stopLoading(loginStatus);

    if (loginStatus && !cancelled && !sessionPersisted) {
      await loginStatus.finish(
        [
          "❌ <b>Login gagal</b>",
          "",
          `📱 Nomor <code>${escapeHtml(phone)}</code>`,
          escapeHtml(safeErrorMessage(e, 300))
        ].join("\n"),
        cancelKeyboard(false)
      );
    }

    // Once the session is persisted and the client is stored, never disconnect
    // it because a later UI-only operation failed.
    if (!sessionPersisted) {
      try { await client.disconnect(); } catch (_) {}

      if (options.deleteOnFailure) {
        try {
          await deleteAccountAfterLoginFailure(accountId);
        } catch (cleanupError) {
          console.error(
            "LOGIN CLEANUP:",
            safeErrorMessage(cleanupError, 300)
          );
        }
      }
    }

    if (cancelled) return;

    throw e;
  } finally {
    if (loginRuns.get(userKey) === run) {
      loginRuns.delete(userKey);
    }
  }
}

async function connectStoredAccount(ctx, accountId, adminId) {
  const client = await clientFor(accountId);

  if (!client) return false;

  const identity = await getMeFromClient(client);
  const { error } = await sb
    .from("telegram_accounts")
    .update({
      telegram_user_id: identity.telegramUserId,
      status: "connected",
    })
    .eq("id", accountId);

  if (error) throw error;

  await recordHistory(accountId, adminId, {
    action: "account_connect",
    status: "success",
    details: { reconnect: true, telegram_user_id: identity.telegramUserId }
  });

  return true;
}

/* =========================================================
   LEGACY MIGRATION
   Tabel lama tetap dipertahankan. Server mengimpor satu kali,
   termasuk encrypt session lama di level aplikasi.
========================================================= */

async function tableExists(tableName) {
  try {
    const { error } = await sb
      .from(tableName)
      .select("*", { count: "exact", head: true });

    if (!error) return true;
    const message = String(error.message || "").toLowerCase();
    const code = String(error.code || "");
    if (code === "PGRST205") return false;
    if (message.includes("schema cache")) return false;
    if (message.includes("does not exist")) return false;
    if (message.includes("relation") && message.includes("not found")) return false;
    return true;
  } catch (_) {
    return false;
  }
}

async function getMigrationState(key) {
  const { data, error } = await sb
    .from("system_migrations")
    .select("*")
    .eq("key", key)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markMigrationComplete(key, details = {}) {
  const { error } = await sb
    .from("system_migrations")
    .upsert({
      key,
      completed_at: new Date().toISOString(),
      details
    }, { onConflict: "key" });

  if (error) throw error;
}

async function migrateLegacyData() {
  const key = "legacy_import_v1";
  const state = await getMigrationState(key);
  if (state?.completed_at) return;

  const hasUsers = await tableExists("app_users");
  const hasSessions = await tableExists("telegram_sessions");
  const hasGroups = await tableExists("groups");
  const hasCampaigns = await tableExists("campaigns");
  const hasCampaignGroups = await tableExists("campaign_groups");
  const hasSendLogs = await tableExists("send_logs");

  if (!hasUsers) {
    await markMigrationComplete(key, { skipped: true, reason: "legacy app_users not found" });
    return;
  }

  const owner = await sb
    .from("admins")
    .select("id,telegram_user_id")
    .eq("role", "OWNER")
    .eq("active", true)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (owner.error) throw owner.error;
  const ownerTelegramUserId = owner.data?.telegram_user_id || null;

  const { data: legacyUsers, error: usersError } = await sb
    .from("app_users")
    .select("*")
    .order("id", { ascending: true });

  if (usersError) throw usersError;

  const accountByLegacyUserId = new Map();
  const accountByTelegramId = new Map();
  const legacyUserById = new Map();
  let migratedAccounts = 0;

  for (const legacyUser of legacyUsers || []) {
    legacyUserById.set(String(legacyUser.id), legacyUser);

    const tgId = legacyUser.telegram_user_id;
    if (!tgId) continue;

    const existing = await sb
      .from("telegram_accounts")
      .select("*")
      .eq("telegram_user_id", tgId)
      .maybeSingle();

    if (existing.error) throw existing.error;

    let account = existing.data;

    if (!account) {
      const label =
        String(legacyUser.first_name || legacyUser.username || "").trim() ||
        `Legacy Account ${tgId}`;

      const inserted = await sb
        .from("telegram_accounts")
        .insert({
          telegram_user_id: tgId,
          label,
          status: "disconnected",
          created_by: ownerTelegramUserId
        })
        .select("*")
        .single();

      if (inserted.error) throw inserted.error;
      account = inserted.data;
      migratedAccounts++;
    }

    await ensureAccountSettings(account.id);
    accountByLegacyUserId.set(String(legacyUser.id), account);
    accountByTelegramId.set(String(tgId), account);
  }

  if (hasSessions && legacyUsers?.length) {
    const { data: legacySessions, error: sessionsError } = await sb
      .from("telegram_sessions")
      .select("*");

    if (sessionsError) throw sessionsError;

    for (const session of legacySessions || []) {
      const legacyUser = legacyUserById.get(String(session.user_id));
      const account = accountByLegacyUserId.get(String(session.user_id));
      if (!account) continue;

      const update = {};
      if (session.phone) update.phone = session.phone;
      if (
        session.status === "connected" &&
        legacyUser?.status === "active"
      ) {
        update.status = "connected";
      } else if (session.status) {
        update.status = "disconnected";
      }

      const existingAccount = await getAccount(account.id);
      if (!existingAccount?.session_string && session.session_string) {
        update.session_string = encryptSession(session.session_string);
      }

      if (Object.keys(update).length) {
        const { error } = await sb
          .from("telegram_accounts")
          .update(update)
          .eq("id", account.id);
        if (error) throw error;
      }
    }
  }

  if (hasGroups) {
    const { data: legacyGroups, error: groupsError } = await sb
      .from("groups")
      .select("*")
      .order("id", { ascending: true });

    if (groupsError) throw groupsError;

    for (const group of legacyGroups || []) {
      const account = accountByLegacyUserId.get(String(group.user_id));
      if (!account) continue;

      const { error } = await sb
        .from("account_groups")
        .upsert({
          account_id: account.id,
          telegram_group_id: String(group.telegram_group_id),
          title: group.title || "Tanpa Nama",
          can_send: group.can_send !== false,
          enabled: group.enabled === true
        }, {
          onConflict: "account_id,telegram_group_id"
        });

      if (error) throw error;
    }
  }

  const latestCampaignByLegacyUser = new Map();

  if (hasCampaigns) {
    const { data: campaigns, error: campaignsError } = await sb
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false });

    if (campaignsError) throw campaignsError;

    for (const campaign of campaigns || []) {
      const keyUser = String(campaign.user_id);
      if (!latestCampaignByLegacyUser.has(keyUser)) {
        latestCampaignByLegacyUser.set(keyUser, campaign);
      }
    }

    for (const [legacyUserId, campaign] of latestCampaignByLegacyUser) {
      const account = accountByLegacyUserId.get(legacyUserId);
      if (!account) continue;

      const update = {
        interval_minutes: Number(campaign.interval_minutes || 10),
        duration_hours: Number(campaign.duration_hours || 1),
        media_type: campaign.media_file_id ? "photo" : "text",
        message: campaign.message || "",
        media_file_id: campaign.media_file_id || null,
        caption: campaign.caption || null,
        active: campaign.active === true,
        started_at: campaign.started_at || null,
        expires_at: campaign.expires_at || null
      };

      // The migration runs before normal new-version use, so legacy settings
      // are intentionally copied as the starting per-account configuration.
      const { error } = await sb
        .from("account_settings")
        .update(update)
        .eq("account_id", account.id);

      if (error) throw error;

      if (hasCampaignGroups) {
        const links = await sb
          .from("campaign_groups")
          .select("group_id")
          .eq("campaign_id", campaign.id);

        if (links.error) throw links.error;

        const targetGroupLegacyIds = new Set(
          (links.data || []).map(x => String(x.group_id))
        );

        for (const legacyGroupId of targetGroupLegacyIds) {
          // Legacy groups are uniquely identifiable by their old integer id.
          const legacyGroup = await sb
            .from("groups")
            .select("id,telegram_group_id")
            .eq("id", legacyGroupId)
            .maybeSingle();

          if (legacyGroup.error || !legacyGroup.data) continue;

          await sb
            .from("account_groups")
            .update({ enabled: true })
            .eq("account_id", account.id)
            .eq("telegram_group_id", String(legacyGroup.data.telegram_group_id));
        }
      }
    }
  }

  if (hasSendLogs) {
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const { data: logs, error: logsError } = await sb
        .from("send_logs")
        .select("*")
        .order("id", { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (logsError) throw logsError;
      if (!logs?.length) break;

      for (const log of logs) {
        const account = accountByLegacyUserId.get(String(log.user_id));
        if (!account) continue;

        let groupId = null;
        let groupTitle = null;

        if (log.group_id) {
          const legacyGroup = await sb
            .from("groups")
            .select("id,title,telegram_group_id")
            .eq("id", log.group_id)
            .maybeSingle();

          if (!legacyGroup.error && legacyGroup.data) {
            const currentGroup = await sb
              .from("account_groups")
              .select("id,title")
              .eq("account_id", account.id)
              .eq("telegram_group_id", String(legacyGroup.data.telegram_group_id))
              .maybeSingle();

            if (!currentGroup.error && currentGroup.data) {
              groupId = currentGroup.data.id;
              groupTitle = currentGroup.data.title;
            }
          }
        }

        const status = ["sent", "success", "ok"].includes(String(log.status).toLowerCase())
          ? "success"
          : "error";

        await recordHistory(account.id, null, {
          action: "legacy_send",
          status,
          groupId,
          groupTitle,
          error: log.error || null,
          accountLabel: account.label,
          details: {
            legacy_campaign_id: log.campaign_id || null,
            legacy_user_id: log.user_id || null
          },
          legacySource: "send_logs",
          legacySourceId: log.id
        });
      }

      if (logs.length < batchSize) break;
      offset += batchSize;
    }
  }

  await markMigrationComplete(key, {
    migrated_accounts: migratedAccounts,
    legacy_users: legacyUsers?.length || 0
  });
}

/* =========================================================
   ACCOUNT VIEWS / MENUS
========================================================= */

async function showAccount(ctx, accountId, prefixMessage = "") {
  const { account, settings } = await getAccountBundle(accountId);

  if (!account) {
    return replaceUi(
      ctx,
      "❌ Account tidak ditemukan.",
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }

  const safeSettings = settings || await ensureAccountSettings(account.id);
  const message = [
    prefixMessage,
    settingsSummary(account, safeSettings),
    "",
    account.status === "error"
      ? "⚠️ Status error berarti session perlu dicoba Connect kembali."
      : ""
  ].filter(Boolean).join("\n");

  return replaceUi(
    ctx,
    message,
    accountMenu(account, safeSettings),
    { parse_mode: "HTML" }
  );
}

/* =========================================================
   START / DASHBOARD
========================================================= */

bot.command("start", async ctx => {
  try {
    const userKey = String(ctx.from.id);
    const activeFlow = flows.get(userKey);
    const activeLogin = loginRuns.get(userKey);

    // Do not let /start replace the OTP/2FA UI while GramJS is waiting for
    // user input. The login waiter remains the only consumer of the next OTP
    // or password message.
    if (
      activeLogin ||
      activeFlow?.t === "login_code" ||
      activeFlow?.t === "login_password"
    ) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}
      return;
    }

    const adminRow = await getAdminByTelegramId(ctx.from.id);

    if (!adminRow) {
      return renderUi(
        ctx.from.id,
        "⛔ <b>Akses ditolak.</b>\n\nBot ini sekarang hanya digunakan oleh admin yang terdaftar.",
        new InlineKeyboard(),
        { parse_mode: "HTML" }
      );
    }

    const stats = await getDashboardStats().catch(() => ({
      admins: 0,
      accounts: 0,
      connected: 0,
      running: 0,
      groups: 0
    }));

    const text = dashboardText(ctx, stats);
    const menu = adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu();
    return renderStart(ctx, text, menu);
  } catch (e) {
    console.error("START:", safeErrorMessage(e));
    return ctx.reply("❌ Terjadi kesalahan saat membuka dashboard.");
  }
});

bot.callbackQuery("menu:dashboard", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const stats = await getDashboardStats().catch(() => ({
    admins: 0,
    accounts: 0,
    connected: 0,
    running: 0,
    groups: 0
  }));

  const menu = adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu();
  return replaceUi(ctx, dashboardText(ctx, stats), menu, { parse_mode: "HTML" });
});

/* =========================================================
   ACCOUNT LIST / ADD
========================================================= */

bot.callbackQuery(/^accounts:list:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const rawPage = Number(ctx.match[1]);

  try {
    const result = await listAccounts(rawPage);
    const page = ensurePage(rawPage, Math.floor(Math.max(0, result.total - 1) / ACCOUNT_PAGE_SIZE));

    // Re-load if the requested page was beyond current max.
    const current = page === rawPage ? result : await listAccounts(page);

    const lines = [
      "📱 <b>AKUN TELEGRAM</b>",
      `Total: <b>${current.total}</b>`,
      `Halaman: <b>${page + 1}</b>`,
      "",
      current.rows.length
        ? current.rows.map((x, i) =>
            `${String(page * ACCOUNT_PAGE_SIZE + i + 1).padStart(2, "0")}. ${accountStatusIcon(x)} <b>${escapeHtml(x.label)}</b>\n   🆔 <code>${escapeHtml(x.telegram_user_id || "belum login")}</code>`
          ).join("\n\n")
        : "<i>Belum ada akun Telegram.</i>",
      "",
      "Tekan nama akun untuk membuka semua kontrol account."
    ].join("\n");

    return replaceUi(
      ctx,
      lines,
      accountListKeyboard(current.rows, page, current.hasNext),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil daftar akun.\n\n${escapeHtml(safeErrorMessage(e))}`,
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery("account:add", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), {
    t: "account_phone_new",
    adminId: adminRow.id
  });

  return replaceUi(
    ctx,
    "➕ <b>Tambah Akun Telegram</b>\n\nKirim <b>nomor telepon</b> akun yang akan dihubungkan.\nNama akun akan diambil otomatis dari akun Telegram setelah login.\n\nContoh: <code>+628123456789</code>",
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:open:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  return showAccount(ctx, String(ctx.match[1]));
});

bot.callbackQuery(/^account:status:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  return showAccount(ctx, String(ctx.match[1]));
});

/* =========================================================
   ACCOUNT CONNECT / DISCONNECT / REMOVE
========================================================= */

bot.callbackQuery(/^account:connect:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Mengecek session...").catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const reconnected = await connectStoredAccount(ctx, accountId, adminRow.id);
    if (reconnected) {
      return showAccount(ctx, accountId, "✅ Session tersimpan berhasil digunakan kembali.");
    }
  } catch (e) {
    console.error("CONNECT STORED:", safeErrorMessage(e));
  }

  flows.set(String(ctx.from.id), {
    t: "account_phone",
    accountId,
    adminId: adminRow.id
  });

  return replaceUi(
    ctx,
    "📱 <b>Nomor Telegram</b>\n\nSession lama tidak dapat dipakai saat ini.\nKirim <b>nomor telepon</b> akun yang akan dihubungkan.\nLabel/nama akun tidak digunakan untuk login.\n\nContoh: <code>+628123456789</code>",
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:disconnect:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);

  try {
    await stopScheduler(accountId);
    await stopPromotion(accountId, adminRow.id);
    await closeClient(accountId);

    const { error } = await sb
      .from("telegram_accounts")
      .update({ status: "disconnected" })
      .eq("id", accountId);

    if (error) throw error;

    await recordHistory(accountId, adminRow.id, {
      action: "account_disconnect",
      status: "success"
    });

    return showAccount(ctx, accountId, "✅ Account diputuskan. Session terenkripsi tetap disimpan untuk reconnect.");
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal memutus account.\n\n${escapeHtml(safeErrorMessage(e))}`,
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^account:remove:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  return replaceUi(
    ctx,
    `⚠️ <b>HAPUS ACCOUNT?</b>\n\n` +
      `📱 Account: <b>${escapeHtml(account.label)}</b>\n` +
      `🆔 Telegram ID: <code>${escapeHtml(account.telegram_user_id || "-")}</code>\n\n` +
      `Data account, setting, dan target grup akan dihapus. Riwayat tetap disimpan sebagai audit log.`,
    new InlineKeyboard()
      .text("✅ Ya, Hapus", `account:remove:confirm:${accountId}`)
      .row()
      .text("❌ Batal", `account:open:${accountId}`),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:remove:confirm:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Menghapus account...").catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(
      ctx,
      "❌ Account sudah tidak ada.",
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }

  try {
    await withAccountLock(accountId, async () => {
      await stopScheduler(accountId);
      await closeClient(accountId);

      // Detach history from the account/group rows first so the audit log can
      // survive the account deletion even when the FK uses RESTRICT.
      const detach = await sb
        .from("promotion_history")
        .update({ account_id: null, group_id: null })
        .eq("account_id", accountId);

      if (detach.error) throw detach.error;

      const { error: settingsError } = await sb
        .from("account_settings")
        .delete()
        .eq("account_id", accountId);

      if (settingsError) throw settingsError;

      const { error: groupsError } = await sb
        .from("account_groups")
        .delete()
        .eq("account_id", accountId);

      if (groupsError) throw groupsError;

      const { error: accountError } = await sb
        .from("telegram_accounts")
        .delete()
        .eq("id", accountId);

      if (accountError) throw accountError;
    });

    await recordHistory(null, adminRow.id, {
      accountLabel: account.label,
      action: "account_remove",
      status: "success",
      details: { deleted_account_id: accountId }
    });

    return replaceUi(
      ctx,
      `✅ <b>Account dihapus.</b>\\n\\n${escapeHtml(account.label)} sudah tidak lagi berada di sistem. Riwayat audit tetap disimpan.`,
      new InlineKeyboard().text("📱 Daftar Akun", "accounts:list:0"),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal menghapus account.\\n\\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard()
        .text("◀️ Account", `account:open:${accountId}`)
        .row()
        .text("🏠 Dashboard", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  }
});

/* =========================================================
   ACCOUNT SETTINGS / LABEL
========================================================= */

bot.callbackQuery(/^account:settings:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const { account, settings } = await getAccountBundle(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  return replaceUi(
    ctx,
    `⚙️ <b>SETTING ACCOUNT</b>\n\n${settingsSummary(account, settings)}`,
    settingsMenu(accountId),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:label:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  flows.set(String(ctx.from.id), {
    t: "account_label_edit",
    accountId
  });

  return replaceUi(
    ctx,
    `✏️ <b>Ubah Label</b>\n\nLabel saat ini: <b>${escapeHtml(account.label)}</b>\n\nKirim label baru.`,
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   PROMOTION FORMAT / DELAY / DURATION
========================================================= */

bot.callbackQuery(/^promo:format:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  flows.set(String(ctx.from.id), {
    t: "format",
    accountId,
    adminId: adminRow.id
  });

  return replaceUi(
    ctx,
    `📝 <b>FORMAT PROMOSI • ${escapeHtml(account.label)}</b>\n\n` +
      `Kirim salah satu:\n` +
      `• Teks biasa\n` +
      `• Foto saja\n` +
      `• Foto + caption\n\n` +
      `Format ini hanya berlaku untuk account yang sedang dipilih.`,
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^promo:delay:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  flows.set(String(ctx.from.id), {
    t: "delay",
    accountId,
    adminId: adminRow.id
  });

  return replaceUi(
    ctx,
    `⏱ <b>SET JEDA • ${escapeHtml(account.label)}</b>\n\n` +
      `Contoh: <code>10 menit</code>, <code>30 menit</code>, <code>1 jam</code>.\n\nMinimal 1 menit.`,
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^promo:duration:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  flows.set(String(ctx.from.id), {
    t: "duration",
    accountId,
    adminId: adminRow.id
  });

  return replaceUi(
    ctx,
    `📅 <b>SET DURASI • ${escapeHtml(account.label)}</b>\n\n` +
      `Contoh: <code>3 hari</code>, <code>12 jam</code>.`,
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   PROMOTION START / STOP
========================================================= */

bot.callbackQuery(/^promo:start:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Menjalankan promosi...").catch(() => {});
  const accountId = String(ctx.match[1]);

  try {
    const result = await startPromotion(accountId, adminRow.id);

    if (result.alreadyRunning) {
      return showAccount(ctx, accountId, "ℹ️ Promosi account ini sudah berjalan. Scheduler kedua tidak dibuat.");
    }

    return showAccount(
      ctx,
      accountId,
      `▶️ <b>Promosi dimulai.</b>\nJeda: <b>${escapeHtml(formatInterval(result.settings.interval_minutes))}</b>\nDurasi: <b>${escapeHtml(formatDuration(result.settings.duration_hours))}</b>`
    );
  } catch (e) {
    return showAccount(ctx, accountId, `❌ ${escapeHtml(safeErrorMessage(e))}`);
  }
});

bot.callbackQuery(/^promo:stop:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Menghentikan promosi...").catch(() => {});
  const accountId = String(ctx.match[1]);

  try {
    const result = await stopPromotion(accountId, adminRow.id);
    return showAccount(
      ctx,
      accountId,
      result.wasRunning
        ? "⏹ <b>Promosi dihentikan.</b>"
        : "ℹ️ Account tidak sedang menjalankan promosi."
    );
  } catch (e) {
    return showAccount(ctx, accountId, `❌ ${escapeHtml(safeErrorMessage(e))}`);
  }
});

/* =========================================================
   GROUP MANAGEMENT
========================================================= */

bot.callbackQuery(/^group:list:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const requestedPage = Number(ctx.match[2]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const offset = requestedPage * GROUP_PAGE_SIZE;
    const { count } = await sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId);

    const total = Number(count || 0);
    const maxPage = Math.floor(Math.max(0, total - 1) / GROUP_PAGE_SIZE);
    const page = ensurePage(requestedPage, maxPage);
    const result = page === requestedPage
      ? await listGroups(accountId, page)
      : await listGroups(accountId, page);

    const activeCountResult = await sb
      .from("account_groups")
      .select("*", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("enabled", true)
      .eq("can_send", true);

    if (activeCountResult.error) throw activeCountResult.error;

    const lines = [
      `👥 <b>GRUP • ${escapeHtml(account.label)}</b>`,
      `Total: <b>${result.total}</b> • Target aktif: <b>${activeCountResult.count || 0}</b>`,
      `Halaman: <b>${page + 1}</b>`,
      "",
      result.rows.length
        ? result.rows.map((g, i) =>
            `${String(page * GROUP_PAGE_SIZE + i + 1).padStart(2, "0")}. ${g.enabled ? "✅" : "⬜"} <b>${escapeHtml(g.title)}</b>\n   ${g.can_send ? "🟢 Bisa kirim" : "🔴 Tidak bisa kirim"}`
          ).join("\n\n")
        : "<i>Belum ada grup yang tersimpan. Gunakan Scan / Refresh.</i>",
      "",
      "Tap nama grup untuk ON/OFF target. Tombol 🗑 menghapus target dari database bot."
    ].join("\n");

    return replaceUi(
      ctx,
      lines,
      groupListKeyboard(result.rows, accountId, page, result.hasNext),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil grup.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^group:refresh:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Scanning dialog Telegram...").catch(() => {});
  const accountId = String(ctx.match[1]);
  const account = await getAccount(accountId);

  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const rows = await refreshGroups(accountId);
    await recordHistory(accountId, adminRow.id, {
      action: "group_refresh",
      status: "success",
      details: { scanned: rows.length }
    });

    return renderGroupPageDirect(ctx, accountId, 0, `✅ Scan selesai. ${rows.length} dialog group/channel terbaca.`);
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Scan grup gagal.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

async function renderGroupPageDirect(ctx, accountId, page, prefix = "") {
  const result = await listGroups(accountId, page);
  const activeCountResult = await sb
    .from("account_groups")
    .select("*", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("enabled", true)
    .eq("can_send", true);

  if (activeCountResult.error) throw activeCountResult.error;

  const account = await getAccount(accountId);
  if (!account) throw new Error("Account tidak ditemukan.");

  const text = [
    prefix,
    `👥 <b>GRUP • ${escapeHtml(account.label)}</b>`,
    `Total: <b>${result.total}</b> • Target aktif: <b>${activeCountResult.count || 0}</b>`,
    "",
    result.rows.length
      ? result.rows.map((g, i) =>
          `${String(page * GROUP_PAGE_SIZE + i + 1).padStart(2, "0")}. ${g.enabled ? "✅" : "⬜"} <b>${escapeHtml(g.title)}</b>\n   ${g.can_send ? "🟢 Bisa kirim" : "🔴 Tidak bisa kirim"}`
        ).join("\n\n")
      : "<i>Belum ada grup.</i>"
  ].filter(Boolean).join("\n");

  return replaceUi(
    ctx,
    text,
    groupListKeyboard(result.rows, accountId, page, result.hasNext),
    { parse_mode: "HTML" }
  );
}

bot.callbackQuery(/^group:toggle:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  const groupId = String(ctx.match[1]);
  const group = await sb
    .from("account_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle();

  if (group.error || !group.data) {
    return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });
  }

  if (!group.data.can_send && !group.data.enabled) {
    return ctx.answerCallbackQuery(
      "Telegram menandai group ini tidak bisa menerima pesan.",
      { show_alert: true }
    );
  }

  await ctx.answerCallbackQuery().catch(() => {});

  const nextEnabled = !group.data.enabled;
  const { error } = await sb
    .from("account_groups")
    .update({ enabled: nextEnabled })
    .eq("id", groupId)
    .eq("account_id", group.data.account_id);

  if (error) {
    return ctx.answerCallbackQuery("Gagal menyimpan setting group.", { show_alert: true });
  }

  await recordHistory(group.data.account_id, adminRow.id, {
    action: nextEnabled ? "group_enable" : "group_disable",
    status: "success",
    groupId: groupId
  });

  return renderGroupPageDirect(ctx, group.data.account_id, 0);
});

bot.callbackQuery(/^group:remove:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  const groupId = String(ctx.match[1]);
  const { data: group, error: groupError } = await sb
    .from("account_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError || !group) {
    return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });
  }

  await ctx.answerCallbackQuery().catch(() => {});

  const { error } = await sb
    .from("account_groups")
    .delete()
    .eq("id", groupId)
    .eq("account_id", group.account_id);

  if (error) {
    return ctx.answerCallbackQuery("Gagal menghapus grup.", { show_alert: true });
  }

  await recordHistory(group.account_id, adminRow.id, {
    action: "group_remove",
    status: "success",
    groupId: groupId,
    groupTitle: group.title
  });

  return renderGroupPageDirect(ctx, group.account_id, 0, `🗑 <b>${escapeHtml(group.title)}</b> dihapus dari daftar target.`);
});

/* =========================================================
   HISTORY
========================================================= */

bot.callbackQuery(/^history:list:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  const page = Number(ctx.match[2]);

  try {
    return await renderHistory(ctx, accountId, Math.max(0, page));
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil riwayat.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

/* =========================================================
   ADMIN MANAGEMENT - OWNER ONLY
========================================================= */

bot.callbackQuery(/^admin:list:(\d+)$/, async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const page = Number(ctx.match[1]);

  try {
    const result = await listAdmins(Math.max(0, page));
    const lines = [
      "👥 <b>DAFTAR ADMIN</b>",
      `Total aktif: <b>${result.total}</b>`,
      `Halaman: <b>${Math.max(0, page) + 1}</b>`,
      "",
      result.rows.length
        ? result.rows.map((a, i) =>
            `${String(Math.max(0, page) * ADMIN_PAGE_SIZE + i + 1).padStart(2, "0")}. ${a.role === "OWNER" ? "👑" : "👨‍💼"} <b>${escapeHtml(a.role)}</b>\n   🆔 <code>${escapeHtml(a.telegram_user_id)}</code>`
          ).join("\n\n")
        : "<i>Belum ada admin.</i>",
      "",
      "ADMIN UTAMA dapat menambah/menghapus admin anak."
    ].join("\n");

    return replaceUi(
      ctx,
      lines,
      adminListKeyboard(result.rows, Math.max(0, page), result.hasNext),
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal mengambil daftar admin.\n\n${escapeHtml(safeErrorMessage(e))}`,
      backDashboardKeyboard(),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery("admin:add", async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;

  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), {
    t: "admin_add",
    adminId: owner.id
  });

  return replaceUi(
    ctx,
    "➕ <b>TAMBAH ADMIN ANAK</b>\n\nKirim Telegram user ID admin baru.\n\nContoh: <code>7607446655</code>",
    cancelKeyboard(true),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("admin:delete", async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;

  await ctx.answerCallbackQuery().catch(() => {});
  flows.set(String(ctx.from.id), {
    t: "admin_delete",
    adminId: owner.id
  });

  return replaceUi(
    ctx,
    "❌ <b>HAPUS ADMIN ANAK</b>\n\nKirim Telegram user ID admin anak yang akan dihapus.\n\nOwner/ADMIN UTAMA tidak dapat dihapus.",
    cancelKeyboard(true),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^admin:view:(\d+)$/, async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const adminId = String(ctx.match[1]);

  const { data, error } = await sb
    .from("admins")
    .select("*")
    .eq("id", adminId)
    .maybeSingle();

  if (error || !data) {
    return replaceUi(ctx, "❌ Admin tidak ditemukan.", new InlineKeyboard().text("◀️ Admin", "admin:list:0"), { parse_mode: "HTML" });
  }

  return replaceUi(
    ctx,
    `👨‍💼 <b>DETAIL ADMIN</b>\n\n` +
      `Role: <b>${escapeHtml(data.role)}</b>\n` +
      `Telegram ID: <code>${escapeHtml(data.telegram_user_id)}</code>\n` +
      `Username: ${escapeHtml(data.username ? `@${data.username}` : "-")}\n` +
      `Status: <b>${data.active ? "active" : "disabled"}</b>`,
    new InlineKeyboard().text("◀️ Admin", "admin:list:0").text("🏠", "menu:dashboard"),
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   CANCEL FLOW
========================================================= */

bot.callbackQuery("flow:cancel", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery("Dibatalkan").catch(() => {});
  const userKey = String(ctx.from.id);
  const run = loginRuns.get(userKey);
  if (run) {
    run.cancelled = true;
  }

  const waiter = waiters.get(userKey);
  if (waiter) waiter.reject(new Error("Login dibatalkan."));
  flows.delete(userKey);

  // Abort the local connection for an active login only. A stored/connected
  // account client is not touched because it is not placed in loginRuns.
  if (run && !waiter) {
    try { await run.client.disconnect(); } catch (_) {}
  }

  return replaceUi(
    ctx,
    "🏠 <b>Menu utama</b>\n\nSemua input yang sedang berjalan dibatalkan.",
    adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu(),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("admin:cancel", async ctx => {
  const owner = await requireAdmin(ctx, { ownerOnly: true });
  if (!owner) return;

  await ctx.answerCallbackQuery("Dibatalkan").catch(() => {});
  flows.delete(String(ctx.from.id));
  return replaceUi(
    ctx,
    "🏠 <b>Dashboard Admin</b>",
    ownerDashboardMenu(),
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   MESSAGE FLOW HANDLER
========================================================= */

bot.on("message", async (ctx, next) => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return next();

  // Biarkan command handler seperti /start memproses command lebih dulu.
  if (ctx.message?.text?.trim().startsWith("/start")) {
    return next();
  }

  const adminRow = await getAdminByTelegramId(telegramUserId).catch(() => null);
  if (!adminRow) return next();

  const userKey = String(telegramUserId);
  const waiter = waiters.get(userKey);
  const flow = flows.get(userKey);

  // OTP / 2FA password
  if (waiter && ["code", "password"].includes(waiter.type)) {
    const expectedFlowType = waiter.type === "code" ? "login_code" : "login_password";

    if (
      flow?.t !== expectedFlowType ||
      (waiter.accountId != null && String(flow.accountId) !== String(waiter.accountId))
    ) {
      waiter.reject(new Error("Sesi input login sudah tidak aktif."));
      return next();
    }

    if (!ctx.message.text) {
      return renderUi(
        telegramUserId,
        "❌ Input ini harus berupa teks.",
        cancelKeyboard(false),
        { parse_mode: "HTML" }
      );
    }

    const text = waiter.type === "code"
      ? ctx.message.text.replace(/\s+/g, "").trim()
      : ctx.message.text.trim();

    if (!text) {
      return renderUi(
        telegramUserId,
        waiter.type === "code"
          ? "❌ Kode OTP tidak boleh kosong."
          : "❌ Password 2FA tidak boleh kosong.",
        cancelKeyboard(false),
        { parse_mode: "HTML" }
      );
    }

    if (waiter.type === "code" && !/^\d+$/.test(text)) {
      return renderUi(
        telegramUserId,
        "❌ Kode OTP harus berupa angka.",
        cancelKeyboard(false),
        { parse_mode: "HTML" }
      );
    }

    // Try to reduce exposure of OTP/password in the admin chat.
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (_) {}

    waiter.resolve(text);
    return;
  }

  if (!flow) return next();

  try {
    /* -------------------------
       ADD ACCOUNT: PHONE
    -------------------------- */
    if (flow.t === "account_phone_new") {
      if (!ctx.message.text) {
        return renderUi(
          telegramUserId,
          "❌ Nomor Telegram harus berupa teks.",
          cancelKeyboard(false)
        );
      }

      const phone = ctx.message.text.trim();
      if (!/^\+\d{7,15}$/.test(phone)) {
        return renderUi(
          telegramUserId,
          "❌ Nomor tidak valid. Gunakan format internasional, contoh <code>+628123456789</code>.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      const account = await createAccountShell(`Telegram ${phone}`, adminRow.telegram_user_id, phone);
      flows.delete(userKey);

      return startLogin(ctx, account.id, phone, {
        adminId: adminRow.id,
        deleteOnFailure: true
      });
    }

    /* -------------------------
       EXISTING ACCOUNT: PHONE
    -------------------------- */
    if (flow.t === "account_phone") {
      if (!ctx.message.text) {
        return renderUi(
          telegramUserId,
          "❌ Nomor Telegram harus berupa teks.",
          cancelKeyboard(false)
        );
      }

      const phone = ctx.message.text.trim();
      if (!/^\+\d{7,15}$/.test(phone)) {
        return renderUi(
          telegramUserId,
          "❌ Nomor tidak valid. Gunakan format internasional.",
          cancelKeyboard(false)
        );
      }

      flows.delete(userKey);
      return startLogin(ctx, flow.accountId, phone, {
        adminId: adminRow.id,
        deleteOnFailure: false
      });
    }

    /* -------------------------
       LABEL EDIT
    -------------------------- */
    if (flow.t === "account_label_edit") {
      if (!ctx.message.text) {
        return renderUi(
          telegramUserId,
          "❌ Label harus berupa teks.",
          cancelKeyboard(false)
        );
      }

      const label = ctx.message.text.trim().replace(/\s+/g, " ").slice(0, 80);
      if (label.length < 2) {
        return renderUi(
          telegramUserId,
          "❌ Label terlalu pendek.",
          cancelKeyboard(false)
        );
      }

      const { error } = await sb
        .from("telegram_accounts")
        .update({ label })
        .eq("id", flow.accountId);

      if (error) throw error;

      await recordHistory(flow.accountId, adminRow.id, {
        action: "label_update",
        status: "success",
        details: { label }
      });

      flows.delete(userKey);
      return showAccount(ctx, flow.accountId, "✅ Label berhasil diperbarui.");
    }

    /* -------------------------
       FORMAT
    -------------------------- */
    if (flow.t === "format") {
      if (ctx.message.photo?.length) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const caption = ctx.message.caption || "";

        const { error } = await sb
          .from("account_settings")
          .update({
            media_type: "photo",
            message: "",
            media_file_id: photo.file_id,
            caption
          })
          .eq("account_id", flow.accountId);

        if (error) throw error;

        await recordHistory(flow.accountId, adminRow.id, {
          action: "format_update",
          status: "success",
          details: { type: "photo", has_caption: Boolean(caption) }
        });

        flows.delete(userKey);
        return showAccount(ctx, flow.accountId, "✅ Format foto berhasil disimpan.");
      }

      if (ctx.message.text) {
        const message = ctx.message.text.trim();
        if (!message) {
          return renderUi(
            telegramUserId,
            "❌ Format teks tidak boleh kosong.",
            cancelKeyboard(false)
          );
        }

        const { error } = await sb
          .from("account_settings")
          .update({
            media_type: "text",
            message,
            media_file_id: null,
            caption: null
          })
          .eq("account_id", flow.accountId);

        if (error) throw error;

        await recordHistory(flow.accountId, adminRow.id, {
          action: "format_update",
          status: "success",
          details: { type: "text" }
        });

        flows.delete(userKey);
        return showAccount(ctx, flow.accountId, "✅ Format teks berhasil disimpan.");
      }

      return renderUi(
        telegramUserId,
        "❌ Format tidak didukung. Kirim teks atau foto.",
        cancelKeyboard(false)
      );
    }

    /* -------------------------
       DELAY
    -------------------------- */
    if (flow.t === "delay") {
      const minutes = parseMinutes(ctx.message.text);
      if (!minutes) {
        return renderUi(
          telegramUserId,
          "❌ Jeda tidak valid. Contoh: <code>10 menit</code> atau <code>1 jam</code>.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      const { error } = await sb
        .from("account_settings")
        .update({ interval_minutes: minutes })
        .eq("account_id", flow.accountId);

      if (error) throw error;

      const settings = await getAccountSettings(flow.accountId);

      // Apply new delay to a running scheduler without creating a second task.
      if (settings?.active && schedulerTasks.has(String(flow.accountId))) {
        scheduleAccount(
          flow.accountId,
          Math.max(1000, minutes * 60 * 1000)
        );
      }

      await recordHistory(flow.accountId, adminRow.id, {
        action: "delay_update",
        status: "success",
        details: { interval_minutes: minutes }
      });

      flows.delete(userKey);
      return showAccount(
        ctx,
        flow.accountId,
        `✅ Jeda disimpan: <b>${escapeHtml(formatInterval(minutes))}</b>`
      );
    }

    /* -------------------------
       DURATION
    -------------------------- */
    if (flow.t === "duration") {
      const hours = parseHours(ctx.message.text);
      if (!hours) {
        return renderUi(
          telegramUserId,
          "❌ Durasi tidak valid. Contoh: <code>3 hari</code> atau <code>12 jam</code>.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      const current = await getAccountSettings(flow.accountId);
      const update = { duration_hours: hours };

      if (current?.active) {
        update.expires_at = new Date(
          Date.now() + hours * 60 * 60 * 1000
        ).toISOString();
      }

      const { error } = await sb
        .from("account_settings")
        .update(update)
        .eq("account_id", flow.accountId);

      if (error) throw error;

      await recordHistory(flow.accountId, adminRow.id, {
        action: "duration_update",
        status: "success",
        details: { duration_hours: hours }
      });

      flows.delete(userKey);
      return showAccount(
        ctx,
        flow.accountId,
        `✅ Durasi disimpan: <b>${escapeHtml(formatDuration(hours))}</b>`
      );
    }

    /* -------------------------
       ADMIN ADD
    -------------------------- */
    if (flow.t === "admin_add") {
      if (adminRow.role !== "OWNER") {
        flows.delete(userKey);
        return renderUi(
          telegramUserId,
          "⛔ Akses ditolak.",
          backDashboardKeyboard(),
          { parse_mode: "HTML" }
        );
      }

      const targetId = parsePositiveTelegramId(ctx.message.text);
      if (!targetId) {
        return renderUi(
          telegramUserId,
          "❌ Telegram ID harus berupa angka positif.",
          cancelKeyboard(true),
          { parse_mode: "HTML" }
        );
      }

      const existing = await sb
        .from("admins")
        .select("*")
        .eq("telegram_user_id", targetId)
        .maybeSingle();

      if (existing.error) throw existing.error;

      if (existing.data) {
        if (existing.data.active) {
          flows.delete(userKey);
          return replaceUi(
            ctx,
            `ℹ️ Telegram ID <code>${targetId}</code> sudah terdaftar sebagai <b>${escapeHtml(existing.data.role)}</b>.`,
            new InlineKeyboard().text("👥 Admin", "admin:list:0"),
            { parse_mode: "HTML" }
          );
        }

        const { error } = await sb
          .from("admins")
          .update({ role: "ADMIN", active: true })
          .eq("id", existing.data.id);
        if (error) throw error;
      } else {
        const { error } = await sb
          .from("admins")
          .insert({
            telegram_user_id: targetId,
            role: "ADMIN",
            active: true
          });
        if (error) throw error;
      }

      flows.delete(userKey);
      return replaceUi(
        ctx,
        `✅ <b>ADMIN ANAK DITAMBAHKAN</b>\n\nTelegram ID <code>${targetId}</code> sekarang dapat mengelola akun Telegram dan promosi.\n\nMenu manajemen admin tetap hanya tersedia untuk OWNER.`,
        new InlineKeyboard().text("👥 Daftar Admin", "admin:list:0").row().text("🏠 Dashboard", "menu:dashboard"),
        { parse_mode: "HTML" }
      );
    }

    /* -------------------------
       ADMIN DELETE
    -------------------------- */
    if (flow.t === "admin_delete") {
      if (adminRow.role !== "OWNER") {
        flows.delete(userKey);
        return renderUi(
          telegramUserId,
          "⛔ Akses ditolak.",
          backDashboardKeyboard(),
          { parse_mode: "HTML" }
        );
      }

      const targetId = parsePositiveTelegramId(ctx.message.text);
      if (!targetId) {
        return renderUi(
          telegramUserId,
          "❌ Telegram ID harus berupa angka positif.",
          cancelKeyboard(true)
        );
      }

      if (isOwnerId(targetId)) {
        return renderUi(
          telegramUserId,
          "⛔ Telegram ID OWNER dari ENV tidak dapat dihapus dari sistem.",
          cancelKeyboard(true),
          { parse_mode: "HTML" }
        );
      }

      const existing = await sb
        .from("admins")
        .select("*")
        .eq("telegram_user_id", targetId)
        .maybeSingle();

      if (existing.error) throw existing.error;

      if (!existing.data || existing.data.role !== "ADMIN") {
        flows.delete(userKey);
        return replaceUi(
          ctx,
          `❌ Admin anak dengan Telegram ID <code>${targetId}</code> tidak ditemukan.`,
          new InlineKeyboard().text("👥 Admin", "admin:list:0"),
          { parse_mode: "HTML" }
        );
      }

      const ownerResult = await sb
        .from("admins")
        .select("id,telegram_user_id")
        .eq("role", "OWNER")
        .eq("active", true)
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (ownerResult.error) throw ownerResult.error;
      const ownerTelegramUserId = ownerResult.data?.telegram_user_id;

      if (!ownerTelegramUserId) {
        throw new Error("ADMIN UTAMA aktif tidak ditemukan.");
      }

      // Preserve FK integrity: telegram_accounts.created_by points to
      // admins.telegram_user_id, so reassign accounts before deleting admin.
      const reassignAccounts = await sb
        .from("telegram_accounts")
        .update({ created_by: ownerTelegramUserId })
        .eq("created_by", targetId);

      if (reassignAccounts.error) throw reassignAccounts.error;

      // Preserve audit history while removing the admin row referenced by
      // promotion_history.admin_id.
      const detachHistory = await sb
        .from("promotion_history")
        .update({ admin_id: ownerResult.data.id })
        .eq("admin_id", existing.data.id);

      if (detachHistory.error) throw detachHistory.error;

      const { error } = await sb
        .from("admins")
        .delete()
        .eq("id", existing.data.id)
        .eq("role", "ADMIN");

      if (error) throw error;

      flows.delete(userKey);
      return replaceUi(
        ctx,
        `✅ Admin anak <code>${targetId}</code> telah dihapus.\n\nAkun Telegram dan promosi tidak ikut dihentikan karena admin hanya merupakan controller.`,
        new InlineKeyboard().text("👥 Daftar Admin", "admin:list:0").row().text("🏠 Dashboard", "menu:dashboard"),
        { parse_mode: "HTML" }
      );
    }
  } catch (e) {
    console.error("MESSAGE FLOW:", safeErrorMessage(e));

    // Do not leak session material or internal credentials.
    const message = safeErrorMessage(e, 700);
    return renderUi(
      telegramUserId,
      `❌ <b>Gagal memproses input.</b>\n\n${escapeHtml(message)}`,
      cancelKeyboard(false),
      { parse_mode: "HTML" }
    );
  }
});

/* =========================================================
   UNKNOWN CALLBACK SAFETY NET
========================================================= */

bot.on("callback_query:data", async ctx => {
  await ctx.answerCallbackQuery(
    "Menu tidak tersedia atau sudah kedaluwarsa.",
    { show_alert: true }
  ).catch(() => {});
});

/* =========================================================
   RESTORE RUNNING PROMOTIONS / SESSIONS
========================================================= */

async function restoreSessions() {
  const { data, error } = await sb
    .from("telegram_accounts")
    .select("id,status,session_string")
    .eq("status", "connected");

  if (error) throw error;

  for (const row of data || []) {
    if (!row.session_string) continue;

    try {
      const client = await clientFor(row.id);
      if (client) {
        clients.set(String(row.id), client);
      }
    } catch (e) {
      console.warn(
        `ACCOUNT ${row.id} RESTORE SESSION:`,
        safeErrorMessage(e, 250)
      );
    }
  }
}

async function restoreRunningPromotions() {
  const { data, error } = await sb
    .from("account_settings")
    .select("account_id,active,expires_at,interval_minutes")
    .eq("active", true);

  if (error) throw error;

  for (const row of data || []) {
    if (
      !row.expires_at ||
      new Date(row.expires_at) <= new Date()
    ) {
      await sb
        .from("account_settings")
        .update({
          active: false,
          expires_at: null,
          started_at: null,
        })
        .eq("account_id", row.account_id);
      continue;
    }

    // Each account gets its own independent task.
    scheduleAccount(row.account_id, 0);
  }
}

/* =========================================================
   ERROR HANDLING / BOT START
========================================================= */

bot.catch(async err => {
  const error = err?.error || err;
  console.error("BOT:", error);

  const ctx = err?.ctx;
  if (!ctx?.from?.id) return;

  const message = `❌ <b>Terjadi kesalahan menu.</b>\n\n${escapeHtml(safeErrorMessage(error, 500))}`;

  try {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery("Terjadi kesalahan.", { show_alert: true }).catch(() => {});
      await replaceUi(
        ctx,
        message,
        new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard"),
        { parse_mode: "HTML" }
      );
      return;
    }

    await renderUi(
      ctx.from.id,
      message,
      new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  } catch (uiError) {
    console.error("BOT ERROR UI:", safeErrorMessage(uiError, 300));
  }
});

const app = express();

app.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "telegram-admin-bot",
    version: BOT_VERSION
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    accountsLoaded: clients.size,
    schedulersRunning: schedulerTasks.size
  });
});

app.listen(
  Number(process.env.PORT || 3000),
  () => {
    console.log(
      `HTTP server listening on ${process.env.PORT || 3000}`
    );
  }
);

async function gracefulShutdown(signal) {
  console.log(`${signal}: shutting down without Telegram logout...`);

  for (const task of schedulerTasks.values()) {
    task.running = false;
    if (task.timeout) clearTimeout(task.timeout);
  }
  schedulerTasks.clear();

  // Intentionally disconnect local sockets only. The Telegram session is NOT logged out
  // and encrypted session remains in the database for reconnect after restart.
  for (const [accountId, client] of clients.entries()) {
    try {
      await client.disconnect();
    } catch (_) {}
    clients.delete(accountId);
  }

  process.exit(0);
}

process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

(async () => {
  try {
    await ensureBootstrapOwners();

    // Legacy import must never prevent the new bot from starting.
    // If an old table/schema differs from the expected legacy shape,
    // the warning is logged and the migration can be retried on a later restart.
    try {
      await migrateLegacyData();
    } catch (e) {
      console.error(
        "LEGACY MIGRATION WARNING:",
        safeErrorMessage(e, 800)
      );
    }

    await restoreSessions();
    await restoreRunningPromotions();
    await bot.start();
    console.log("Telegram admin bot started.");
  } catch (e) {
    console.error("FATAL:", e);
    process.exit(1);
  }
})();
