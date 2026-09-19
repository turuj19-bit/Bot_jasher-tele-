async function getAccount(accountId) {
  const { data, error } = await sb
    .from("telegram_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getAccountForAdmin(accountId, adminRow) {
  const account = await getAccount(accountId);
  if (!account) return null;
  if (adminRow?.role === "OWNER") return account;
  if (String(account.created_by || "") !== String(adminRow?.telegram_user_id || "")) return null;
  return account;
}

async function requireAccountAccess(ctx, adminRow, accountId) {
  const account = await getAccountForAdmin(accountId, adminRow);
  if (account) return account;
  await ctx.answerCallbackQuery("Akun ini bukan milik admin ini.", { show_alert: true }).catch(() => {});
  return null;
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

/* =========================================================
   MULTI FORMAT STORAGE
   Formats are stored in account_settings.formats (JSONB) so the existing
   database schema stays compatible. The legacy single-format columns remain
   untouched and are imported once into "Format 1".
========================================================= */

function newFormatId() {
  return crypto.randomBytes(6).toString("hex");
}

function normalizeFormat(row = {}) {
  return {
    id: String(row.id || newFormatId()),
    name: String(row.name || "Format Baru").trim().slice(0, 60) || "Format Baru",
    media_type: row.media_type === "photo" ? "photo" : "text",
    message: String(row.message || ""),
    media_file_id: row.media_file_id || null,
    caption: row.caption || null,
    interval_minutes: Math.max(1, Number(row.interval_minutes || 10)),
    duration_hours: Math.max(1, Number(row.duration_hours || 1)),
    start_time: row.start_time || null,
    stop_time: row.stop_time || null,
    active: row.active === true,
    started_at: row.started_at || null,
    expires_at: row.expires_at || null,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function getPromotionFormats(accountId) {
  const settings = await ensureAccountSettings(accountId);
  let formats = Array.isArray(settings.formats) ? settings.formats.map(normalizeFormat) : [];

  // One-time compatibility import from the old single-format columns.
  if (!formats.length) {
    const hasLegacy =
      (settings.media_type === "text" && String(settings.message || "").trim()) ||
      (settings.media_type === "photo" && settings.media_file_id);

    if (hasLegacy) {
      formats = [normalizeFormat({
        name: "Format 1",
        media_type: settings.media_type,
        message: settings.message,
        media_file_id: settings.media_file_id,
        caption: settings.caption,
        interval_minutes: settings.interval_minutes,
        duration_hours: settings.duration_hours,
        active: settings.active === true,
        started_at: settings.started_at || null,
        expires_at: settings.expires_at || null
      })];
      await sb.from("account_settings").update({ formats }).eq("account_id", accountId);
    }
  }

  return formats;
}

async function savePromotionFormats(accountId, formats) {
  const normalized = (formats || []).map(normalizeFormat);
  const { data, error } = await sb
    .from("account_settings")
    .update({ formats: normalized })
    .eq("account_id", accountId)
    .select("*")
    .single();
  if (error) throw error;
  return Array.isArray(data.formats) ? data.formats.map(normalizeFormat) : [];
}

async function getPromotionFormat(accountId, formatId) {
  const formats = await getPromotionFormats(accountId);
  return formats.find(x => String(x.id) === String(formatId)) || null;
}

function formatReady(format) {
  return Boolean(
    (format?.media_type === "text" && String(format?.message || "").trim()) ||
    (format?.media_type === "photo" && format?.media_file_id)
  );
}

function parseTimeHHMM(value) {
  const m = String(value || "").trim().match(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  return m ? m[0] : null;
}

function timeParts(value) {
  const [h, m] = String(value).split(":").map(Number);
  return { h, m };
}

function nextFormatStartAt(format, now = new Date()) {
  const startTime = format?.start_time || null;
  const stopTime = format?.stop_time || null;

  // No time restriction: start immediately.
  if (!startTime && !stopTime) return new Date(now);

  const minutesNow = now.getHours() * 60 + now.getMinutes();

  // Start only: active from start time onward.
  if (startTime && !stopTime) {
    const start = new Date(now);
    const { h, m } = timeParts(startTime);
    const startMinutes = h * 60 + m;
    start.setHours(h, m, 0, 0);
    return minutesNow >= startMinutes ? new Date(now) : start;
  }

  // Stop only: active from midnight until stop time.
  // Once today's window has ended, wait for next midnight instead of
  // retrying every second.
  if (!startTime && stopTime) {
    const { h, m } = timeParts(stopTime);
    const stopMinutes = h * 60 + m;

    if (minutesNow <= stopMinutes) return new Date(now);

    const nextMidnight = new Date(now);
    nextMidnight.setDate(nextMidnight.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);
    return nextMidnight;
  }

  const startParts = timeParts(startTime);
  const stopParts = timeParts(stopTime);
  const startMinutes = startParts.h * 60 + startParts.m;
  const stopMinutes = stopParts.h * 60 + stopParts.m;

  // Same-day window, e.g. 08:00 - 22:00.
  if (startMinutes <= stopMinutes) {
    if (minutesNow < startMinutes) {
      const start = new Date(now);
      start.setHours(startParts.h, startParts.m, 0, 0);
      return start;
    }

    if (minutesNow <= stopMinutes) return new Date(now);

    const nextStart = new Date(now);
    nextStart.setDate(nextStart.getDate() + 1);
    nextStart.setHours(startParts.h, startParts.m, 0, 0);
    return nextStart;
  }

  // Overnight window, e.g. 22:00 - 08:00.
  if (minutesNow >= startMinutes || minutesNow <= stopMinutes) {
    return new Date(now);
  }

  const nextStart = new Date(now);
  nextStart.setHours(startParts.h, startParts.m, 0, 0);
  return nextStart;
}

function nextTimeWindowMs(startTime, stopTime, now = new Date()) {
  const startAt = nextFormatStartAt(
    { start_time: startTime || null, stop_time: stopTime || null },
    now
  );

  return Math.max(1000, startAt.getTime() - now.getTime());
}

function isWithinFormatWindow(format, now = new Date()) {
  if (!format?.start_time && !format?.stop_time) return true;
  if (format.start_time && !format.stop_time) {
    const { h, m } = timeParts(format.start_time);
    const start = new Date(now); start.setHours(h, m, 0, 0);
    return now >= start;
  }
  if (!format.start_time && format.stop_time) {
    const { h, m } = timeParts(format.stop_time);
    const stop = new Date(now); stop.setHours(h, m, 0, 0);
    return now <= stop;
  }
  const a = timeParts(format.start_time);
  const b = timeParts(format.stop_time);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = a.h * 60 + a.m;
  const stop = b.h * 60 + b.m;
  if (start <= stop) return minutes >= start && minutes <= stop;
  return minutes >= start || minutes <= stop;
}

function formatWindowLabel(format) {
  if (format?.start_time || format?.stop_time) {
    return `${format.start_time || "00:00"} - ${format.stop_time || "23:59"}`;
  }
  return "langsung";
}

function schedulerKey(accountId, formatId) {
  return `${accountId}:${formatId}`;
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

async function listAccounts(page = 0, adminRow = null) {
  const offset = page * ACCOUNT_PAGE_SIZE;
  const owner = adminRow?.role === "OWNER";

  let rowsQuery = sb
    .from("telegram_accounts")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + ACCOUNT_PAGE_SIZE);
  let countQuery = sb.from("telegram_accounts").select("*", { count: "exact", head: true });

  if (adminRow && !owner) {
    rowsQuery = rowsQuery.eq("created_by", adminRow.telegram_user_id);
    countQuery = countQuery.eq("created_by", adminRow.telegram_user_id);
  }

  const [{ data, error }, { count, error: countError }] = await Promise.all([
    rowsQuery,
    countQuery
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

