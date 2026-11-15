# dsh-npie-modeguide

Not sure which of DeepSeek Harness's four Agent presets (Standard / PTC / Minimal /
Creative) fits your task? Describe the task in one sentence and this plugin recommends
one, with **two verifiable sentences** explaining why.

- **Capability table** — parsed from the installed kernel's real preset YAML into a build-time baseline, with a silent live refresh; refreshable after a DSH upgrade.
- **Explainable, tiered decision** — local rules first, one model call only for genuine ambiguity, and two sentences whose capability facts are computed from the current table.
- **One-click apply on new sessions** — uses the official `agentPresets.select` remote; running sessions get advice instead of a button that is bound to fail.

## The problem

The four preset descriptions are abstract. Three common misconceptions:

- "A simple task should use Minimal." **No** — Minimal exists for clean baseline comparisons, not convenience.
- "Batch data processing always needs a different mode." **Depends on your default** — the built-in default PTC already ships the `execute` code-mode tool, so with PTC as your default nothing needs to change. Only after you switch the new-task default to Standard does "process a batch of files" become a verdict for PTC (the plugin follows your default; see "New-task default").
- "Creative has the most features, so it is best." **Not accurate** — it has no Office tools.

## Is there a simpler way?

Yes. The four presets differ on only a few tools, so there are just **four** situations
that genuinely require a mode change: writing plugins (Creative), workflow fan-out
(Standard), clean baselines (Minimal), and processing a batch of files (PTC). Most of the
time you do not need a decision at all:

> **Leave it alone by default; Creative only for writing plugins; Standard for workflow fan-out; Minimal only for clean baselines.**

Batch processing is deliberately left out of the mnemonic: it depends on your new-task
default — with PTC as the default nothing changes, and only after you switch the default
to Standard does it become a switch. That is also why it sits last in the decision table
and needs corroborating evidence before it holds.

This rule of thumb is also shown in the plugin's panel. Auto-detection mainly lowers the
psychological barrier for new users; it does not improve accuracy, because whatever you
set as the new-task default (usually PTC) already covers most tasks.

A typical case: **"I want to write a poem" → leave it alone, stay on your current
new-task default.** If you picked Standard as the default, the verdict is Standard, not
PTC. Writing a poem is pure text generation; none of the 13 capabilities that differ
between presets (file I/O, web search, subagents, workflow, `execute`, Office, editing
DSH itself, plugin management, …) is required by it, and the extra capabilities in other
modes are not needed here. This verdict is decided locally, without waiting for a model.

## Are there similar projects on GitHub?

Yes. Search and re-verification on 2026-11-15:

| Project | What it does | Boundary |
|---|---|---|
| StephenXiong001/dsh-task-mode-switch | Composer toolbar switch; AUTO picks one of four presets from draft keywords | 1 star, newly created; four modes hard-coded; engines pinned to a kernel version |
| framefutura/dsh-mode-seat | Persistent mode selector, can set a default for new tasks | No AUTO; only "choose", never "which to choose" |
| LeemanCheung/dsh-agent-preset-recommender | Recommends presets from past activity | Based on history, not the current task text |
| yjh051108/dsh-routing-suite | Routes reasoning styles (spec/react/mixed) | Not the four Agent presets; requires an injector |

The kernel has no such capability: `modeSelectionEnabled` is a deprecated field that the
docs explicitly say is neither read nor written. This plugin is not a duplicate: it does
not hard-code capability differences (the composition is parsed from the installed
kernel's preset YAML, with a build-time baseline and optional live refresh), explains
its reasoning, and pins no kernel version.

## Decision principle

The engine does not classify "what kind of task this is"; it asks **which tool exclusive
to one mode the task needs**. Those tool differences are the only legitimate reason to
switch.

Measured differences (parsed from the current presets; the live table has 13 differing
rows, this is the 8 that matter most when choosing):

| Capability | Minimal | Standard | PTC | Creative |
|---|---|---|---|---|
| File read/write | ✗ | ✓ | ✓ | ✓ |
| Web search | ✗ | ✓ | ✓ | ✓ |
| Subagents | ✗ | ✓ | ✓ | ✓ |
| Workflow | ✗ | ✓ | **✗** | ✓ |
| `execute` code mode | ✗ | ✗ | **✓** | ✗ |
| Office documents | ✗ | ✓ | ✓ | **✗** |
| Edit DSH itself | ✗ | ✗ | ✗ | **✓** |
| Plugin manager | ✗ | ? | ✗ | ? |

`?` means the preset attaches a `!!js` platform condition that cannot be evaluated
statically; it depends on the environment, and the in-panel table shows `?` too. An
earlier version of this table wrote `✓` here, mistaking "conditional" for "definitely on".

## Decision pipeline

Two judges, cheapest first. *Local* means a pure function inside the plugin: no network,
no model. *Model review* means one request the host sends on your behalf.

```mermaid
flowchart TD
    A[What you typed] --> B[Local rules: four signal tiers<br/>pinned / decisive / partial / weak<br/>offline · milliseconds]
    B -->|one pinned tool| C[Decided on the spot]
    B -->|one decisive feature<br/>or two partial signals in one mode| C
    B -->|troubleshooting / explaining words| D[Stay on the current default<br/>no model request at all]
    B -->|hints only, nothing decisive| D
    B -->|two modes decisive<br/>or too short / not installed| E[Model review<br/>one host call, bounded by timeoutMs]
    E -->|valid JSON back| F[Replace verdict, mark "model review"]
    E -->|timeout / bad JSON / out of quota| G[Keep the local verdict and say why]
```

The local layer does not guess a task type; it answers one question: **does this task
require a tool only one mode has?** Signals are tiered by "could another mode still do
this job?":

| Tier | Decides on | Examples | Meaning |
|---|---|---|---|
| `pinned` names the tool | one hit | "write a plugin", "use a workflow" | An instruction; outranks everything else |
| `strong` decisive feature | one hit | "batch process", "batch rename", "process all in one go" | The word itself means no other mode can do it |
| `support` partial evidence | **two hits in the same mode** (a weak hint counts half) | "count", "rename", "dedupe", "workflow" | Part of a capability, not the whole of it |
| `weak` direction hint | never | "tidy up", "spreadsheet", "panel" | Corroboration only |

Plus a **composite rule**: an action word (add / edit / write / remove) and a DSH-internal
object (panel / preset / shortcut / theme) inside the same short span means "modify DSH
itself". Either half alone means nothing — "add some salt" or "this panel is too big"
must not switch modes.

The same rule also governs "traverse" for PTC: it is **not** a decisive feature. Walking a
JSON object or an array is ordinary programming that Standard's bash already does; only
"traverse + directory / all files / this batch" makes it an `execute` case. A blind test
first judged "walk this JSON to see its shape" as PTC, and this downgrade fixed it.

**Why `support` needs two hits**: 0.1.x decided on a single word, so "how many rows does
this table have?" was judged as PTC — "count" really is part of the capability, but
Standard's bash already does it, and `execute` is not needed. The verdict was wrong while
the reason cited a true capability distribution, which is the most deceptive failure mode
there is. A single hint now only gives direction and decides nothing.

There is also a **reverse word list**: troubleshooting and "explain the current state"
phrasings (error, not working, why, fix, debug) push straight back to the default mode and
**skip the model entirely**. The word "plugin" in "my plugin stopped working" is a strong
signal, but that sentence asks for debugging, not for writing a plugin.

Negation works in English too (`don't use workflow`, including the curly `don’t`), and
anything shorter than 4 characters counts as too little information.

There are exactly three outcomes:

1. **Decided** — one pinned tool, one `strong` feature, or two `support` signals in the
   same mode.
2. **Stay on the current default** — nothing decisive, or a reverse word hit. That is
   "settled as no switch needed", not ambiguity, so no model call.
3. **Model review** — two modes are both decisive ("this plugin should batch-process these
   files"), the text is too short, or the mode is not installed.

Model review is not free-form: the host sends the current default, the 13-row capability
table and five rules (prefer not switching / never switch to look smart / **troubleshooting
never switches** / answer with one line of JSON), with `maxTokens` 200 and
`temperature: 0`. The reply is validated strictly: `mode` must be one of the preset ids,
`confidence` is clamped to 0.5–0.85, and bad JSON, timeouts or exhausted quota all count
as "no verdict". The example value is a placeholder (`<one of: …>`) rather than a concrete
mode — otherwise the model tends to copy it back (anchoring bias), so "should switch but
didn't" and the UI cannot show it.

**Order of operations** (the moment you click "Give a suggestion"):

1. Local rules run **synchronously**; verdict, two sentences and table appear right away,
   with no remote call;
2. In parallel, two unrelated background jobs run: live capability-table refresh and a
   default-mode re-check;
3. Only the third outcome sends one model request in the background, bounded by
   `timeoutMs` (default 20000, plus a 2s margin, floored at 6s);
4. When it returns, the verdict is replaced and marked "model review"; on failure the
   local verdict stays and the reason is stated.

The merge order is hard-coded: **decided by rules > model verdict > default mode**. The
model can never overrule a verdict the rules already decided — something you stated
outright ("write a plugin") should not be changed by a model call. With a single hint the
verdict is also the default mode, but the reason says so explicitly ("hints only, not
enough to justify switching"), so it is not dressed up as a finding. The cost is that a
wrong local verdict cannot be rescued by the model; see Known limitations.

## Accuracy: getting it right is the only acceptance line

The plugin has exactly one purpose: **the verdict must be correct**. So accuracy is not an
adjective here, it is a command you can run:

```bash
npm run eval
# [eval] 119/119 passed (100%), 77 cases · main 94/94 · heldout 25/25
```

- Cases live in `test/eval/cases.json` (the set used while tuning) and
  `cases-heldout.json` (phrased completely differently, **never used for tuning**, only to
  check generalisation).
- Every case carries a `why`, so a failure immediately separates "implementation is wrong"
  from "the case itself is wrong".
- More than half are "must not switch" cases, and those must hold under **two different
  defaults** (standard and ptc) — better to stay put than to switch wrongly.
- `npm run check` runs the same evaluation and requires 100%; any failure exits 1.

For reference: 0.1.11 scored 9 right, 2 lucky and 3 clearly wrong on a 14-case sample.
"How many rows does this table have?" was judged PTC, "my plugin stopped working" was
judged Creative, and "write a plugin that adds a sidebar panel" stayed on the default
(English rules were almost non-existent). All three are regression cases now.

The boundary, stated plainly: this is a **curated** set. It covers common phrasings, not
every phrasing you might use. It proves "these cases are judged correctly", not "all
phrasings are". The real safety net is the two checkable sentences in the UI — when a
verdict is wrong you can see which row it is wrong about.

## Model-fallback quota

Clicking repeatedly no longer means hitting the model repeatedly. Everything below runs
host-side; the client only explains it.

| Limit | Value | Behaviour |
|---|---|---|
| Burst capacity | 5 | The first 5 distinct inputs go straight through |
| Refill | 1 per 20s | After a burst, tokens return at this rate (about 3/min sustained) |
| Same-input reuse | 5 min | Identical input **and** table returns the previous verdict (`cached: true`) and spends no token |
| Empty input | — | 400 `invalid-input`, no token spent: a client bug must not cost you quota |
| Model unavailable | — | When no request left the host (no model configured / no `llm` service) the token is refunded, so "unavailable" is never reported as "too often" |

When the quota is exhausted, `/judge` returns `429` with `retryAfterMs` (plus a
`retry-after` header), and the panel says "try again in about 12s; showing the rule-based
recommendation for now" instead of a generic "no model response". The seconds come only
from the host value — the client keeps no second copy of the quota numbers.

The quota is the host constant `JUDGE_LIMITS`, not a `cordis.patch.yml` field. Making it
configurable needs a config schema and is separate work.

## Why this mode: two sentences you can check

Every verdict carries **two sentences**. The first is about the task: which words
matched, whether they were an explicit instruction or a task feature; with hints only it
says they are not enough to justify switching, with no signal at all it says no exclusive
capability is required, and with a troubleshooting hit it says this is about the current
state. The second is about facts: the distribution of the key capability across modes,
the number of differing rows, where those facts came from, and a pointer to the
expandable table. Even whether a mode is the *only* one with a capability, or shares it
with another, is computed row by row from the current table — a hard-coded sentence would
keep repeating a stale claim after a kernel upgrade.

The four sources are worded differently: a rule verdict names its matched signals; a model
verdict **states that it came from model review, not from local rules**; a troubleshooting
verdict says plainly that no switch applies; a default verdict states that no differing
capability is required and that extra capabilities in other modes are not needed for this
task.
None of them dresses a single hint up as "you must use this mode". When a live capability
refresh succeeds, the explanation is recomputed against the new table, so the table can
never say ✓ while the text still claims the capability is off.

"Always perfectly accurate" is not a promise we can make. Accuracy has a runnable
acceptance line (previous section), but the case set is curated; the table is a build-time
baseline (replaced only on a successful live refresh), so after a kernel upgrade the
factual basis can be one version behind until `refresh:baseline` runs. Rules recognise
explicit phrasings but not irony or double negatives; for those, tier 3 or the official
mode dropdown is the answer.

**The table does not depend on Remote.** `ctx.remote.agentPresets` is a **separate cordis
service**, not a field on `remote`: the fiber's `inject` must list `'remote.agentPresets'`
on its own (as the official `dsh-client-ui-agent-preset` does). Without that entry the
property proxy **throws** `cannot get property "remote.agentPresets" without inject` —
optional chaining cannot catch a throw. That single root cause produced both the 0.1.3
"Preset details are unavailable" notice and the 0.1.5 "Switch failed" message.
`module.exports.inject` (service names) and `dsh.client.inject` (preload **package**
names) are two different layers; editing the wrong one has no effect. Even with the
declaration in place, unary calls still cross the gateway carrier, so an offline carrier
folds into `RemoteResult`'s error branch (the host spec says it is never thrown) and all
four `read()` calls may still return no content. Hence the table is drawn from a build-time
baseline; a background refresh replaces it only when all four reads succeed, and failure
is completely silent.

**The capability table and the main decision path still never call
`agentPresets.list()`** — it awaits `loader.await()` forever when any plugin row waits
for a service that never arrives. The single exception is the new-task-default fallback
below: one background call with its own 1.2s hard timeout, treated as unread on failure.

The panel reads host configuration on open **and again on every judgement and before
any model fallback** (so a click right after opening cannot use a stale fire-and-forget
value). Setting `llmFallback` to `false` suppresses the model request entirely;
`timeoutMs` also sets how long the client is willing to wait.

## New-task default: follow the host, live

The "default for new tasks" badge in Settings → Agent Presets is the user's choice, not
a constant. The host's `AgentPresetRegistry.defaultId` resolves as
`config.selectedDefault.get() ?? config.default`; the plugin only **reads** it and never
re-implements that rule. The host has two read paths:
`reflect.get('agentPresets', false).defaultId` (most live), and — if that is unavailable —
the `agent-preset-registry` row's `selectedDefault ?? default` in
`DSH_PROFILE_DIR/cordis.patch.yml` (the same value, persisted). Only if both fail does it
return `null`.

The host reads it fresh on every `/config` and `/judge` and returns `defaultMode`.
The browser side re-aligns when the panel opens, when the window regains focus, when
the tab becomes visible, every 4 seconds, and on every "Recommend" click (the settings
page and the panel share a window, so changing the default does **not** fire `focus` —
the periodic check is essential). When the value changes it (1) recomputes any
"no switch needed" verdict against the new default, (2) recomputes both explanatory
sentences, and (3) updates the "current default: X" label.

When the verdict **is** the current default, the primary button becomes "Keep current
default" and gives a visible "No switch needed" result instead of calling `select()` —
otherwise a user who chose Standard would be moved away by a hard-coded PTC. If the
host default cannot be read, the UI says "default unread; using built-in PTC" rather
than pretending PTC was your choice; only then does it fall back to the official
`agentPresets.list()` `isDefault` flag in the background.

## Capability table: baseline plus live refresh

`src/preset-baseline.json` is generated from the four real
`dsh-web-app/presets/*.patch.yml` files inside the installed `app.asar` (4 columns,
13 differing rows) and inlined into `client.js` by `build.mjs`. Run
`npm run refresh:baseline && npm run build` after a kernel upgrade. Custom presets are
not included, which is what lets us avoid the hanging `list()` path.

Trade-off: if Remote is unavailable and the baseline was not refreshed after a kernel
upgrade, the table can be one version behind. The verdict and one-click apply are
unaffected, but **the factual basis of the two sentences comes from that same table**,
so run `refresh:baseline` after upgrading. When a live refresh succeeds, the table and
the explanation are **recomputed together**: row count and every capability's
distribution are read from the current table, with no residue from the old baseline.

Another boundary: the four mode ids used for judging come from baseline columns, not a
live profile roster. The table and the main decision path never call `list()`, which can
hang forever (the default-mode fallback above is the only timed exception). If you remove
a built-in preset from your profile, the plugin may still recommend it; `select()` will
then fail and the button will state the reason.

## One-click apply limitation

`agentPresets.select` refuses sessions that have already started
(`agent-preset/locked`), so:

- **New session (blank)**: shows "Switch to this mode" and applies immediately.
- **Running session**: advice only, with an explanation that the mode was fixed at creation.

**Service declaration**: `module.exports.inject` is
`['slots', 'remote', 'remote.agentPresets']`. `presetsApi()` is the single entry point for
reaching Remote; if the property proxy throws it falls back to
`ctx.reflect.get('remote.agentPresets', false)`. Both call sites share it.

Whatever the outcome, **the button itself changes label** (Switching… → Switched / Retry switch);
the reason is also available in its `title` and in the verdict area. `select` has a 2.5s hard
timeout. When the host cannot switch, the panel says so and points to the current mode
label in the composer toolbar for a manual switch — it no longer hard-codes "Standard",
since the active mode may be a different one. There is no silent "nothing happened" click.
The session identity accepts both the slot's `sessionId` and the official `SessionSnapshot.id`.

## Installation (Desktop)

The `desktop` profile is managed exclusively by the Electron application;
`dsh plugin --profile desktop add ...` is rejected. Three manual edits are required:

1. Add `"dsh-npie-modeguide": "link:/Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-modeguide"` to `dependencies` in `~/.dsh/profiles/desktop/package.json`.
2. Add `"dsh-npie-modeguide"` to `dsh.profile.bundles` in the same file. **Dependencies alone are not enough** — the patch never enters the composition tree.
3. Run `pnpm install` in `~/.dsh/profiles/desktop/` to create the node_modules link.

Then **Cmd+Q and reopen the app**. The Desktop release has no "Reload page"; `Cmd+R` /
`Cmd+Shift+R` will not activate host-side routes, and even client-side edits under
`link:` need a full restart to re-run the factory.

## Configuration

Written in the plugin's `cordis.patch.yml` (id `npie-modeguide`):

| Field | Default | Meaning |
|---|---|---|
| `llmFallback` | `true` | Whether to call the model when local rules are undecided |
| `provider` | empty | Empty = follow the default model in Settings → Model |
| `model` | empty | Same |
| `timeoutMs` | `20000` | Host-side limit for one decision (clamped to 120000); the client waits this plus a 2s margin, floored at 6s |

The browser-side `apply(ctx, config)` cannot read config, so the host serves it from
`/api/npie-modeguide/config` on each read. **The client must give up later than the
host**: earlier builds hard-coded a 6s client timeout while the host allowed 20s, so on
a slow model the host was still computing when the client had already aborted — the
model fallback could never return a verdict.

`/config` also returns `defaultMode` (your new-task default). It is **not** a plugin
setting and does not go into `cordis.patch.yml`: the host reads it live from
`agentPresets.defaultId`. See "New-task default".

## Development

```sh
node build.mjs        # inline src/*.js + adapter.js + locale dictionaries into client.js
node --test test/*.test.mjs
node scripts/eval.mjs # accuracy evaluation (npm run eval)
node build.mjs && node --test test/*.test.mjs && node scripts/eval.mjs   # npm run check
```

`client.js` is generated; never edit it by hand. Change `src/presets.js` (whitelist),
`src/capabilities.js` (parsing), `src/recommender.js` (rules and prompt), `adapter.js`
(UI), or `locale/*.json` (copy), then rebuild.

**Changing a rule starts with `npm run eval`.** The rules are the only thing that affects
whether the verdict is right, and there is no type system behind them: adding one word can
bend a whole other family of sentences. So the order is: add the case (with its `why`),
then change the rule, then get both case sets back to 100%.

The prompt and LLM-output parser live only in `src/recommender.js`: the host imports it
directly and the build inlines it for the browser, so the tested code is the running code.

A test checks the `source-sha1` in `client.js` (covering three sources, two
dictionaries and the capability baseline): running tests without rebuilding fails. Another test renders the built
artifact with a lightweight React mock and **actually clicks** "Switch to this mode": it asserts
`agentPresets.select(sessionId, mode)` is really invoked and that success, host refusal, timeout
and missing Remote all produce visible feedback, with a reverse control that turns the button's
`onClick` into a no-op. Asserting only that the button exists would let a dead button pass.
Another render test simulates the real cordis proxy throwing `without inject` and asserts
`select` is still really invoked without leaking the English exception to the user; a static
guard requires every `remote.*` access to be declared in `inject`, with a reverse control
that fails when the declaration is removed. A further test runs `modelTimeoutMs()` from
the built artifact to prove the client waits longer than the host (turning the margin
negative must fail), and malformed capability matrices are checked so `/judge` cannot
exit on an uncaught exception. The two-sentence guards corrupt a row in the capability
table and require the distribution wording to change; a render test asserts the
explanation really appears (reverting to the short `reason` must fail); and an
end-to-end test asserts that writing a poem sends no model request while a genuine
conflict does — two guards that act as each other's reverse control.

## Design boundaries

- **No model-visible tool.** Choosing a mode is the user's decision; the model should neither see nor change it.
- **No DSH source changes.** Everything is mounted through the profile, so upgrades are safe.
- **No pinned kernel version.** `engines.dsh` uses a loose range and there are no `@deepseek-ai/dsh-*` peers.
- **No home-grown authentication.** Both routes reuse the host's
  `connection.requestRejection()`: the Host/Origin fence (DNS-rebinding defense) plus a
  `dsh-auth-*` cookie whose signature is verified with the local secret. Only when that
  service is absent does a local fallback apply (cross-site refused, `dsh-auth-*` name
  required, non-loopback peers refused).

Known limitations, stated honestly (not yet changed):

- **Only the four built-in presets.** The whitelist exists once in `src/presets.js` (the
  host imports it, the client inlines it), but the capability table only has those four
  columns. If you add a preset, the plugin cannot read it as the default (the UI says
  "no default found, falling back to built-in PTC") and the rules will never recommend it —
  there is no capability data to reason from. Real "any preset" support means reading that
  preset's content back from the roster, parsing a fifth column, and teaching the rules
  where it is exclusive; half of that equals advice with no basis.
- **Rules handle explicit phrasings, not semantics.** "Do not write a plugin",
  "no workflow" and "don't use workflow" are filtered before a keyword counts as a hit,
  but irony such as "it's a plugin, sort of" still matches. Local rules are tiered
  keywords, not semantic parsing — which is exactly why tier 3 stays.
- **The table has a version boundary, and the explanation shares it.** See the
  trade-off note above: the facts in the two sentences come from that table, never
  newer and never older.
- **100% on a curated case set is not 100% on every phrasing.** See the Accuracy section.
- **The quota is a constant, not a knob.** Capacity and refill live in `JUDGE_LIMITS`
  host-side, not in `cordis.patch.yml`; the reuse key is "text + table + default mode +
  prompt version", so adding "please" counts as a new input.

## Changelog

- **0.2.1** (2026-11-16): **blind-tested on 20 real phrasings, four wrong verdicts
  fixed.** The 0.2.0 case set was written by the same hand as the rules, so 100% only
  proved self-consistency; this version re-checked against deliberately awkward wording
  and hit exactly the dangerous class — a wrong verdict whose reason still reads like a
  fact. (1) "traverse" is downgraded from a decisive feature to a composite rule: walking
  a JSON object or an array is ordinary programming that Standard's bash already does;
  only "traverse + directory / all files" is an `execute` case ("walk this JSON to see
  its shape" used to be judged PTC). (2) A "you are asking about the modes themselves"
  gate now runs **before** pinning — "compare the difference between Standard and PTC"
  contains the literal "PTC mode" and used to be read as "I want PTC". (3) The reverse
  list gains "won't open / crashes / won't install / broken / explain this" ("my plugin
  worked yesterday and won't open today" used to be judged Creative). (4) Prompt and rule
  version is raised to 3, so stale cached verdicts can no longer impersonate the new
  rules. The case set grows to 77 cases / 119 assertions with four new guards (traverse
  both ways, asking about modes, the new troubleshooting words, and a structural check on
  the rule table), each verified with a reverse control.
- **0.2.0** (2026-11-16): **the decision engine is rebuilt around accuracy, and it finally
  has a number.** (1) Signals are now tiered: a pinned tool or a decisive feature decides
  alone, **partial evidence needs two hits in the same mode**, hints never decide. This
  fixes "how many rows does this table have?" being judged PTC (one "count" hit is not
  reason enough for `execute`; Standard's bash does the job). (2) A reverse word list:
  error / not working / why / fix / debug push back to the default mode and **skip the
  model request**, fixing "my plugin stopped working" being judged Creative. (3) A
  composite rule: an action word plus a DSH-internal object ("add a switch" counts, "this
  panel is too big" does not). (4) English rules brought up to parity: pinned phrasing per
  mode, ASCII matched on word boundaries (plurals count), English negation incl. curly
  apostrophes — fixing "write a plugin…" staying on the default. (5) `npm run eval` with
  two case sets (70 cases / 106 assertions, 18 held out from tuning), enforced at 100% by
  `npm run check`. (6) Cache key now includes the default mode and prompt version, so
  changing the default no longer replays an old verdict. (7) Prompt de-anchored (example
  value is a placeholder) + `temperature: 0`; capability labels fenced as data, not
  instructions. (8) Whitelist unified in `src/presets.js`; profile reads cached by mtime;
  mode counts and spacing in the explanation derived from data; four unused locale keys
  and two unread state fields removed; the popover focuses its textarea; real-HTTP
  end-to-end checks moved into the repo (`test/e2e-http.test.mjs`).
- **0.1.11** (2026-11-16): **the model fallback now has a quota.** (1) The host adds a
  token bucket (burst 5, one token per 20s) plus a 5-minute verdict cache: identical
  input **and** table returns the previous verdict (`cached: true`) without spending a
  token or calling the model. (2) Over the limit returns `429` with `retryAfterMs` and a
  `retry-after` header; empty input returns `400 invalid-input` without spending quota.
  (3) The panel distinguishes "called too often (about N seconds)" from "no model
  response", with seconds taken only from the host value. (4) README gains the pipeline
  diagram, the three-tier weight table, the order of operations and the merge order, plus
  a new "Model-fallback quota" section. (5) Guards: token bucket (half cycle and refill
  cap), cache (TTL and LRU), an end-to-end 429 that leaves the model call count unchanged,
  and a rendered quota message.
- **0.1.10** (2026-11-16): **endpoint admission is the host's own check again.**
  (1) `trustedCaller` is gone — "cookie length ≥ 16 lets you in" is forgeable by any
  local process; both routes now reuse the host's `connection.requestRejection()`:
  Host/Origin fence, signature-verified cookie, expiry check. (2) A host-side exception
  is treated as unauthenticated (401) instead of degrading to allow. (3) When the
  service is absent, a local fallback refuses `sec-fetch-site: cross-site`, requires a
  host-issued `dsh-auth-*` cookie name, and refuses non-loopback peers. (4) A rejected
  POST is closed before the body is read, so a forged request cannot trigger a model
  call. (5) Guards: four service branches, six fallback branches, an end-to-end 401, plus
  a reverse control against the old predicate.
- **0.1.9** (2026-11-15): **the new-task default now follows the host, live.** (1) The
  host reads `agentPresets.defaultId` (`selectedDefault.get() ?? default`) on every
  `/config` and `/judge` and ships it down; when that service is unavailable it reads the
  same persisted value from `DSH_PROFILE_DIR/cordis.patch.yml`. `ptc` is no longer
  hard-coded. (2) The client
  re-aligns on panel open, window focus, tab visibility, every 4 seconds and every
  judgement; a change recomputes "no switch needed" verdicts, both explanatory sentences
  and the on-screen default label. (3) When the verdict equals the current default the
  primary button becomes "Keep current default", gives a visible "No switch needed"
  result and **does not call `select()`**, so you are never moved away from a default
  you chose. (4) The model prompt follows the same default; when it cannot be read the
  UI says "default unread; using built-in PTC" and only then tries the official
  `agentPresets.list()` `isDefault` flag with a 1.2s hard timeout. (5) Tests cover all
  three layers plus a real render of "change default → verdict moves from PTC to Standard
  without calling select", reverse controls, a live `/config` handler, both locales and
  the documentation wording.
- **0.1.8** (2026-11-15): **judgement accuracy plus two verifiable sentences for every
  verdict.** (1) A description with no exclusive-tool signal ("I want to write a poem")
  no longer triggers a model call: it is decided locally as "stay on the default" and
  marked `noToolNeed`; only conflicting signals, too little text or a missing preset
  reach the model. (2) Weak hints no longer borrow strong claims ("tidy up a PDF" used
  to be described as "requires batch traversal"); `composeVerdict` now falls back to the
  default whenever `noToolNeed` is set. (3) Explicit negations ("do not write a
  plugin", "no workflow") no longer count as hits. (4) New `explainVerdict()` produces
  two sentences whose capability facts — differing-row count, each mode's distribution,
  exclusive vs. shared — are all computed from the current table; a successful live
  refresh recomputes them, the redundant match-word line was removed and the usage hint
  is hidden once a verdict exists (real-Chrome measurement: 321 → 331px, only +10px),
  both locales are covered, and model verdicts are labelled as model review.
  Tests 60 → 66, each with a reverse control.
- **0.1.7** (2026-11-15): full audit, three real defects fixed. (1) **Broken timeout
  chain**: the client was hard-coded to 6s while the host allowed 20s, so on a slow model
  the client aborted before the host finished and the model fallback could never return.
  `/config` now supplies `timeoutMs` and the client waits that plus a 2s margin (floored
  at 6s); config is re-read immediately before any fallback, removing the stale-value
  race from the fire-and-forget read on open. (2) **Malformed request body**: a bad
  `matrix` made `row.cells[c.id]` throw a TypeError, and prompt construction sat outside
  the `try`, so the `/judge` handler exited on an uncaught exception with no response.
  Added a shared `sanitizeMatrix()`, moved construction inside `try`, and gave the
  handler a fallback JSON verdict. (3) The manual-switch hint hard-coded "Standard"
  although the active mode may differ; it now points at the current mode label.
  Also cleaned up contradictions: the file header still claimed the table comes from
  `agentPresets.read` (it is baseline-first), the Chinese README said "four" where the
  same file and the English one said "three", the difference table wrote `?` cells as
  `✓`, and `files` omitted `build.mjs` / `scripts` / `test` so the documented build and
  baseline-refresh commands would break in a packed copy. Tests 55 → 60, adding a timeout
  chain guard, malformed-input guards, an end-to-end call into the host `/judge` handler,
  documentation consistency and packaging checks — each with a reverse control.
- **0.1.6** (2026-11-15): fixed the real cause of "Switch failed: cannot get property
  \"remote.agentPresets\" without inject". `ctx.remote.agentPresets` is a separate cordis
  service, so the client fiber now declares `inject: ['slots', 'remote',
  'remote.agentPresets']` (matching the official `dsh-client-ui-agent-preset`). Both
  Remote call sites now share `presetsApi()`, which falls back to
  `ctx.reflect.get('remote.agentPresets', false)` if the property proxy throws. Removed the
  non-existent `@deepseek-ai/dsh-client-ui-slots` preload entry (a wrong package name is
  silently skipped). Tests 54 → 55: inject-coverage guard, real proxy-throw render test,
  reverse controls, and a whitelist check that every preload package exists in the kernel.
- **0.1.5** (2026-11-15): fixed "Switch to this mode does nothing when clicked". The old handler
  **returned early** when `remote.agentPresets.select` was absent, so `setApplying` never ran,
  the button label never changed, and the only feedback was a 10.5px line inside the scroll area
  — invisible in practice. Every path now enters `applying` first, the outcome is drawn on the
  button itself (Switching… / Switched / Retry switch), `select` has a 2.5s hard timeout, and a
  failure states the reason plus the manual switch path. Session identity also accepts
  `session.id`; `dsh.client.inject` now mirrors the official `dsh-client-ui-agent-preset`
  dependencies (gateway / session / settings / workspace). Tests 53 → 54, with a real click,
  a dead-button reverse control and an order-swap reverse control.
- **0.1.4** (2026-11-15): the capability table no longer depends on the client→Host Remote call. Added `src/preset-baseline.json`, generated from the four real presets inside the installed `app.asar` (4 columns / 13 differing rows), inlined by `build.mjs` and covered by `source-sha1`; the verdict and table now render on click. `agentPresets.read()` became a **silent background refresh** that replaces the baseline only when all four reads succeed — no error notice, no waiting state. Removed the whole `presetTimeout` / `presetError*` / `busyPresets` copy set. Added the carrier packages (`dsh-api-session-controller`, `dsh-client-connection`) to `dsh.client.inject` so one-click `select` can work. Added `npm run refresh:baseline` for kernel upgrades. Tests 49 → 53, including a reverse control where clearing the baseline must make the table disappear.
- **0.1.3** (2026-11-15): removed the `agentPresets.list()` call that caused the persistent "preset lookup timed out" notice. Host `list()` awaits `loader.await()`, which never settles while any plugin row waits for an unavailable service; the capability table now reads the four built-in presets directly via `agentPresets.read()` (pure in-memory, no activation audit), each with its own 1.2s timeout. Timeout copy is now neutral. Added a reverse-control render test where `list()` never resolves but the table still appears (48 → 49 tests).
- **0.1.2** (2026-11-15): fixed the "Deciding…" hang — local verdicts are now emitted synchronously and preset/model lookups run in the background with hard timeouts; the host LLM stream has an independent deadline so the handler always returns. Replaced the four-character toolbar label with a purple three-node icon plus a hover/focus tooltip; the panel now anchors above the trigger, recomputes from measured height and clamps `maxHeight` to the space above it. Panel height reduced from ~500px to 325px, capability table collapsed by default, one primary button per screen. Dictionaries synced; added no-hang and above-anchor guards (44 → 48 tests).
- **0.1.1** (2026-11-15): fixed selector-hook calls (`useInput` / `useSession` require `(s) => s`; the apply button could never appear); wired `/api/npie-modeguide/config` so `llmFallback: false` suppresses the request client-side; unified prompt/parsing into `src/recommender.js`; exact package-id matching for capabilities plus terminal-name variants; wired UI copy to the host locale service (`en.json` is now real English); disposed `slots.inject` via `ctx.effect`; added race protection and the rule-of-thumb hint; added build and render-level guards (44 tests).
- **0.1.0**: initial version — composer toolbar panel, three-tier decision, live capability table.
