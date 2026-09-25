# Screenshots

Generated, not taken by hand:

```bash
npm run shots
```

That builds the app, serves it on a loopback origin, drives a headless Chrome
over the DevTools protocol, and writes every image in this folder. The recipes
live in [`scripts/shots.mjs`](../../scripts/shots.mjs).

| File | What it shows |
| --- | --- |
| `running.gif` | A session running, with the elapsed time and the money both climbing. |
| `projects.png` | The Work tab: every project's rate, hours and earnings under a running total. |
| `overview.png` | The Overview on a month — headline, hours, effective rate, a bar per day, a split by client. |
| `project.png` | A piece-rate project, quoting a price per accepted item and listing what was accepted. |
| `phone.png` | The Overview at phone width. |

## Two things worth knowing before you change them

**The data is invented.** Every shot is seeded from
[`docs/demo-seed.json`](../demo-seed.json) — fictional clients, fictional
rates. No screenshot here should ever be taken against a real ledger, because
a real one names real clients and prices their work.

**Your own data is never at risk.** Chrome runs against a throwaway profile in
a temp directory, on a different origin from any copy of Meter you actually
use, so the seeded storage cannot reach yours.

## When a shot comes out wrong

`node scripts/shots.mjs --probe` prints what is on screen at each step — tabs,
cards, buttons, prompts — instead of capturing anything. That is usually enough
to find the label or heading that moved. `--only=overview` re-runs a single
recipe.

Two framing choices are deliberate and will look like bugs if you change them
without knowing:

- The backup nudge is suppressed by stamping `lastBackupAt` on the fixture.
  It is telling the truth about a seed nobody has ever exported, and it is the
  first thing in every frame. Someone who has taken one backup never sees it.
- The running shots seed a session that started 47 minutes ago rather than
  clicking Start and waiting, because clicking Start and waiting photographs
  `$0.01`. Finding a live meter at boot always raises a banner — a stale
  heartbeat reads as a crash, a fresh one as a second tab — so the recipe
  answers it with **This tab only**, the way the person sitting there would.

Keep each image under about 400 KB. PNG, not JPEG: the UI is flat colour and
text, which JPEG smears.
