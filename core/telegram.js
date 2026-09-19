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
   PROMOTION FAILURE REPORT
========================================================= */

