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

function rememberPromotionReport(report) {
  const token = crypto.randomBytes(6).toString("hex");
  promotionReports.set(token, { ...report, createdAt: Date.now() });
  while (promotionReports.size > MAX_PROMOTION_REPORTS) {
    const first = promotionReports.keys().next().value;
    if (!first) break;
    promotionReports.delete(first);
  }
  return token;
}

function promotionReportKeyboard(token, failedCount, accountId, formatId) {
  const kb = new InlineKeyboard();
  if (failedCount > 0) {
    kb.text(`🔎 Cek Grup Gagal (${failedCount})`, `promo:failures:${token}`).row();
  }
  kb.text("📝 Detail Format", `promo:view:${accountId}:${formatId}`);
  return kb;
}

async function sendPromotionReport(account, format, total, success, failed, failures) {
  const recipientId = account?.created_by;
  if (!recipientId) return;

  const admin = await getAdminByTelegramId(recipientId).catch(() => null);
  if (!admin) return;

  const failedRows = failures.map(x => ({
    groupId: x.groupId || null,
    groupTitle: x.groupTitle || "Group tanpa nama",
    reason: x.reason || "Kesalahan tidak diketahui"
  }));

  const token = rememberPromotionReport({
    accountId: String(account.id),
    formatId: String(format.id),
    accountLabel: account.label,
    accountUsername: account.username,
    accountTelegramId: account.telegram_user_id,
    accountPhone: account.phone,
    formatName: format.name,
    failedRows
  });

  const lines = [
    "📊 <b>HASIL PROMOSI</b>",
    "━━━━━━━━━━━━━━━━━━",
    `📝 <b>Format:</b> ${escapeHtml(format.name || "-")}`,
    `👤 <b>Username:</b> ${escapeHtml(account.username ? `@${account.username}` : "-")}`,
    `🆔 <b>ID Akun:</b> <code>${escapeHtml(account.telegram_user_id || "-")}</code>`,
    `📱 <b>Nomor:</b> <code>${escapeHtml(account.phone || "-")}</code>`,
    "━━━━━━━━━━━━━━━━━━",
    "📤 <b>HASIL PENGIRIMAN</b>",
    `Total group dipilih: <b>${total}</b>`,
    `Berhasil terkirim: <b>${success}</b>`,
    `Gagal: <b>${failed}</b>`
  ];

  if (failedRows.length) {
    lines.push("", "❌ <b>Ringkasan gagal:</b>");
    const counts = new Map();
    for (const row of failedRows) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
    for (const [reason, count] of counts) {
      lines.push(`• ${count} group — ${escapeHtml(reason)}`);
    }
  }

  await bot.api.sendMessage(
    Number(recipientId),
    lines.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: promotionReportKeyboard(token, failed, account.id, format.id)
    }
  ).catch(e => console.warn("PROMOTION REPORT:", safeErrorMessage(e, 220)));
}

async function fireFormat(accountId, formatId) {
  const account = await getAccount(accountId);
  const format = await getPromotionFormat(accountId, formatId);
  if (!account || !format || !format.active) return { shouldContinue: false, delayMs: 0 };

  const now = new Date();
  if (!format.expires_at || new Date(format.expires_at) <= now) {
    await stopFormat(accountId, formatId, null);
    return { shouldContinue: false, delayMs: 0 };
  }

  if (!isWithinFormatWindow(format, now)) {
    return { shouldContinue: true, delayMs: nextTimeWindowMs(format.start_time, format.stop_time) };
  }

  const client = await clientFor(accountId);
  if (!client) return { shouldContinue: true, delayMs: 120000 };

  const { data: groups, error } = await sb
    .from("account_groups")
    .select("id,telegram_group_id,title,can_send,enabled")
    .eq("account_id", accountId)
    .eq("enabled", true)
    .eq("can_send", true)
    .order("title", { ascending: true });
  if (error) throw error;

  if (!groups?.length) {
    return { shouldContinue: true, delayMs: Number(format.interval_minutes || 10) * 60000 };
  }

  const dialogs = await client.getDialogs({ limit: 500 });
  const entityMap = new Map();
  for (const dialog of dialogs) {
    const entity = dialog?.entity;
    if (!entity || (!dialog.isGroup && !dialog.isChannel)) continue;
    const id = String(entity.id?.value ?? entity.id ?? "");
    if (id) entityMap.set(id, entity);
  }

  let photoBuffer = null;
  if (format.media_type === "photo" && format.media_file_id) {
    photoBuffer = await downloadBotPhoto(format.media_file_id);
  }

  let success = 0;
  let fail = 0;
  let floodWaitMs = 0;
  const failures = [];

  for (const group of groups) {
    const target = entityMap.get(String(group.telegram_group_id));
    if (!target) {
      fail++;
      failures.push({ groupId: group.id, groupTitle: group.title, reason: "Group tidak dapat diakses" });
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: "Entity grup tidak ditemukan di dialog Telegram",
        details: { format_id: format.id, format_name: format.name }
      });
      continue;
    }

    try {
      if (format.media_type === "photo" && photoBuffer) {
        await client.sendFile(target, {
          file: photoBuffer,
          caption: format.caption || "",
          forceDocument: false
        });
      } else {
        const message = String(format.message || "").trim();
        if (!message) throw new Error("Format teks kosong.");
        await client.sendMessage(target, { message });
      }

      success++;
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        action: "promotion_send",
        status: "success",
        groupId: group.id,
        groupTitle: group.title,
        details: { format_id: format.id, format_name: format.name }
      });
    } catch (e) {
      fail++;
      const reason = classifySendError(e);
      failures.push({ groupId: group.id, groupTitle: group.title, reason });
      floodWaitMs = Math.max(floodWaitMs, extractFloodWaitMs(e));
      await recordHistory(accountId, null, {
        accountLabel: account.label,
        action: "promotion_send",
        status: "error",
        groupId: group.id,
        groupTitle: group.title,
        error: safeErrorMessage(e, 1000),
        details: { format_id: format.id, format_name: format.name, reason }
      });
    }
  }

  await sendPromotionReport(account, format, groups.length, success, fail, failures);

  return {
    shouldContinue: true,
    delayMs: Math.max(Number(format.interval_minutes || 10) * 60000, floodWaitMs),
    success,
    fail
  };
}

function scheduleFormat(accountId,formatId,delayMs=0){
  const key=schedulerKey(accountId,formatId); const old=schedulerTasks.get(key); if(old?.timeout)clearTimeout(old.timeout);
  const task={running:true,timeout:null}; schedulerTasks.set(key,task);
  task.timeout=setTimeout(async()=>{
    if(schedulerTasks.get(key)!==task||!task.running)return;
    let nextDelay=60000,cont=true;
    try{const r=await fireFormat(accountId,formatId);nextDelay=Number(r?.delayMs||60000);cont=r?.shouldContinue!==false;}catch(e){console.error(`PROMOTION ${key}:`,safeErrorMessage(e));nextDelay=60000;}
    if(schedulerTasks.get(key)!==task||!task.running)return;
    const f=await getPromotionFormat(accountId,formatId).catch(()=>null);
    if(!f?.active||!cont){schedulerTasks.delete(key);return;}
    task.timeout=setTimeout(()=>{if(schedulerTasks.get(key)!==task||!task.running)return;task.timeout=null;scheduleFormat(accountId,formatId,0);},Math.max(1000,nextDelay));
  },Math.max(0,delayMs));
}

async function startFormat(accountId,formatId,adminId){
  const account=await getAccount(accountId); if(!account)throw new Error("Account tidak ditemukan.");
  const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===String(formatId)); if(!f)throw new Error("Format tidak ditemukan.");
  if(!formatReady(f))throw new Error("Isi format belum dibuat.");
  const client=await clientFor(accountId); if(!client)throw new Error("Account belum connected atau session tidak valid.");
  const {count,error}=await sb.from("account_groups").select("*",{count:"exact",head:true}).eq("account_id",accountId).eq("enabled",true).eq("can_send",true); if(error)throw error;if(!Number(count||0))throw new Error("Belum ada target grup aktif yang bisa dikirimi.");
  const now = new Date();
  const scheduledStartAt = nextFormatStartAt(f, now);
  const durationMs = Number(f.duration_hours || 1) * 3600000;

  f.active = true;
  f.started_at = scheduledStartAt.toISOString();
  f.expires_at = new Date(
    scheduledStartAt.getTime() + durationMs
  ).toISOString();

  await savePromotionFormats(accountId, formats);
  scheduleFormat(
    accountId,
    f.id,
    Math.max(0, scheduledStartAt.getTime() - now.getTime())
  );

  await recordHistory(accountId, adminId, {
    action: "promotion_start",
    status: "success",
    details: {
      format_id: f.id,
      format_name: f.name,
      scheduled_start_at: f.started_at,
      expires_at: f.expires_at
    }
  });

  return { format: f };
}

async function stopFormat(accountId,formatId,adminId){
  const formats=await getPromotionFormats(accountId); const f=formats.find(x=>x.id===String(formatId)); if(!f)return {wasRunning:false};
  const key=schedulerKey(accountId,formatId); const task=schedulerTasks.get(key);if(task?.timeout)clearTimeout(task.timeout);schedulerTasks.delete(key);
  const wasRunning=Boolean(f.active);f.active=false;f.started_at=null;f.expires_at=null;await savePromotionFormats(accountId,formats);
  if(adminId)await recordHistory(accountId,adminId,{action:"promotion_stop",status:"success",details:{format_id:f.id,format_name:f.name,was_running:wasRunning}});
  return {wasRunning};
}

async function stopAllFormats(accountId,adminId=null){
  const formats=await getPromotionFormats(accountId); for(const f of formats){if(f.active)await stopFormat(accountId,f.id,adminId);}
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

