import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Google Health API -> nutrition (steps_google, kcal_google)
// GET /google-health-sync?key=SYNC_KEY[&days=7]

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_KEY     = Deno.env.get("SYNC_KEY")!;
const CLIENT_ID     = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const HEALTH = "https://health.googleapis.com/v4/users/me/dataTypes";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

function civil(d: Date) {
  return { date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } };
}

function dayString(c: any): string | null {
  const d = c?.date;
  if (!d?.year || !d?.month || !d?.day) return null;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

async function freshAccessToken(): Promise<string> {
  const res = await db("google_tokens?id=eq.1&select=refresh_token");
  const rows = await res.json();
  const refresh = rows?.[0]?.refresh_token;
  if (!refresh) throw new Error("no refresh_token stored");

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });

  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await tok.json();
  if (!tok.ok || !data.access_token) {
    throw new Error("token refresh failed: " + JSON.stringify(data));
  }

  await db("google_tokens?id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      access_token: data.access_token,
      expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });

  return data.access_token as string;
}

async function rollUp(token: string, dataType: string, start: Date, end: Date) {
  const res = await fetch(`${HEALTH}/${dataType}/dataPoints:dailyRollUp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: { start: civil(start), end: civil(end) } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${dataType}: ${JSON.stringify(data)}`);
  return Array.isArray(data?.rollupDataPoints) ? data.rollupDataPoints : [];
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== SYNC_KEY) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7), 1), 60);

  try {
    const token = await freshAccessToken();

    const end = new Date();
    end.setUTCDate(end.getUTCDate() + 1);       // exklusiv -> heute einschliessen
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days - 1);

    const [stepPoints, kcalPoints] = await Promise.all([
      rollUp(token, "steps", start, end),
      rollUp(token, "active-energy-burned", start, end),
    ]);

    const acc: Record<string, { steps_google?: number; kcal_google?: number }> = {};

    for (const p of stepPoints) {
      const day = dayString(p?.civilStartTime);
      const v = Number(p?.steps?.countSum);
      if (day && isFinite(v)) (acc[day] ??= {}).steps_google = Math.round(v);
    }
    for (const p of kcalPoints) {
      const day = dayString(p?.civilStartTime);
      const v = Number(p?.activeEnergyBurned?.kcalSum);
      if (day && isFinite(v)) (acc[day] ??= {}).kcal_google = Math.round(v);
    }

    const rows = Object.entries(acc).map(([day, v]) => ({ day, ...v }));
    if (!rows.length) return json({ ok: true, written: 0, note: "no data" });

    const up = await db("nutrition?on_conflict=day", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!up.ok) return json({ ok: false, error: await up.text() }, 500);

    return json({ ok: true, written: rows.length, days: rows.map((r) => r.day).sort() });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
