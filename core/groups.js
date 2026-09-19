bot.callbackQuery(/^promo:failures:([a-f0-9]+)$/, async ctx => {
  const adminRow = await requireAdmin(ctx);
  if (!adminRow) return;
  await ctx.answerCallbackQuery().catch(() => {});

  const report = promotionReports.get(String(ctx.match[1]));
  if (!report) {
    return replaceUi(
      ctx,
      "⚠️ <b>Data grup gagal sudah tidak tersedia.</b>\n\nJalankan promosi berikutnya untuk membuat laporan baru.",
      new InlineKeyboard().text("🏠 Menu Utama", "menu:dashboard"),
      { parse_mode: "HTML" }
    );
  }

  const account = await getAccountForAdmin(report.accountId, adminRow);
  if (!account) return;

  const lines = [
    "❌ <b>DAFTAR GROUP GAGAL</b>",
    "━━━━━━━━━━━━━━━━━━",
    `📝 <b>Format:</b> ${escapeHtml(report.formatName || "-")}`,
    `👤 <b>Username:</b> ${escapeHtml(report.accountUsername ? `@${report.accountUsername}` : "-")}`,
    `🆔 <b>ID Akun:</b> <code>${escapeHtml(report.accountTelegramId || "-")}</code>`,
    `📱 <b>Nomor:</b> <code>${escapeHtml(report.accountPhone || "-")}</code>`,
    "━━━━━━━━━━━━━━━━━━"
  ];

  if (!report.failedRows.length) {
    lines.push("<i>Tidak ada group yang gagal.</i>");
  } else {
    report.failedRows.forEach((row, index) => {
      lines.push(`${String(index + 1).padStart(2, "0")}. <b>${escapeHtml(row.groupTitle)}</b>\n   ❌ ${escapeHtml(row.reason)}`);
    });
  }

  return replaceUi(
    ctx,
    lines.join("\n\n"),
    new InlineKeyboard()
      .text("⬅️ Kembali ke Hasil", `promo:view:${report.accountId}:${report.formatId}`)
      .row()
      .text("🏠 Menu Utama", "menu:dashboard"),
    { parse_mode: "HTML" }
  );
});

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

  const dialogs = [];
  for await (const dialog of client.iterDialogs({})) dialogs.push(dialog);
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
      .eq("can_send", true)
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
  const telegramName = account.label || account.username || account.phone || "Akun Telegram";
  const username = account.username ? `@${account.username}` : "belum ada username";
  return [
    `📱 <b>AKUN TERKAIT</b>`,
    `👤 Nama: <b>${escapeHtml(telegramName)}</b>`,
    `🔗 Username: <code>${escapeHtml(username)}</code>`,
    `🆔 Telegram ID: <code>${escapeHtml(account.telegram_user_id || "belum login")}</code>`,
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

function formatDetailText(account, settings) {
  const hasText = settings?.media_type === "text" && String(settings?.message || "").trim();
  const hasPhoto = settings?.media_type === "photo" && settings?.media_file_id;
  const hasFormat = Boolean(hasText || hasPhoto);

  if (!hasFormat) {
    return [
      `📝 <b>FORMAT PROMOSI</b>`,
      `👤 Nama: <b>${escapeHtml(account.label || "Akun Telegram")}</b>`,
      "",
      "⚠️ <b>Belum ada format promosi.</b>",
      "",
      "Buat format dengan mengirim teks atau foto + caption."
    ].join("\n");
  }

  const separator = "━━━━━━━━━━━━━━━━━━";
  const body = hasText
    ? String(settings.message).trim()
    : (settings.caption ? String(settings.caption).trim() : "Foto tanpa caption");

  const bodyLimit = 2500;
  const safeBody = body.length > bodyLimit
    ? `${body.slice(0, bodyLimit)}\n… <i>(format dipotong di tampilan)</i>`
    : body;

  const scheduleLines = settings?.active
    ? [
        `🟢 <b>Status</b>: AKTIF`,
        settings?.started_at
          ? `🕐 <b>Mulai</b>: ${escapeHtml(formatDate(settings.started_at))}`
          : null,
        settings?.expires_at
          ? `🛑 <b>Stop</b>: ${escapeHtml(formatDate(settings.expires_at))}`
          : null
      ].filter(Boolean)
    : [
        `🔴 <b>Status</b>: NONAKTIF`
      ];

  return [
    `📝 <b>FORMAT PROMOSI</b>`,
    `👤 Nama: <b>${escapeHtml(account.label || "Akun Telegram")}</b>`,
    separator,
    `📄 <b>ISI FORMAT</b>`,
    hasPhoto ? "🖼️ <b>Media</b>: Foto" : "📝 <b>Media</b>: Teks",
    `<blockquote>${escapeHtml(safeBody)}</blockquote>`,
    separator,
    `⚙️ <b>PENGATURAN</b>`,
    `⏱️ <b>Jeda</b>: ${escapeHtml(formatInterval(settings?.interval_minutes))}`,
    `📅 <b>Durasi</b>: ${escapeHtml(formatDuration(settings?.duration_hours))}`,
    ...scheduleLines
  ].join("\n");
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

