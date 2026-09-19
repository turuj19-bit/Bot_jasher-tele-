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
    // Stop the spinner first so no late frame overwrites the menu below.
    await stopLoading(run.loader);
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

    // OTP may be written with separators (1-2-3-4-5); only digits are used.
    const parsedCode = waiter.type === "code"
      ? parseLoginCode(ctx.message.text)
      : null;
    const text = waiter.type === "code"
      ? parsedCode.code
      : ctx.message.text.trim();

    if (waiter.type === "code" && !parsedCode.ok) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}

      return renderUi(
        telegramUserId,
        `❌ ${escapeHtml(parsedCode.error)}\n\n🔑 <b>Kirim ulang kode OTP di chat ini.</b>\n💡 <i>Contoh penulisan: 1-2-3-4-5</i>`,
        cancelKeyboard(false),
        { parse_mode: "HTML" }
      );
    }

    if (!text) {
      return renderUi(
        telegramUserId,
        "❌ Password 2FA tidak boleh kosong.",
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
    if (flow.accountId && !["account_phone", "account_phone_new"].includes(flow.t)) {
      const owned = await getAccountForAdmin(flow.accountId, adminRow);
      if (!owned) {
        flows.delete(userKey);
        return renderUi(telegramUserId, "⛔ Akun tersebut bukan milik admin ini.", backDashboardKeyboard(), { parse_mode: "HTML" });
      }
    }

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

      const phone = normalizePhone(ctx.message.text);
      if (!phone) {
        return renderUi(
          telegramUserId,
          "❌ Nomor tidak valid. Gunakan format internasional, contoh <code>+628123456789</code>.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      if (loginRuns.has(userKey)) {
        return renderUi(
          telegramUserId,
          "⏳ Proses login akun Telegram lain masih berjalan. Selesaikan atau batalkan dulu.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      // Keep the chat clean: the number is now shown in the status message.
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}

      const account = await createAccountShell("Menunggu login", adminRow.telegram_user_id, phone);
      flows.delete(userKey);

      // Do not await: the login must stay free to receive the OTP message.
      startLoginInBackground(ctx, account.id, phone, {
        adminId: adminRow.id,
        deleteOnFailure: true
      });
      return;
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

      const phone = normalizePhone(ctx.message.text);
      if (!phone) {
        return renderUi(
          telegramUserId,
          "❌ Nomor tidak valid. Gunakan format internasional.",
          cancelKeyboard(false)
        );
      }

      if (loginRuns.has(userKey)) {
        return renderUi(
          telegramUserId,
          "⏳ Proses login akun Telegram lain masih berjalan. Selesaikan atau batalkan dulu.",
          cancelKeyboard(false),
          { parse_mode: "HTML" }
        );
      }

      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (_) {}

      flows.delete(userKey);

      // Do not await: the login must stay free to receive the OTP message.
      startLoginInBackground(ctx, flow.accountId, phone, {
        adminId: adminRow.id,
        deleteOnFailure: false
      });
      return;
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
       FORMAT NAME ADD
    -------------------------- */
    if (flow.t === "format_add_name") {
      const name = String(ctx.message.text || "").trim().replace(/\s+/g," ").slice(0,60);
      if (name.length < 2) return renderUi(telegramUserId,"❌ Nama format terlalu pendek.",cancelKeyboard(false));
      const formats = await getPromotionFormats(flow.accountId);
      const format = normalizeFormat({id:newFormatId(),name});
      formats.push(format);
      await savePromotionFormats(flow.accountId,formats);
      flows.set(userKey,{t:"format",accountId:flow.accountId,formatId:format.id,adminId:flow.adminId});
      return renderUi(telegramUserId,`✅ Format <b>${escapeHtml(name)}</b> dibuat.\n\nSekarang kirim isi format: teks atau foto + caption.`,cancelKeyboard(false),{parse_mode:"HTML"});
    }

    /* -------------------------
       FORMAT CONTENT
    -------------------------- */
    if (flow.t === "format") {
      const formats = await getPromotionFormats(flow.accountId);
      const format = formats.find(x=>x.id===String(flow.formatId));
      if(!format) { flows.delete(userKey); return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan."); }
      if (ctx.message.photo?.length) {
        const photo=ctx.message.photo[ctx.message.photo.length-1];
        format.media_type="photo"; format.message=""; format.media_file_id=photo.file_id; format.caption=ctx.message.caption||"";
      } else if (ctx.message.text) {
        const message=ctx.message.text.trim();
        if(!message)return renderUi(telegramUserId,"❌ Format teks tidak boleh kosong.",cancelKeyboard(false));
        format.media_type="text"; format.message=message; format.media_file_id=null; format.caption=null;
      } else return renderUi(telegramUserId,"❌ Format tidak didukung. Kirim teks atau foto.",cancelKeyboard(false));
      format.updated_at=new Date().toISOString();
      await savePromotionFormats(flow.accountId,formats);
      await recordHistory(flow.accountId,adminRow.id,{action:"format_update",status:"success",details:{format_id:format.id,format_name:format.name,type:format.media_type}});
      flows.delete(userKey);
      return renderFormatDetail(ctx,flow.accountId,format.id,"✅ Isi format berhasil disimpan.");
    }

    /* -------------------------
       FORMAT DELAY
    -------------------------- */
    if (flow.t === "delay") {
      const minutes=parseMinutes(ctx.message.text);
      if(!minutes)return renderUi(telegramUserId,"❌ Jeda tidak valid. Contoh: <code>10 menit</code> atau <code>1 jam</code>.",cancelKeyboard(false),{parse_mode:"HTML"});
      const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
      if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
      f.interval_minutes=minutes; f.updated_at=new Date().toISOString(); await savePromotionFormats(flow.accountId,formats);
      flows.delete(userKey); return renderFormatDetail(ctx,flow.accountId,f.id,`✅ Jeda disimpan: <b>${escapeHtml(formatInterval(minutes))}</b>`);
    }

    /* -------------------------
       FORMAT DURATION
    -------------------------- */
    if (flow.t === "duration") {
      const hours=parseHours(ctx.message.text);
      if(!hours)return renderUi(telegramUserId,"❌ Durasi tidak valid. Contoh: <code>3 hari</code> atau <code>12 jam</code>.",cancelKeyboard(false),{parse_mode:"HTML"});
      const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
      if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
      f.duration_hours=hours; if(f.active)f.expires_at=new Date(Date.now()+hours*3600000).toISOString(); f.updated_at=new Date().toISOString();
      await savePromotionFormats(flow.accountId,formats); flows.delete(userKey); return renderFormatDetail(ctx,flow.accountId,f.id,`✅ Durasi disimpan: <b>${escapeHtml(formatDuration(hours))}</b>`);
    }

    /* -------------------------
       FORMAT TIME WINDOW
    -------------------------- */
    if (flow.t === "time") {
      const raw=String(ctx.message.text||"").trim();
      if(raw === "00:00 - 00:00") {
        const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
        if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
        f.start_time=null;f.stop_time=null;f.updated_at=new Date().toISOString();await savePromotionFormats(flow.accountId,formats);flows.delete(userKey);return renderFormatDetail(ctx,flow.accountId,f.id,"✅ Waktu dijadikan tanpa batas.");
      }
      const m=raw.match(/^\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/);
      const a=parseTimeHHMM(m?.[1]), b=parseTimeHHMM(m?.[2]);
      if(!a||!b)return renderUi(telegramUserId,"❌ Format waktu salah. Contoh: <code>08:00 - 22:00</code>.",cancelKeyboard(false),{parse_mode:"HTML"});
      const formats=await getPromotionFormats(flow.accountId); const f=formats.find(x=>x.id===String(flow.formatId));
      if(!f)return renderFormatList(ctx,flow.accountId,"❌ Format tidak ditemukan.");
      f.start_time=a;f.stop_time=b;f.updated_at=new Date().toISOString();await savePromotionFormats(flow.accountId,formats);flows.delete(userKey);return renderFormatDetail(ctx,flow.accountId,f.id,`✅ Waktu disimpan: <b>${a} - ${b}</b>`);
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
  const {data,error}=await sb.from("telegram_accounts").select("id");
  if(error)throw error;
  for(const row of data||[]){
    const formats=await getPromotionFormats(row.id);
    for(const f of formats){
      if(!f.active)continue;
      if(!f.expires_at||new Date(f.expires_at)<=new Date()){await stopFormat(row.id,f.id,null);continue;}
      scheduleFormat(row.id,f.id,0);
    }
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

  // Stop unfinished interactive logins (spinner timers + temporary clients).
  for (const run of loginRuns.values()) {
    run.cancelled = true;
    try { await run.loader?.stop?.(); } catch (_) {}
    try { await run.client?.disconnect(); } catch (_) {}
  }
  loginRuns.clear();

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
    await bot.start({
      onStart: info => {
        console.log(`Telegram admin bot started as @${info?.username || "bot"}.`);
      }
    });
  } catch (e) {
    console.error("FATAL:", e);
    process.exit(1);
  }
})();
