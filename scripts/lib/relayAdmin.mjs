/**
 * Logic of `npm run relay:admin`, apart from the terminal, the disk and the
 * network (all injected), so the commands run against the real Worker in a test
 * with no network at all.
 *
 * The admin sees counts, sizes, times and ids, and never content: every blob on
 * the relay is ciphertext. Nothing here asks for or prints anything else.
 */
import { checkRelayUrl, formatInvite, inviteLink } from "../../src/sync/codes.js";

/** Where an invite link points: the Pages site that hosts the app. Overridable
 *  with --app or METER_APP_URL, for a self-hosted copy. */
export const DEFAULT_APP_URL = "https://ahmed41022.github.io/meter/";

export class AdminError extends Error {
  /** @param kind "usage" (the command was wrong), "relay" (the relay said no) or "network" */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "AdminError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// ----------------------------------------------------------------- the relay

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

/** What the relay's answer means for the person at the keyboard. */
export function explain(status, body = {}) {
  const field = body.field ? ` (the "${body.field}" field)` : "";
  switch (body.code) {
    case "auth":
      return "The relay refused the admin token. Check relay/.admin.json (or METER_ADMIN_TOKEN) and that the ADMIN_TOKEN secret was set on the relay.";
    case "admin_disabled":
      return "Admin is switched off on the relay: its ADMIN_TOKEN secret is missing or too short. Set it with npx wrangler secret put ADMIN_TOKEN.";
    case "rate":
      return `Too many wrong tokens in a row. The relay asks you to wait about ${minutes(body.retryAfterMs ?? 15 * 60_000)} minutes.`;
    case "bad_request":
      return `The relay did not accept that request${field}.`;
    case "no_invite":
      return "No invite has that id. List them with: relay:admin -- invites";
    case "invite_used":
      return "That invite was already used, so revoking it would change nothing. Delete the vault it made instead, if that is what you want.";
    case "no_vault":
      return "The relay has no vault with that id. List them with: relay:admin -- stats";
    case "unsupported_media_type":
      return "The relay wants JSON and this request was not. This is a bug in the admin tool.";
    case "too_large":
      return "The request was larger than the relay accepts.";
    case "method_not_allowed":
    case "not_found":
      return "The relay does not know that address. Is the relay URL right, and is the deployed Worker up to date (npx wrangler deploy)?";
    case "overloaded":
      return "The relay is over its limits right now. Try again in a little while.";
    case "internal":
      return "The relay failed internally (HTTP 500). Check its logs: npx wrangler tail --config relay/wrangler.toml";
    default:
      return `The relay answered HTTP ${status}${body.code ? ` (${body.code})` : ""}.`;
  }
}

/** A thin, typed front for the admin endpoints. `fetch` is injected. */
export function createAdminClient({ fetch, url, token }) {
  const base = checkRelayUrl(url);
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}/v1/admin${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new AdminError("network", `Could not reach ${base}: ${e?.cause?.code ?? e?.message ?? "no answer"}. Check the address and your connection.`);
    }
    let parsed = {};
    try { parsed = await res.json(); } catch {
      if (res.ok) throw new AdminError("relay", `${base} did not answer like a Meter relay. Is the address right?`);
    }
    if (!res.ok) throw new AdminError("relay", explain(res.status, parsed), { status: res.status, code: parsed.code });
    return parsed;
  }
  return {
    base,
    invite: (b) => call("POST", "/invite", b),
    invites: () => call("GET", "/invites"),
    revokeInvite: (id) => call("POST", "/revoke-invite", { id }),
    stats: () => call("GET", "/stats"),
    deleteVault: (vaultId) => call("POST", "/delete-vault", { vaultId }),
    config: () => call("GET", "/config"),
    setConfig: (changes) => call("POST", "/config", changes),
  };
}

// ----------------------------------------------------------------- formatting

export const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

/** UTC, to the minute: unambiguous in a log and the same on every machine. */
export const fmtTime = (ms) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z` : "-");

/** Columns padded to the widest cell; the header underlined. Numbers align right. */
export function table(headers, rows, { right = [] } = {}) {
  const cells = [headers, ...rows.map((r) => r.map((c) => String(c ?? "-")))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (right.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map((r) => line(r.map((c) => String(c ?? "-"))))];
}

// ----------------------------------------------------------------- arguments

const BOOLEAN_FLAGS = new Set(["yes", "help"]);
const VALUE_FLAGS = new Set(["label", "days", "app"]);

/** `["invite", "--label", "Sara"]` -> `{ words: ["invite"], flags: { label: "Sara" } }`. */
export function parseArgs(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { words.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new AdminError("usage", `Unknown option --${name}.`);
    const v = inline ?? argv[++i];
    if (v === undefined) throw new AdminError("usage", `--${name} needs a value.`);
    flags[name] = v;
  }
  return { words, flags };
}

const CONFIG_HELP = {
  openSignup: "anyone may create a vault without an invite (on|off)",
  maxVaults: "vaults the relay will hold at once",
  vaultBytesCap: "stored bytes allowed per vault",
  dailyCreationCap: "vaults that open signup may create per day, in all",
  ipDailyCap: "vaults that open signup may create per day, per address",
};

/** `50MB`, `1gb`, `2048` -> bytes. Only for the size setting. */
const parseSize = (text) => {
  const m = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(text);
  if (!m) return NaN;
  return Number(m[1]) * ({ kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? "b").toLowerCase()] ?? 1);
};

const parseOnOff = (text) => {
  const t = String(text).toLowerCase();
  if (["on", "true", "yes", "1"].includes(t)) return true;
  if (["off", "false", "no", "0"].includes(t)) return false;
  return null;
};

/** `maxVaults=40 vaultBytesCap=100MB` -> `{ maxVaults: 40, vaultBytesCap: 104857600 }`. */
export function parseConfigPairs(pairs) {
  if (!pairs.length) throw new AdminError("usage", "config set needs key=value pairs, for example: config set maxVaults=40");
  const out = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = at < 0 ? pair : pair.slice(0, at);
    const raw = at < 0 ? "" : pair.slice(at + 1);
    if (!(key in CONFIG_HELP)) throw new AdminError("usage", `Unknown setting "${key}". The settings are: ${Object.keys(CONFIG_HELP).join(", ")}.`);
    if (at < 0 || raw === "") throw new AdminError("usage", `"${key}" needs a value: ${key}=...`);
    if (key === "openSignup") {
      const v = parseOnOff(raw);
      if (v === null) throw new AdminError("usage", "openSignup takes on or off.");
      out[key] = v;
    } else {
      const n = key === "vaultBytesCap" ? parseSize(raw) : /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(n)) throw new AdminError("usage", `${key} takes a whole number${key === "vaultBytesCap" ? " (bytes, or a size like 50MB)" : ""}.`);
      out[key] = n;
    }
  }
  return out;
}

// ----------------------------------------------------------------- commands

export const HELP = [
  "Usage: npm run relay:admin -- <command>",
  "",
  "  invite [--label NAME] [--days N]   make an invite (default 7 days) and print its code and link",
  "  invites                            list invites and whether each is active, used, expired or revoked",
  "  revoke-invite <id>                 cancel an invite that has not been used",
  "  stats                              vaults, sizes, devices, last seen, writes today (never any content)",
  "  delete-vault <id> [--yes]          delete a vault and all its data (asks first)",
  "  config                             show the relay's settings",
  "  config set key=value ...           change settings, for example maxVaults=40 vaultBytesCap=100MB",
  "  open on|off                        allow vault creation without an invite",
  "  caps                               show the limits and how to change them",
  "  set-url <https://...>              remember the relay's address",
  "",
  "The address and admin token come from relay/.admin.json, or from the",
  "METER_RELAY_URL and METER_ADMIN_TOKEN environment variables.",
];

/**
 * Runs one command. Returns the exit code (0 done, 1 the relay or network said
 * no, 2 the command was wrong) and never throws for those.
 *
 * @param argv      the words after the script name
 * @param makeClient  () -> an admin client; called only by commands that need
 *                    the relay, so `help` and `set-url` work with no token yet
 * @param out       (line) normal output
 * @param err       (line) problems
 * @param confirm   async (question) -> boolean, or null when there is no one to ask
 * @param saveUrl   (url) -> void, persists the relay address
 */
export async function runAdmin(argv, {
  makeClient, out, err, confirm = null, saveUrl = () => {}, appUrl = DEFAULT_APP_URL,
}) {
  try {
    const { words, flags } = parseArgs(argv);
    const [command, ...rest] = words;
    if (!command || command === "help" || flags.help) { HELP.forEach((l) => out(l)); return command || flags.help ? 0 : 2; }
    const app = flags.app ?? appUrl;

    switch (command) {
      case "set-url": {
        if (rest.length !== 1) throw new AdminError("usage", "set-url takes the relay's address: set-url https://meter-sync.example.workers.dev");
        let url;
        try { url = checkRelayUrl(rest[0]); } catch (e) { throw new AdminError("usage", e.message); }
        saveUrl(url);
        out(`The relay address is now ${url}`);
        return 0;
      }

      case "invite": {
        const body = {};
        if (flags.label !== undefined) body.label = flags.label;
        if (flags.days !== undefined) {
          if (!/^\d+$/.test(flags.days)) throw new AdminError("usage", "--days takes a whole number of days, 1 to 365.");
          body.days = Number(flags.days);
        }
        const client = makeClient();
        const made = await client.invite(body);
        out(`Invite made${made.label ? ` for "${made.label}"` : ""}, valid until ${fmtTime(made.expiresAt)}.`);
        out("The code is shown this once; the relay keeps only a hash of it.");
        out("");
        out(`  code   ${made.code}`);
        out(`  typed  ${formatInvite(made.code)}`);
        out(`  link   ${inviteLink(app, made.code, client.base)}`);
        out(`  id     ${made.id}   (for revoke-invite)`);
        return 0;
      }

      case "invites": {
        const { invites } = await makeClient().invites();
        if (!invites.length) { out("No invites yet. Make one with: relay:admin -- invite --label NAME"); return 0; }
        table(["id", "label", "status", "created", "expires", "used"], invites.map((i) => [
          i.id, i.label || "-", i.status, fmtTime(i.createdAt), fmtTime(i.expiresAt), fmtTime(i.usedAt),
        ])).forEach((l) => out(l));
        return 0;
      }

      case "revoke-invite": {
        if (rest.length !== 1) throw new AdminError("usage", "revoke-invite takes an invite id (from: invites).");
        await makeClient().revokeInvite(rest[0]);
        out(`Invite ${rest[0]} is revoked.`);
        return 0;
      }

      case "stats": {
        const s = await makeClient().stats();
        const live = s.perVault.filter((v) => v.status === "active");
        out(`Vaults: ${s.vaults.count} of ${s.vaults.max}   Open signup: ${s.open ? "ON" : "off"}   Created today (open signup): ${s.creationsToday}`);
        out("");
        if (!s.perVault.length) { out("No vaults yet."); return 0; }
        table(["vault", "status", "created", "last seen", "devices", "size", "writes today"], s.perVault.map((v) => [
          v.id, v.status, fmtTime(v.createdAt), fmtTime(v.seenAt ?? v.lastSeenAt), v.devices ?? "-",
          v.bytes === undefined ? "-" : fmtBytes(v.bytes), v.writesToday ?? "-",
        ]), { right: [4, 5, 6] }).forEach((l) => out(l));
        const bytes = live.reduce((n, v) => n + (v.bytes ?? 0), 0);
        out("");
        out(`Total stored: ${fmtBytes(bytes)} in ${live.length} vault${live.length === 1 ? "" : "s"}. Contents are encrypted and not visible here.`);
        return 0;
      }

      case "delete-vault": {
        if (rest.length !== 1) throw new AdminError("usage", "delete-vault takes a vault id (from: stats).");
        if (!flags.yes) {
          if (!confirm) throw new AdminError("usage", "This deletes a vault for good and needs a yes. Run it in a terminal to be asked, or add --yes.");
          const yes = await confirm(`Delete vault ${rest[0]}? Its data is removed from the relay and cannot be brought back; devices keep their own copies. [y/N] `);
          if (!yes) { out("Nothing was deleted."); return 0; }
        }
        await makeClient().deleteVault(rest[0]);
        out(`Vault ${rest[0]} is deleted. Its devices will be told the next time they connect.`);
        return 0;
      }

      case "config": {
        const client = makeClient();
        if (rest[0] === "set") {
          const next = await client.setConfig(parseConfigPairs(rest.slice(1)));
          out("Saved. The relay's settings are now:");
          printConfig(next, out);
          return 0;
        }
        if (rest.length) throw new AdminError("usage", "config takes no arguments, or: config set key=value ...");
        printConfig(await client.config(), out);
        return 0;
      }

      case "open": {
        const on = rest.length === 1 ? parseOnOff(rest[0]) : null;
        if (on === null) throw new AdminError("usage", "open takes on or off.");
        const cfg = await makeClient().setConfig({ openSignup: on });
        out(on
          ? `Open signup is ON: anyone who knows the relay's address can create a vault, up to ${cfg.ipDailyCap} per address and ${cfg.dailyCreationCap} in all per day. Turn it off again with: open off`
          : "Open signup is off: a new vault needs an invite.");
        return 0;
      }

      case "caps": {
        const cfg = await makeClient().config();
        out(`Vaults held at once     ${cfg.maxVaults}`);
        out(`Stored bytes per vault  ${fmtBytes(cfg.vaultBytesCap)}`);
        out(`Open-signup creations   ${cfg.dailyCreationCap} a day in all, ${cfg.ipDailyCap} per address`);
        out("");
        out("Change with, for example: relay:admin -- config set maxVaults=40 vaultBytesCap=100MB");
        return 0;
      }

      default:
        throw new AdminError("usage", `Unknown command "${command}". Run: relay:admin -- help`);
    }
  } catch (e) {
    if (!(e instanceof AdminError)) throw e;
    err(e.message);
    return e.kind === "usage" ? 2 : 1;
  }
}

function printConfig(cfg, out) {
  for (const key of Object.keys(CONFIG_HELP)) {
    const v = key === "openSignup" ? (cfg[key] ? "on" : "off") : key === "vaultBytesCap" ? `${cfg[key]} (${fmtBytes(cfg[key])})` : cfg[key];
    out(`  ${key.padEnd(17)} ${String(v).padEnd(24)} ${CONFIG_HELP[key]}`);
  }
}
