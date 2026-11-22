# Operating a Meter relay

The relay is what Meter Sync passes through: one Cloudflare Worker and two
SQLite-backed Durable Objects, `VaultDO` (one per account) and `RegistryDO`
(one in total). It stores ciphertext it cannot read. This is the guide for the
person who runs one. How it works, what it can see and how it is tested is in
[ARCHITECTURE.md](../ARCHITECTURE.md#sync), and what users see is in
[FEATURES.md](../FEATURES.md#meter-sync).

Everything here runs from the repository root, on Node 24, and needs only a free
Cloudflare account. Nothing in this folder is bundled into the app.

## Deploy

```bash
npm install
npm run relay:deploy
```

One command, safe to run again. It:

1. makes the relay's two secrets, `ROUTE_KEY` and `ADMIN_TOKEN`, into
   `relay/.admin.json`, once, or reuses the ones already there;
2. signs you in to Cloudflare (a browser window opens for you to approve), only
   if this machine is not signed in;
3. deploys `relay/` with wrangler and reads the address it prints;
4. hands both secrets to Cloudflare on standard input, so they are never shown,
   never in an argument and never in your shell history;
5. saves the address for `relay:admin` and checks that admin access works.

When it finishes it prints your relay's address, `https://meter-sync.<your-name>.workers.dev`
or the name you gave `name` in `wrangler.toml`. A secret takes a few seconds to
reach the Worker, so the final check retries for a while.

**The workers.dev subdomain.** A new Cloudflare account has no `workers.dev`
subdomain yet, and wrangler cannot ask for one while its output is being read.
If the deploy stops saying so, open Workers & Pages in the Cloudflare dashboard,
choose a subdomain name, and run `npm run relay:deploy` again. That name is part
of every address the relay will ever have, so choose one you can live with.

`npm run relay:init` is the manual route: it makes the same secrets and prints
the `wrangler` commands to run by hand. Use `relay:deploy` unless you have a
reason not to.

## Keep `relay/.admin.json` safe

It holds `ROUTE_KEY` and `ADMIN_TOKEN` and the relay's address. It is git-ignored
and written readable by you only; keep it that way, and **keep a copy in a
password manager**. Cloudflare will not show a secret again, and:

- `ADMIN_TOKEN` lets whoever holds it make invites, change caps, open sign-up and
  delete accounts. It cannot read anyone's data, because there is nothing
  readable on the relay, but it can destroy it.
- `ROUTE_KEY` signs account ids. Lose it, or change it, and **every existing
  account stops resolving**: the data is still there and nobody can reach it.
  Redeploying to a new account needs the same `ROUTE_KEY`.
- **Never run `relay:init --force` on a relay that has accounts.** It makes new
  secrets, which orphans every one of them. It exists for a relay that has never
  been used.
- Never paste either secret into an issue, a chat or a commit, and never into
  the app: nothing in the app asks for them.

`relay/.dev.vars`, if you use it for `wrangler dev`, holds the same two names and
is git-ignored as well.

## Invites

An account is made with a single-use, expiring invite, so the relay creates
nothing for strangers.

```bash
npm run relay:admin -- invite --label "Sara" --days 7
npm run relay:admin -- invites
npm run relay:admin -- revoke-invite <id>
```

`invite` prints the code (`MTR-` and twenty characters), the same code typed with
dashes, a link, and the invite's id. The code is shown **once**: the relay keeps
only a hash. Send the link (it ends in a `#invite=...&relay=...` fragment, which
no server ever receives) or the code. `--label` is for you, so you can tell
invites apart; it is stored in the clear, so someone who can read `invites` can
link a label to the account it made. `--days` defaults to 7. The link points at
the Pages site that hosts the app; use `--app <url>` or `METER_APP_URL` for a
self-hosted copy. `invites` lists each as active, used, expired or revoked, and
revoking one already used does nothing: delete the account instead.

## Stats

```bash
npm run relay:admin -- stats
```

Accounts against the cap, whether open sign-up is on, and per account: status,
created, last seen, devices, stored size and writes today. It never shows
content, because every blob on the relay is encrypted. The relay asks each
account on demand, so looking costs a little and nothing runs in the background.
Use it in the first weeks to see how close you are to the free allowances, and
watch GB-s in the Cloudflare dashboard, which is the figure the arithmetic is
least sure about.

`delete-vault <id>` removes an account and all its data for good (it asks first;
`--yes` skips the question). The devices keep their own ledgers and are told the
next time they connect.

## Caps and open sign-up

```bash
npm run relay:admin -- caps
npm run relay:admin -- config set maxVaults=40 vaultBytesCap=100MB
npm run relay:admin -- open on      # and: open off
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxVaults` | 25 | accounts the relay holds at once |
| `vaultBytesCap` | 50 MB | stored bytes per account |
| `dailyCreationCap` | 50 | accounts open sign-up may create a day, in all |
| `ipDailyCap` | 3 | accounts open sign-up may create a day, per address |
| `openSignup` | off | anyone who knows the address may make an account |

Settings change without a redeploy, and an account notices within about five
minutes. The defaults can also be set in `wrangler.toml` under `[vars]` (names in
capitals, `MAX_VAULTS` and so on); an admin call overrides them. Two limits are
not settings: 2,000 writes a day and 6 devices per account.

**Open sign-up** is off for a reason. With it on, anyone who finds the address
can use up your free allowance and your account cap, though only three a day
per address and fifty in all. Turn it on for a short while if you must, and off
again. A privacy policy, terms and a contact are what a public relay needs and
this one does not have.

The free plan's daily allowances (100,000 requests, 100,000 rows written and so on)
are shared by every account on the relay. If they run out, Cloudflare fails
operations until 00:00 UTC and does not bill you; every device shows the same
paused state and nothing is lost. Plan for **25 to 50 regular users**, measure,
and raise `maxVaults` only afterwards. Workers Paid ($5 a month) needs no code
change; keep the caps on, because they are what bound the bill.

## Trying it without Cloudflare

```bash
npm run relay:local
```

The real relay on `http://127.0.0.1:8788`, with its data in your temp directory,
for development only. It prints throwaway secrets and an invite, and refuses
WebSockets (the app falls back to syncing on open and on its poll). It is never
part of a deploy.

## Checks that stay manual

The tests run the Worker's code in Node with the Durable Object runtime
stood in for. They cannot show real hibernation, the real `wss://` upgrade, CORS
from the Pages origin or a phone's installed app. After deploying, create an
account from the Pages app, pair a second device, and stop a meter on one to see
it stop on the other.
