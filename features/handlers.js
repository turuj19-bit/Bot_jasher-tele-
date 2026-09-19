async function showAccount(ctx, accountId, prefixMessage = "") {
  const { account, settings } = await getAccountBundle(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  const formats = await getPromotionFormats(accountId);
  const activeCount = formats.filter(x => x.active).length;
  const name = account.label || account.username || account.phone || "Akun Telegram";
  const message = [
    prefixMessage,
    `📱 <b>AKUN TELEGRAM</b>`,
    `👤 Nama: <b>${escapeHtml(name)}</b>`,
    `🔗 Username: <code>${escapeHtml(account.username ? `@${account.username}` : "-")}</code>`,
    `🆔 ID: <code>${escapeHtml(account.telegram_user_id || "-")}</code>`,
    `🟢 Koneksi: <b>${escapeHtml(account.status || "-")}</b>`,
    `📝 Format: <b>${formats.length}</b>`,
    `▶️ Format aktif: <b>${activeCount}</b>`,
    `🎯 Target aktif: <b>${formats.length >= 0 ? "dibagi bersama akun ini" : "-"}</b>`
  ].filter(Boolean).join("\n");
  return replaceUi(ctx, message, accountMenu(account, settings), { parse_mode: "HTML" });
}

async function renderFormatDetail(ctx, accountId, formatId, prefixMessage = "") {
  const account = await getAccount(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  const format = await getPromotionFormat(accountId, formatId);
  if (!format) return replaceUi(ctx, "❌ Format tidak ditemukan.", new InlineKeyboard().text("⬅️ Kembali", `promo:list:${accountId}:0`), { parse_mode: "HTML" });
  const body = format.media_type === "photo"
    ? (format.caption || "Foto tanpa caption")
    : (format.message || "Format teks kosong");
  const message = [
    prefixMessage,
    `📝 <b>FORMAT: ${escapeHtml(format.name)}</b>`,
    "━━━━━━━━━━━━━━━━━━",
    "📄 <b>ISI FORMAT</b>",
    format.media_type === "photo" ? "🖼️ Media: Foto" : "📝 Media: Teks",
    `<blockquote>${escapeHtml(String(body).slice(0, 2500))}</blockquote>`,
    "━━━━━━━━━━━━━━━━━━",
    "⚙️ <b>PENGATURAN</b>",
    `⏱️ Jeda: <b>${escapeHtml(formatInterval(format.interval_minutes))}</b>`,
    `📅 Durasi: <b>${escapeHtml(formatDuration(format.duration_hours))}</b>`,
    `🕐 Waktu: <b>${escapeHtml(formatWindowLabel(format))}</b>`,
    `🟢 Status: <b>${format.active ? "AKTIF" : "NONAKTIF"}</b>`
  ].filter(Boolean).join("\n");
  return replaceUi(ctx, message, formatDetailKeyboard(accountId, format), { parse_mode: "HTML" });
}

async function renderFormatList(ctx, accountId, prefixMessage = "") {
  const account = await getAccount(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  const formats = await getPromotionFormats(accountId);
  const lines = [prefixMessage, `📝 <b>FORMAT PROMOSI</b>`, `👤 ${escapeHtml(account.label || "Akun Telegram")}`, "", formats.length ? `Total format: <b>${formats.length}</b>` : "Belum ada format."];
  return replaceUi(ctx, lines.filter(Boolean).join("\n"), formatListKeyboard(formats, accountId), { parse_mode: "HTML" });
}

/* =========================================================
   CHAT LOADING ANIMATION
   Menu loading is shown as an animated message in the chat itself.
   No loading text is sent through Telegram's callback notification/toast.
========================================================= */

async function startChatLoading(ctx, title = "Memproses menu...") {
  const chatId = ctx.chat?.id || ctx.from?.id;
  const frames = ["[░░░░░░░░░░]", "[██░░░░░░░░]", "[████░░░░░░]", "[██████░░░░]", "[████████░░]", "[██████████]"];
  const frameMs = 350;
  let index = 0;
  let stopped = false;
  let timer = null;
  let message = null;
  let queue = Promise.resolve();

  const body = () => `⏳ <b>${escapeHtml(title)}</b>\n${frames[index]}`;
  const edit = () => {
    queue = queue.then(async () => {
      if (stopped || !message) return;
      try {
        await bot.api.editMessageText(chatId, message.message_id, body(), { parse_mode: "HTML" });
      } catch (_) {}
    });
    return queue;
  };

  message = await bot.api.sendMessage(chatId, body(), { parse_mode: "HTML" });

  const tick = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      if (index < frames.length - 1) {
        index += 1;
        await edit();
        tick();
      }
    }, frameMs);
  };
  tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await queue.catch(() => {});
      if (message) {
        try { await bot.api.deleteMessage(chatId, message.message_id); } catch (_) {}
      }
    }
  };
}

// Put a real animated loader in the chat for callback/menu actions. The
// callback answer itself stays empty, so Telegram's small top notification
// never shows messages such as "Memuat..." or "Scanning...".
bot.on("callback_query", async (ctx, next) => {
  const data = String(ctx.callbackQuery?.data || "");
  if (data === "flow:cancel" || data === "admin:cancel") return next();

  let loader = null;
  try {
    loader = await startChatLoading(ctx, "Memproses menu");
    return await next();
  } finally {
    await loader?.stop?.();
  }
});

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

    const stats = await getDashboardStats(adminRow).catch(() => ({
      admins: 0,
      accounts: 0,
      connected: 0,
      running: 0,
      groups: 0
    }));

    // /start always returns to a clean state: drop any half-finished input
    // flow (label, format, ...). Login flows were already handled above.
    flows.delete(userKey);

    const text = dashboardText(ctx, stats, "", adminRow.role);
    const menu = adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu();
    const rendered = await renderStart(ctx, text, menu);

    // Remove the "/start" command itself so the chat only keeps the dashboard.
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (_) {}

    return rendered;
  } catch (e) {
    console.error("START:", safeErrorMessage(e));
    return ctx.reply("❌ Terjadi kesalahan saat membuka dashboard.");
  }
});

bot.callbackQuery("menu:dashboard", async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const stats = await getDashboardStats(adminRow).catch(() => ({
    admins: 0,
    accounts: 0,
    connected: 0,
    running: 0,
    groups: 0
  }));

  const menu = adminRow.role === "OWNER" ? ownerDashboardMenu() : adminDashboardMenu();
  return renderStart(ctx, dashboardText(ctx, stats, "", adminRow.role), menu);
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
    const result = await listAccounts(rawPage, adminRow);
    const page = ensurePage(rawPage, Math.floor(Math.max(0, result.total - 1) / ACCOUNT_PAGE_SIZE));

    // Re-load if the requested page was beyond current max.
    const current = page === rawPage ? result : await listAccounts(page, adminRow);

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
    "➕ <b>KAITKAN AKUN TELEGRAM</b>\n\nMasukkan <b>nomor HP Telegram</b> dari akun yang ingin kamu kaitkan ke bot.\n\nSetelah login berhasil, <b>nama, username, dan Telegram ID</b> akan diambil otomatis dari akun tersebut. Nama akun di panel tidak akan memakai nama nomor lagi.\n\n📱 Contoh: <code>+628123456789</code>\n\n🔐 <i>Kode OTP/2FA akan diproses melalui chat ini.</i>",
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:open:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return showAccount(ctx, accountId);
});

bot.callbackQuery(/^account:status:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return showAccount(ctx, accountId);
});

/* =========================================================
   ACCOUNT CONNECT / DISCONNECT / REMOVE
========================================================= */

bot.callbackQuery(/^account:connect:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
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
    "📱 <b>KAITKAN ULANG AKUN TELEGRAM</b>\n\nMasukkan <b>nomor HP Telegram</b> akun yang ingin dikaitkan kembali.\n\nNama akun akan disesuaikan otomatis dengan identitas Telegram setelah login berhasil.\n\n📱 Contoh: <code>+628123456789</code>",
    cancelKeyboard(false),
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^account:disconnect:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;

  try {
    await stopScheduler(accountId);
    await stopAllFormats(accountId, adminRow.id);
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
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
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
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
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
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
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
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
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

bot.callbackQuery(/^promo:list:(\d+):\d+$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return renderFormatList(ctx, accountId);
});

bot.callbackQuery(/^promo:add:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);
  if (!account) return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), {parse_mode:"HTML"});
  flows.set(String(ctx.from.id), { t:"format_add_name", accountId, adminId:adminRow.id });
  return replaceUi(ctx, `➕ <b>TAMBAH FORMAT</b>\n\nMasukkan <b>nama format</b>.\nContoh: <code>PROMO NOKOS</code>`, cancelKeyboard(false), {parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:view:(\d+):([^:]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  return renderFormatDetail(ctx, accountId, String(ctx.match[2]));
});

bot.callbackQuery(/^promo:edit:(\d+):([^:]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const format=await getPromotionFormat(accountId, formatId);
  if(!format) return renderFormatList(ctx, accountId, "❌ Format tidak ditemukan.");
  flows.set(String(ctx.from.id), {t:"format", accountId, formatId, adminId:adminRow.id});
  return replaceUi(ctx, `✏️ <b>EDIT FORMAT: ${escapeHtml(format.name)}</b>\n\nKirim teks atau foto + caption baru.`, cancelKeyboard(false), {parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:delete:(\d+):([^:]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const formats=await getPromotionFormats(accountId);
  const format=formats.find(x=>x.id===formatId);
  if(!format) return renderFormatList(ctx, accountId, "❌ Format tidak ditemukan.");
  await stopFormat(accountId, formatId, adminRow.id).catch(()=>{});
  await savePromotionFormats(accountId, formats.filter(x=>x.id!==formatId));
  await recordHistory(accountId, adminRow.id, {action:"format_delete",status:"success",details:{format_id:formatId,format_name:format.name}});
  return renderFormatList(ctx, accountId, `🗑️ Format <b>${escapeHtml(format.name)}</b> dihapus.`);
});

bot.callbackQuery(/^promo:active:(\d+):\d+$/, async ctx => {
  const adminRow = await requireAdmin(ctx); if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId=String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const formats=await getPromotionFormats(accountId);
  const active=formats.filter(x=>x.active);
  return replaceUi(ctx, `▶️ <b>FORMAT AKTIF</b>\n\n${active.length ? active.map(x=>`🟢 <b>${escapeHtml(x.name)}</b>\n⏱ ${escapeHtml(formatInterval(x.interval_minutes))}\n📅 ${escapeHtml(formatDuration(x.duration_hours))}\n🕐 ${escapeHtml(formatWindowLabel(x))}`).join("\n\n") : "Tidak ada format yang sedang aktif."}`, activeFormatKeyboard(active,accountId), {parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:delay:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return; const f=await getPromotionFormat(accountId,formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  flows.set(String(ctx.from.id),{t:"delay",accountId,formatId,adminId:adminRow.id});
  return replaceUi(ctx,`⏱️ <b>ATUR JEDA</b>\n\nFormat: <b>${escapeHtml(f.name)}</b>\nContoh: <code>10 menit</code> atau <code>1 jam</code>.`,cancelKeyboard(false),{parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:duration:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return; const f=await getPromotionFormat(accountId,formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  flows.set(String(ctx.from.id),{t:"duration",accountId,formatId,adminId:adminRow.id});
  return replaceUi(ctx,`📅 <b>ATUR DURASI</b>\n\nFormat: <b>${escapeHtml(f.name)}</b>\nContoh: <code>3 hari</code> atau <code>12 jam</code>.`,cancelKeyboard(false),{parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:time:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]), formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return; const f=await getPromotionFormat(accountId,formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  flows.set(String(ctx.from.id),{t:"time",accountId,formatId,adminId:adminRow.id});
  return replaceUi(ctx,`🕐 <b>ATUR WAKTU</b>\n\nFormat: <b>${escapeHtml(f.name)}</b>\nKirim: <code>08:00 - 22:00</code>\nAtau <code>00:00 - 00:00</code> untuk tanpa batas waktu.`,cancelKeyboard(false),{parse_mode:"HTML"});
});

bot.callbackQuery(/^promo:toggle:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]),formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return; const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===formatId);
  if(!f)return renderFormatList(ctx,accountId,"❌ Format tidak ditemukan.");
  if(f.active) await stopFormat(accountId,formatId,adminRow.id); else await startFormat(accountId,formatId,adminRow.id);
  return renderFormatDetail(ctx,accountId,formatId,f.active?"🔴 Format dinonaktifkan.":"🟢 Format diaktifkan.");
});

/* =========================================================
   FORMAT START / STOP
========================================================= */

bot.callbackQuery(/^promo:stopall:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  try {
    await stopAllFormats(accountId, adminRow.id);
    return showAccount(ctx, accountId, "⏹️ <b>Semua promosi dihentikan.</b>");
  } catch (e) {
    return showAccount(ctx, accountId, `❌ ${escapeHtml(safeErrorMessage(e))}`);
  }
});

bot.callbackQuery(/^promo:start:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]),formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  try { const r=await startFormat(accountId,formatId,adminRow.id); return renderFormatDetail(ctx,accountId,formatId,`▶️ <b>Format ${escapeHtml(r.format.name)} dimulai.</b>`); }
  catch(e){ return renderFormatDetail(ctx,accountId,formatId,`❌ ${escapeHtml(safeErrorMessage(e))}`); }
});

bot.callbackQuery(/^promo:stop:(\d+):([^:]+)$/, async ctx => {
  const adminRow=await requireAdmin(ctx); if(!adminRow)return; await ctx.answerCallbackQuery().catch(()=>{});
  const accountId=String(ctx.match[1]),formatId=String(ctx.match[2]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  try { const r=await stopFormat(accountId,formatId,adminRow.id); return renderFormatDetail(ctx,accountId,formatId,r.wasRunning?"⏹️ <b>Format dihentikan.</b>":"ℹ️ Format tidak sedang aktif."); }
  catch(e){ return renderFormatDetail(ctx,accountId,formatId,`❌ ${escapeHtml(safeErrorMessage(e))}`); }
});

/* =========================================================
   GROUP MANAGEMENT
========================================================= */

bot.callbackQuery(/^group:list:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
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
            `${g.enabled ? "✅" : "❌"} <b>${escapeHtml(g.title)}</b>`
          ).join("\n\n")
        : "<i>Belum ada grup yang terdeteksi. Tekan Tambah Target / Deteksi Ulang.</i>",
      "",
      "Tekan nama grup untuk memilih / membatalkan target."
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

bot.callbackQuery(/^group:add:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);
  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    const rows = await refreshGroups(accountId);
    const allowed = rows.filter(x => x.can_send);
    await recordHistory(accountId, adminRow.id, {
      action: "group_scan_add",
      status: "success",
      details: { detected: rows.length, allowed: allowed.length }
    });

    return renderGroupPageDirect(
      ctx,
      accountId,
      0,
      `🔎 <b>GRUP TERDETEKSI</b>\n\n${allowed.length} grup yang bisa menerima pesan tersedia. Tekan nama grup untuk memilih target.`
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Deteksi grup gagal.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("◀️ Account", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^group:refresh:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
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

    return renderGroupPageDirect(ctx, accountId, 0, `🔎 Deteksi selesai. ${rows.length} grup/channel terbaca dan diperbarui.`);
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
          `${g.enabled ? "✅" : "❌"} <b>${escapeHtml(g.title)}</b>`
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

bot.callbackQuery(/^group:toggle:(\d+):(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  const groupId = String(ctx.match[1]);
  const page = Math.max(0, Number(ctx.match[2] || 0));
  const group = await sb
    .from("account_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle();

  if (group.error || !group.data) {
    return ctx.answerCallbackQuery("Grup tidak ditemukan.", { show_alert: true });
  }

  if (!await requireAccountAccess(ctx, adminRow, String(group.data.account_id))) return;

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

  return renderGroupPageDirect(ctx, group.data.account_id, page);
});

/* Add/select all writable groups for this account in one action. */
bot.callbackQuery(/^group:all:(\d+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;

  await ctx.answerCallbackQuery().catch(() => {});
  const accountId = String(ctx.match[1]);
  if (!await requireAccountAccess(ctx, adminRow, accountId)) return;
  const account = await getAccount(accountId);
  if (!account) {
    return replaceUi(ctx, "❌ Account tidak ditemukan.", backDashboardKeyboard(), { parse_mode: "HTML" });
  }

  try {
    // Scan first so newly detected writable groups are included too.
    const rows = await refreshGroups(accountId);
    const allowed = rows.filter(x => x.can_send);

    if (allowed.length) {
      const { error } = await sb
        .from("account_groups")
        .update({ enabled: true })
        .eq("account_id", accountId)
        .eq("can_send", true);
      if (error) throw error;
    }

    await recordHistory(accountId, adminRow.id, {
      action: "group_enable_all",
      status: "success",
      details: { detected: rows.length, enabled: allowed.length }
    });

    return renderGroupPageDirect(
      ctx,
      accountId,
      0,
      `✅ <b>Semua grup ditambahkan.</b>\n\n${allowed.length} grup yang bisa menerima pesan sekarang aktif sebagai target.`
    );
  } catch (e) {
    return replaceUi(
      ctx,
      `❌ Gagal menambahkan semua grup.\n\n${escapeHtml(safeErrorMessage(e))}`,
      new InlineKeyboard().text("⬅️ Akun", `account:open:${accountId}`),
      { parse_mode: "HTML" }
    );
  }
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

  if (!await requireAccountAccess(ctx, adminRow, String(group.account_id))) return;

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

