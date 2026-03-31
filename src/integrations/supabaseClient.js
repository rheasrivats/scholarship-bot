import { createClient } from "@supabase/supabase-js";

let cachedAdminClient = null;
let cachedPublicClient = null;

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function getSupabaseConfig() {
  const url = firstNonEmpty(process.env.SUPABASE_URL);
  const publishableKey = firstNonEmpty(
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY
  );
  const secretKey = firstNonEmpty(
    process.env.SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  return {
    url,
    publishableKey,
    secretKey,
    configured: Boolean(url && secretKey)
  };
}

export function getSupabaseAdminClient() {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return null;
  }

  if (!cachedAdminClient) {
    cachedAdminClient = createClient(config.url, config.secretKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return cachedAdminClient;
}

export function getSupabasePublicClient() {
  const config = getSupabaseConfig();
  if (!config.url || !config.publishableKey) {
    return null;
  }

  if (!cachedPublicClient) {
    cachedPublicClient = createClient(config.url, config.publishableKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return cachedPublicClient;
}

export async function getSupabaseStatus() {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return {
      configured: false,
      connected: false,
      reason: "Missing SUPABASE_URL and/or server key",
      url: config.url || null,
      hasPublishableKey: Boolean(config.publishableKey),
      hasServerKey: Boolean(config.secretKey)
    };
  }

  const client = getSupabaseAdminClient();
  try {
    const { error } = await client
      .from("scholarships")
      .select("id", { count: "exact", head: true });

    if (!error) {
      return {
        configured: true,
        connected: true,
        reason: "Connected",
        url: config.url,
        hasPublishableKey: Boolean(config.publishableKey),
        hasServerKey: true
      };
    }

    // Relation missing still means credentials/network are valid.
    if (error.code === "42P01") {
      return {
        configured: true,
        connected: true,
        reason: "Connected, but scholarships table not found yet",
        url: config.url,
        hasPublishableKey: Boolean(config.publishableKey),
        hasServerKey: true
      };
    }

    return {
      configured: true,
      connected: false,
      reason: error.message || "Query failed",
      url: config.url,
      hasPublishableKey: Boolean(config.publishableKey),
      hasServerKey: true
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      reason: error.message || String(error),
      url: config.url,
      hasPublishableKey: Boolean(config.publishableKey),
      hasServerKey: true
    };
  }
}
