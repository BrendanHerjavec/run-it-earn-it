/**
 * Manage the Strava push subscription (one per Strava app).
 *
 *   npm run strava:webhook -- view
 *   npm run strava:webhook -- create [callbackUrl]   default: $APP_BASE_URL/api/strava/webhook
 *   npm run strava:webhook -- delete <id>
 *
 * `create` makes Strava immediately GET the callback with a challenge, so the
 * app must already be reachable at that public URL.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

const API = "https://www.strava.com/api/v3/push_subscriptions";

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET");
  const auth = { client_id: clientId, client_secret: clientSecret };

  if (cmd === "view") {
    const res = await fetch(`${API}?${new URLSearchParams(auth)}`);
    console.log(res.status, await res.text());
  } else if (cmd === "create") {
    const verifyToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
    if (!verifyToken) throw new Error("Set STRAVA_WEBHOOK_VERIFY_TOKEN");
    const callbackUrl = arg ?? `${process.env.APP_BASE_URL}/api/strava/webhook`;
    if (!callbackUrl.startsWith("https://")) console.warn(`Warning: ${callbackUrl} is not https; Strava needs a public URL.`);
    const res = await fetch(API, {
      method: "POST",
      body: new URLSearchParams({ ...auth, callback_url: callbackUrl, verify_token: verifyToken }),
    });
    console.log(res.status, await res.text());
  } else if (cmd === "delete" && arg) {
    const res = await fetch(`${API}/${arg}?${new URLSearchParams(auth)}`, { method: "DELETE" });
    console.log(res.status, await res.text());
  } else {
    console.error("usage: strava-webhook view | create [callbackUrl] | delete <id>");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
