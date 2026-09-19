/* =========================================================
   ACCOUNT LOGIN / CONNECT
========================================================= */

// Accepts "+628123456789", "628123456789", "+62 812-3456-789", etc. and returns
// the canonical "+<digits>" form, or null when it is not a usable number.
function normalizePhone(value) {
  let raw = String(value ?? "").trim().replace(/[\s\-().]/g, "");
  if (/^\d{7,15}$/.test(raw) && !raw.startsWith("0")) raw = `+${raw}`;
  return /^\+[1-9]\d{6,14}$/.test(raw) ? raw : null;
}

// Telegram frequently invalidates a login code when the exact digits are sent
// back through Telegram itself. Admins can therefore write the OTP with
// separators ("1-2-3-4-5" / "1 2 3 4 5"); only the digits reach GramJS.
function parseLoginCode(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return { ok: false, code: "", error: "Kode OTP tidak boleh kosong." };
  }

  if (!/^[\d\s.,\-_]+$/.test(raw)) {
    return {
      ok: false,
      code: "",
      error: "Kode OTP hanya boleh berisi angka (boleh dipisah spasi atau tanda hubung)."
    };
  }

  const code = raw.replace(/\D/g, "");
  if (code.length < 4 || code.length > 8) {
    return { ok: false, code: "", error: "Kode OTP harus 4-8 digit angka." };
  }

  return { ok: true, code, error: "" };
}

function rpcErrorCode(error) {
  return String(error?.errorMessage || error?.message || "").toUpperCase();
}

function loginErrorText(error) {
  const code = rpcErrorCode(error);

  if (/PHONE_NUMBER_INVALID/.test(code)) {
    return "Nomor telepon tidak valid. Periksa kembali nomor Telegram tersebut.";
  }
  if (/PHONE_NUMBER_BANNED/.test(code)) {
    return "Nomor ini diblokir oleh Telegram.";
  }
  if (/FLOOD/.test(code)) {
    const seconds = Number(error?.seconds);
    return seconds > 0
      ? `Terlalu banyak percobaan. Coba lagi dalam ${seconds} detik.`
      : "Terlalu banyak percobaan. Tunggu beberapa saat lalu coba lagi.";
  }
  if (/PHONE_CODE_INVALID/.test(code)) {
    return "Kode OTP salah.";
  }
  if (/PHONE_CODE_EXPIRED/.test(code)) {
    return "Kode OTP kedaluwarsa atau diblokir Telegram. Saat mengirim kode, tulis dengan pemisah (contoh 1-2-3-4-5), lalu ulangi dari awal.";
  }
  if (/PASSWORD_HASH_INVALID/.test(code)) {
    return "Password 2FA salah.";
  }
  if (/API_ID_INVALID/.test(code)) {
    return "API_ID / API_HASH tidak valid. Periksa konfigurasi server.";
  }

  return safeErrorMessage(error, 300);
}

function clearLoginFlow(userKey, accountId) {
  const flow = flows.get(userKey);
  if (
    flow &&
    (flow.t === "login_code" || flow.t === "login_password") &&
    String(flow.accountId) === String(accountId)
  ) {
    flows.delete(userKey);
  }
}

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
            ? parseLoginCode(value).code
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
  const FRAME_MS = 1000;
  const MAX_ANIMATION_MS = 15 * 60 * 1000;

  // Keep the login process inside one editable UI message.
  await deleteSavedUi(userId);

  let frameIndex = 0;
  let stopped = false;
  let timer = null;
  let frameQueued = false;
  let pauseUntil = 0;
  let startedAt = Date.now();
  let message = null;
  let queue = Promise.resolve();
  let currentBody = [
    "<b>Nomor diterima</b>",
    "",
    `📱 Nomor <code>${safePhone}</code>`,
    "⏳ Menghubungkan ke Telegram...",
    "🔐 Menyiapkan sesi login..."
  ].join("\n");
  let currentKeyboard = cancelKeyboard(false);

  const buildText = frame => `${frame} ${currentBody}`;

  // Every edit goes through one queue. A late spinner frame can therefore
  // never land after (and overwrite) a final status, and edits never overlap.
  const enqueue = getText => {
    queue = queue.then(async () => {
      const text = getText();
      if (text == null || !message) return;

      try {
        await bot.api.editMessageText(chatId, message.message_id, text, {
          parse_mode: "HTML",
          reply_markup: currentKeyboard
        });
      } catch (e) {
        const raw = String(e?.message || e);
        if (/message is not modified/i.test(raw)) return;

        const retryAfter = Number(e?.parameters?.retry_after);
        if (retryAfter > 0) pauseUntil = Date.now() + retryAfter * 1000;

        console.warn("LOGIN STATUS UPDATE:", safeErrorMessage(e, 180));
      }
    });

    return queue;
  };

  const halt = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = () => {
    if (stopped || timer) return;

    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;

      // Failsafe: an animation can never outlive a stuck login.
      if (Date.now() - startedAt > MAX_ANIMATION_MS) {
        halt();
        return;
      }

      if (!frameQueued && Date.now() >= pauseUntil) {
        frameQueued = true;
        frameIndex = (frameIndex + 1) % frames.length;

        void enqueue(() => {
          frameQueued = false;
          return stopped ? null : buildText(frames[frameIndex]);
        });
      }

      tick();
    }, FRAME_MS);
  };

  message = await bot.api.sendMessage(
    chatId,
    buildText(frames[0]),
    {
      parse_mode: "HTML",
      reply_markup: currentKeyboard
    }
  );
  await saveUiMessage(userId, message, false);

  tick();

  return {
    // Change the status text while the animation keeps running.
    async update(text, keyboard = cancelKeyboard(false)) {
      if (stopped) return;
      currentBody = String(text);
      currentKeyboard = keyboard;
      await enqueue(() => (stopped ? null : buildText(frames[frameIndex])));
    },

    // Stop the animation and show a final (static) status.
    async finish(text, keyboard = cancelKeyboard(false)) {
      halt();
      currentBody = String(text);
      currentKeyboard = keyboard;
      await enqueue(() => currentBody);
    },

    // Start animating again (e.g. while an OTP is being verified).
    async restart(text, keyboard = cancelKeyboard(false)) {
      currentBody = String(text);
      currentKeyboard = keyboard;

      if (stopped) {
        stopped = false;
        frameQueued = false;
        startedAt = Date.now();
        tick();
      }

      await enqueue(() => (stopped ? null : buildText(frames[frameIndex])));
    },

    // Clears the interval. The returned promise settles once any edit that is
    // already in flight is done, so the caller can safely render over it.
    stop() {
      halt();
      return queue;
    }
  };
}

function stopLoading(loader) {
  return loader?.stop?.();
}

async function startLogin(ctx, accountId, phone, options = {}) {
  const adminTelegramId = ctx.from.id;
  const userKey = String(adminTelegramId);

  if (loginRuns.has(userKey)) {
    throw new Error("Proses login akun Telegram lain masih berjalan.");
  }

  const run = {
    accountId: String(accountId),
    client: null,
    cancelled: false,
    loader: null,
    stage: "phone",
    notice: "",
    fatalError: null
  };
  loginRuns.set(userKey, run);

  let client = null;
  let loginStatus = null;
  let sessionPersisted = false;

  try {
    client = await createTelegramClient("");
    run.client = client;

    if (run.cancelled) throw new Error("Login dibatalkan.");

    loginStatus = await startLoading(ctx, phone);
    run.loader = loginStatus;

    if (run.cancelled) throw new Error("Login dibatalkan.");

    await client.connect();

    if (run.cancelled) throw new Error("Login dibatalkan.");

    await loginStatus.update(
      [
        "<b>Terhubung ke Telegram</b>",
        "",
        `📱 Nomor <code>${escapeHtml(phone)}</code>`,
        "📩 Kode OTP sedang dikirim..."
      ].join("\n")
    );

    await client.start({
      phoneNumber: async () => phone,

      phoneCode: async isCodeViaApp => {
        if (run.cancelled) throw new Error("Login dibatalkan.");

        run.stage = "code";

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
        codePromise.catch(() => {});

        const notice = run.notice;
        run.notice = "";

        const sentTo =
          isCodeViaApp === true
            ? "📨 Kode dikirim ke aplikasi Telegram pada nomor tersebut."
            : isCodeViaApp === false
              ? "📨 Kode dikirim lewat SMS/panggilan ke nomor tersebut."
              : "📨 Periksa aplikasi Telegram (atau SMS) pada nomor tersebut.";

        await loginStatus.finish(
          [
            notice ? `⚠️ <b>${escapeHtml(notice)}</b>\n` : null,
            "✅ <b>Kode OTP Telegram sudah dikirim</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            sentTo,
            "",
            "🔑 <b>Kirim kode OTP di chat ini.</b>",
            "💡 <i>Tulis dengan pemisah, contoh 1-2-3-4-5, agar kode tidak diblokir Telegram.</i>"
          ].filter(line => line !== null).join("\n"),
          cancelKeyboard(false)
        );

        const code = await codePromise;
        const parsed = parseLoginCode(code);
        if (!parsed.ok) throw new Error(parsed.error);

        await loginStatus.restart(
          [
            "<b>Memverifikasi kode OTP...</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "🔐 Mohon tunggu sebentar."
          ].join("\n")
        );

        return parsed.code;
      },

      password: async () => {
        if (run.cancelled) throw new Error("Login dibatalkan.");

        run.stage = "password";

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
        passwordPromise.catch(() => {});

        const notice = run.notice;
        run.notice = "";

        await loginStatus.finish(
          [
            notice ? `⚠️ <b>${escapeHtml(notice)}</b>\n` : null,
            "🔐 <b>Verifikasi 2 langkah</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "Akun ini meminta password 2FA Telegram.",
            "",
            "🔑 <b>Kirim password 2FA di chat ini.</b>"
          ].filter(line => line !== null).join("\n"),
          cancelKeyboard(false)
        );

        const password = await passwordPromise;
        if (!password) {
          throw new Error("Password 2FA tidak boleh kosong.");
        }

        await loginStatus.restart(
          [
            "<b>Memverifikasi password 2FA...</b>",
            "",
            `📱 Nomor <code>${escapeHtml(phone)}</code>`,
            "🔐 Mohon tunggu sebentar."
          ].join("\n")
        );

        return password;
      },

      // GramJS calls onError for every failure inside client.start() and then
      // goes back to its auth loop unless the callback returns true. Returning
      // false for a non-recoverable error (bad phone, expired code, flood)
      // would make GramJS re-send the code / re-ask for input forever.
      onError: async error => {
        const message = safeErrorMessage(error, 300);
        console.error("LOGIN ERROR:", message);

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

        // A wrong OTP / wrong 2FA password can simply be entered again.
        if (
          (run.stage === "code" || run.stage === "password") &&
          /PHONE_CODE_INVALID|PASSWORD_HASH_INVALID|PHONE_CODE_EMPTY/.test(
            rpcErrorCode(error)
          )
        ) {
          run.notice = loginErrorText(error);
          return false;
        }

        // Everything else ends the login with the real reason.
        run.fatalError = error;
        return true;
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

    // Replace (and close) any stale client that was stored for this account.
    const previous = clients.get(String(accountId));
    if (previous && previous !== client) {
      try { await previous.disconnect(); } catch (_) {}
    }

    clients.set(String(accountId), client);
    sessionPersisted = true;
    clearLoginFlow(userKey, accountId);

    await recordHistory(accountId, options.adminId || null, {
      action: "account_connect",
      status: "success",
      details: {
        telegram_user_id: identity.telegramUserId,
        username: identity.username
      }
    });

    await stopLoading(loginStatus);

    const successText = [
      "✅ <b>Login berhasil</b>",
      "",
      `📱 Nomor <code>${escapeHtml(phone)}</code>`,
      `👤 Akun <code>${escapeHtml(derivedLabel)}</code>`,
      "🔒 Session tersimpan (terenkripsi).",
      "🟢 Status: connected",
      ""
    ].join("\n");

    // UI rendering should never undo a successfully persisted login.
    try {
      await showAccount(ctx, updated.id, successText);
    } catch (uiError) {
      console.error("LOGIN SUCCESS UI:", safeErrorMessage(uiError, 300));
      await loginStatus.finish(
        successText,
        new InlineKeyboard()
          .text("📱 Buka Akun", `account:open:${updated.id}`)
          .row()
          .text("🏠 Menu Utama", "menu:dashboard")
      );
    }
  } catch (e) {
    clearLoginFlow(userKey, accountId);

    const waiter = waiters.get(userKey);
    if (waiter?.accountId === String(accountId)) {
      waiter.reject(e);
    }

    const failure = run.fatalError || e;
    const failureMessage = safeErrorMessage(failure, 200);
    const cancelled =
      run.cancelled ||
      failureMessage === "Login dibatalkan." ||
      (failureMessage === "AUTH_USER_CANCEL" && !run.fatalError);

    await stopLoading(loginStatus);

    if (!cancelled && !sessionPersisted) {
      const failText = [
        "❌ <b>Login gagal</b>",
        "",
        `📱 Nomor <code>${escapeHtml(phone)}</code>`,
        escapeHtml(loginErrorText(failure))
      ].join("\n");

      const failKeyboard = new InlineKeyboard()
        .text(
          "🔁 Coba Lagi",
          options.deleteOnFailure
            ? "account:add"
            : `account:connect:${accountId}`
        )
        .row()
        .text("🏠 Menu Utama", "menu:dashboard");

      try {
        if (loginStatus) {
          await loginStatus.finish(failText, failKeyboard);
        } else {
          await renderUi(adminTelegramId, failText, failKeyboard, {
            parse_mode: "HTML"
          });
        }
      } catch (uiError) {
        console.error("LOGIN FAILURE UI:", safeErrorMessage(uiError, 300));
      }
    }

    // Once the session is persisted and the client is stored, never disconnect
    // it because a later UI-only operation failed.
    if (!sessionPersisted) {
      try { await client?.disconnect(); } catch (_) {}

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

    throw failure;
  } finally {
    if (loginRuns.get(userKey) === run) {
      loginRuns.delete(userKey);
    }
  }
}

// grammY handles updates one at a time. A login waits for the admin's next
// message (OTP / 2FA), so it must NOT be awaited inside the message handler:
// the handler would never return and the OTP update would stay queued behind
// it. Run it in the background instead; all errors are reported to the admin
// from startLogin() itself.
function startLoginInBackground(ctx, accountId, phone, options = {}) {
  startLogin(ctx, accountId, phone, options).catch(error => {
    console.error("LOGIN RUN:", safeErrorMessage(error, 300));
  });
}

async function connectStoredAccount(ctx, accountId, adminId) {
  const client = await clientFor(accountId);

  if (!client) return false;

  const identity = await getMeFromClient(client);
  const account = await getAccount(accountId);
  const derivedLabel =
    [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim() ||
    identity.username ||
    account?.phone ||
    "Akun Telegram";
  const { error } = await sb
    .from("telegram_accounts")
    .update({
      label: derivedLabel.slice(0, 80),
      telegram_user_id: identity.telegramUserId,
      username: identity.username || null,
      phone: account?.phone || null,
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

