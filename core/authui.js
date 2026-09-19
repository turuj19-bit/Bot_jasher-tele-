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

      // Let the caller decide how to re-create the message (e.g. with banner).
      if (options.sendFallback === false) return false;
    }
  }

  const msg = await bot.api.sendMessage(userId, text, extra);
  await saveUiMessage(userId, msg, false);
}

async function replaceUi(ctx, text, keyboard, options = {}) {
  // Every menu owns exactly one UI message. Opening another menu removes the
  // previous panel first, so the chat does not fill up with stale menus.
  await deleteSavedUi(ctx.from.id);
  const extra = { reply_markup: keyboard };
  if (options.parse_mode) extra.parse_mode = options.parse_mode;
  const msg = await bot.api.sendMessage(ctx.chat?.id || ctx.from.id, text, extra);
  await saveUiMessage(ctx.from.id, msg, false);
  return msg;
}

async function renderStart(ctx, text, keyboard) {
  const userId = ctx.from.id;

  return withUiLock(userId, async () => {
    // Main panel is a fresh banner panel; remove the previous menu first.
    await deleteSavedUi(userId);
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
        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (!contentType.startsWith("image/")) {
          throw new Error(`URL bukan file gambar (content-type: ${contentType || "unknown"})`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) throw new Error("File banner kosong.");
        if (buffer.length > 10 * 1024 * 1024) throw new Error("File banner terlalu besar.");

        const msg = await ctx.replyWithPhoto(new InputFile(buffer, "start-banner.jpg"), {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard
        });
        await saveUiMessage(userId, msg, true);
        return msg;
      } catch (e) {
        console.error("START BANNER URL:", safeErrorMessage(e));
      }
    }

    const msg = await bot.api.sendMessage(userId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
    await saveUiMessage(userId, msg, false);
    return msg;
  });
}

function dashboardText(ctx, stats, extra = "", role = "") {
  const first = String(ctx.from?.first_name || "").trim();
  const last = String(ctx.from?.last_name || "").trim();
  const name = [first, last].filter(Boolean).join(" ") || "Admin";
  const username = ctx.from?.username ? `@${ctx.from.username}` : "-";
  const roleLabel = role ? (role === "OWNER" ? "OWNER" : "ADMIN") : "";
  const rule = "━━━━━━━━━━━━━━━━━━";

  const intro =
    extra ||
    "Silakan pilih menu di bawah untuk mengatur akun Telegram, format promosi, target grup, dan pengaturan lainnya.";

  // Every value that may be copied sits in its own <code> element, so a single
  // tap copies just that value (never one big block).
  return [
    "🎛️ <b>PANEL KONTROL</b>",
    rule,
    `👤 <b>Nama: ${escapeHtml(name)}</b>`,
    `🆔 ID Telegram · <code>${escapeHtml(ctx.from.id)}</code>`,
    `🔗 Username · <code>${escapeHtml(username)}</code>`,
    roleLabel ? `🎖️ Role · <code>${roleLabel}</code>` : null,
    `🤖 Versi bot · <code>v${escapeHtml(BOT_VERSION)}</code>`,
    rule,
    `<blockquote>✨ <b>Panel sesuai akun Telegram yang digunakan.</b>\n${escapeHtml(intro)}</blockquote>`,
    "",
    "📊 <b>STATUS SISTEM</b>",
    `👥 Admin aktif · <b>${stats.admins}</b>`,
    `📱 Akun Telegram · <b>${stats.accounts}</b>`,
    `🟢 Terhubung · <b>${stats.connected}</b>`,
    `▶️ Promosi berjalan · <b>${stats.running}</b>`,
    `🎯 Target grup aktif · <b>${stats.groups}</b>`,
    rule,
    "⬇️ <b>MENU UTAMA</b>"
  ].filter(line => line !== null).join("\n");
}

async function getDashboardStats(adminRow = null) {
  const isOwner = adminRow?.role === "OWNER";
  let accountIds = null;

  if (adminRow && !isOwner) {
    const { data, error } = await sb
      .from("telegram_accounts")
      .select("id")
      .eq("created_by", adminRow.telegram_user_id);
    if (error) throw error;
    accountIds = (data || []).map(x => x.id);
  }

  const accountsQuery = sb.from("telegram_accounts").select("*", { count: "exact", head: true });
  const connectedQuery = sb.from("telegram_accounts").select("*", { count: "exact", head: true }).eq("status", "connected");

  if (accountIds !== null) {
    accountsQuery.eq("created_by", adminRow.telegram_user_id);
    connectedQuery.eq("created_by", adminRow.telegram_user_id);
  }

  const groupsQuery = accountIds === null
    ? sb.from("account_groups").select("*", { count: "exact", head: true }).eq("enabled", true).eq("can_send", true)
    : accountIds.length
      ? sb.from("account_groups").select("*", { count: "exact", head: true }).eq("enabled", true).eq("can_send", true).in("account_id", accountIds)
      : null;

  const settingsQuery = accountIds === null
    ? sb.from("account_settings").select("formats")
    : accountIds.length
      ? sb.from("account_settings").select("formats").in("account_id", accountIds)
      : null;

  const [admins, accounts, connected, groups, settingsRows] = await Promise.all([
    sb.from("admins").select("*", { count: "exact", head: true }).eq("active", true),
    accountsQuery,
    connectedQuery,
    groupsQuery || Promise.resolve({ data: [], count: 0, error: null }),
    settingsQuery || Promise.resolve({ data: [], error: null })
  ]);

  for (const r of [admins, accounts, connected, groups, settingsRows]) {
    if (r.error) throw r.error;
  }

  const running = (settingsRows.data || []).reduce(
    (n, row) => n + (Array.isArray(row.formats) ? row.formats.filter(f => f?.active).length : 0),
    0
  );

  return {
    admins: Number(admins.count || 0),
    accounts: Number(accounts.count || 0),
    connected: Number(connected.count || 0),
    running,
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
  kb.text("📊 Status", `account:status:${account.id}`).row();
  kb.text("⚙️ Pengaturan", `account:settings:${account.id}`).row();
  if (account.status === "connected") kb.text("🔌 Putus", `account:disconnect:${account.id}`);
  else kb.text("🔗 Hubungkan", `account:connect:${account.id}`);
  kb.row();
  kb.text("👥 Grup", `group:list:${account.id}:0`).row();
  kb.text("➕ Tambah Grup", `group:add:${account.id}`).row();
  kb.text("📝 Format", `promo:list:${account.id}:0`).row();
  kb.text("➕ Format Baru", `promo:add:${account.id}`).row();
  kb.text("▶️ Format Aktif", `promo:active:${account.id}:0`).row();
  kb.text("⏹ Stop Promosi", `promo:stopall:${account.id}`).row();
  kb.text("📋 Riwayat", `history:list:${account.id}:0`).row();
  kb.text("🏷️ Nama", `account:label:${account.id}`).row();
  kb.text("🗑️ Hapus", `account:remove:${account.id}`).row();
  kb.text("⬅️ Kembali", "accounts:list:0");
  return kb;
}

function settingsMenu(accountId) {
  return new InlineKeyboard()
    .text("🏷️ Label", `account:label:${accountId}`).row()
    .text("📝 Format", `promo:list:${accountId}:0`).row()
    .text("➕ Tambah Format", `promo:add:${accountId}`).row()
    .text("⬅️ Kembali", `account:open:${accountId}`);
}

function formatListKeyboard(formats, accountId, page = 0) {
  const kb = new InlineKeyboard();
  for (const f of formats) {
    const icon = f.active ? "🟢" : "⚪";
    kb.text(`${icon} ${safeButtonText(f.name, 30)}`, `promo:view:${accountId}:${f.id}`).row();
  }
  kb.text("➕ Tambah Format", `promo:add:${accountId}`).row();
  kb.text("⬅️ Kembali", `account:open:${accountId}`);
  return kb;
}

function activeFormatKeyboard(formats, accountId) {
  const kb = new InlineKeyboard();
  for (const f of formats.filter(x => x.active)) {
    kb.text(`🟢 ${safeButtonText(f.name, 28)}`, `promo:view:${accountId}:${f.id}`).row();
  }
  kb.text("⬅️ Kembali", `account:open:${accountId}`);
  return kb;
}

function formatDetailKeyboard(accountId, format) {
  const kb = new InlineKeyboard();
  kb.text("✏️ Edit Format", `promo:edit:${accountId}:${format.id}`).row();
  kb.text("⏱️ Atur Jeda", `promo:delay:${accountId}:${format.id}`).row();
  kb.text("📅 Atur Durasi", `promo:duration:${accountId}:${format.id}`).row();
  kb.text("🕐 Atur Waktu", `promo:time:${accountId}:${format.id}`).row();
  if (format.active) kb.text("⏹️ Stop", `promo:stop:${accountId}:${format.id}`);
  else kb.text("▶️ Mulai", `promo:start:${accountId}:${format.id}`);
  kb.row();
  kb.text(format.active ? "🔴 Nonaktif" : "🟢 Aktif", `promo:toggle:${accountId}:${format.id}`).row();
  kb.text("🗑️ Hapus Format", `promo:delete:${accountId}:${format.id}`).row();
  kb.text("⬅️ Kembali", `promo:list:${accountId}:0`);
  return kb;
}

function groupListKeyboard(rows, accountId, page, hasNext) {
  const kb = new InlineKeyboard();

  // Only groups/channels Telegram reports as writable are shown as targets.
  // Tapping the group name itself toggles the target state.
  for (const group of rows.filter(g => g.can_send)) {
    const icon = group.enabled ? "✅" : "❌";
    kb.text(`${icon} ${safeButtonText(group.title, 34)}`, `group:toggle:${group.id}:${page}`).row();
  }

  if (page > 0) kb.text("◀️", `group:list:${accountId}:${page - 1}`);
  kb.text("🏠", "menu:dashboard");
  if (hasNext) kb.text("▶️", `group:list:${accountId}:${page + 1}`);
  kb.row();
  kb.text("➕ Tambah Semua Grup", `group:all:${accountId}`).row();
  kb.text("🔄 Deteksi Grup", `group:refresh:${accountId}`).row();
  kb.text("⬅️ Akun", `account:open:${accountId}`);

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

