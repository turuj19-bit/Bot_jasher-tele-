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

