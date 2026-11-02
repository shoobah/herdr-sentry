// Your Sentry issues in a popup, as the Linear mod shows Linear's: the
// unresolved ones, the new ones and yours, grouped by project. Open one for
// its counts, its latest event's exception and stack, and its tags; resolve,
// archive or take it; and one key to start an agent on it, in a tab of the
// space where its project's repo is.
//
// The work is Sentry's REST API, through curl on this computer. The token is
// sentry-cli's: SENTRY_AUTH_TOKEN, else the [auth] token in ~/.sentryclirc
// (`sentry-cli login` writes it). The organization and the first project
// come from SENTRY_ORG / SENTRY_PROJECT, else [defaults] in that file. The
// token never reaches this script: the shell reads it and hands it to curl
// on stdin.

import { View, div } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, InputState, Input, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { agents, panes, spaces, run, exec, theme, appHome, props, closeOverlay, openOverlay, nextCommand, knownAgents } from "herdr";
import { tones, tint, countPill, levelColor, icon, chip, key, ago, MONO } from "./look.js";
import { demoApi, DEMO_ORG, DEMO_PROJECTS, DEMO_ME } from "./demo.js";

// One call to Sentry. `conf` prints the API's base, the organization, the
// project and whether there is a token, a line each. Any other mode is an
// HTTP method: the body, then the status code on a line of its own.
const SENTRY = String.raw`
ini() {
  [ -f "$HOME/.sentryclirc" ] || return 0
  awk -v s="[$1]" -v k="$2" '
    /^[ \t]*\[/ { on = ($0 == s); next }
    on { i = index($0, "="); if (!i) next
         key = substr($0, 1, i - 1); gsub(/[ \t]/, "", key)
         if (key == k) { v = substr($0, i + 1); gsub(/^[ \t]+|[ \t\r]+$/, "", v); print v; exit } }' "$HOME/.sentryclirc"
}
tok=${"${"}SENTRY_AUTH_TOKEN:-$(ini auth token)}
base=${"${"}SENTRY_URL:-$(ini defaults url)}
base=${"${"}base:-https://sentry.io}
base=${"${"}base%/}
if [ "$1" = conf ]; then
  printf '%s\n%s\n%s\n%s\n' "$base" "${"${"}SENTRY_ORG:-$(ini defaults org)}" "${"${"}SENTRY_PROJECT:-$(ini defaults project)}" "$([ -n "$tok" ] && echo yes)"
  exit 0
fi
[ -n "$tok" ] || { echo "No Sentry token." >&2; exit 64; }
if [ -n "$3" ]; then
  printf 'Authorization: Bearer %s\n' "$tok" | curl -sS -m 25 -X "$1" -H @- -H 'Content-Type: application/json' --data-binary "$3" -w '\n%{http_code}' "$base$2"
else
  printf 'Authorization: Bearer %s\n' "$tok" | curl -sS -m 25 -X "$1" -H @- -w '\n%{http_code}' "$base$2"
fi
`;

// The helper's exit code when it finds no token (not one of curl's).
const NO_TOKEN = 64;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.signedOut = status === 401 || status === NO_TOKEN;
  }
}

async function sentry(method, path, body) {
  const r = await exec("sh", ["-c", SENTRY, "sh", method, path, body ? JSON.stringify(body) : ""]);
  if (r.code === NO_TOKEN) throw new ApiError("No Sentry token.", NO_TOKEN);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `curl: exit ${r.code}`);
  const cut = r.stdout.lastIndexOf("\n");
  const status = Number(r.stdout.slice(cut + 1));
  const text = r.stdout.slice(0, cut);
  let res = null;
  try {
    res = text ? JSON.parse(text) : null;
  } catch {}
  if (status >= 400 || !status) {
    const why = res?.detail ?? (typeof res === "string" ? res : "") ?? "";
    throw new ApiError(status === 401 ? "Sentry refused the token." : `Sentry: ${status} ${why}`.trim(), status);
  }
  return res;
}

async function conf() {
  const r = await exec("sh", ["-c", SENTRY, "sh", "conf"]);
  const [base, org, project, token] = r.stdout.split("\n");
  return { base, org, project, token: token === "yes" };
}

const TABS = [
  { id: "unresolved", label: "Unresolved", short: "Open", icon: "need", query: "is:unresolved" },
  { id: "new", label: "New today", short: "New", icon: "calendar", query: "is:unresolved firstSeen:-24h" },
  { id: "mine", label: "Assigned to me", short: "Mine", icon: "person", query: "is:unresolved assigned:me" },
];

// A Sentry short ID typed in the filter ("STOREFRONT-4K"): looked up in the
// whole organization, not only the list shown.
const SHORT_ID = /^[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]{1,8}$/;
// A Linear issue key in a linked issue's name.
const LINEAR_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
// Where the lists are kept between openings.
const CACHE = `${appHome()}/sentry-cache.json`;
const ALL = "";

const HEADING_H = 30;
const ROW_H = 36;
const LIST_H = 560;

// What an agent is told when you start one on an issue.
const PROMPT = (is) =>
  `Fix Sentry issue ${is.shortId}: ${is.title}\n${is.permalink}\n\n` +
  `Read the issue and its latest events with the Sentry tools, find the root cause in this repo, ` +
  `and fix it test-first. Tell me if it is not a bug in our code.`;

const STATUSES = [
  { label: "Resolve", icon: "check", body: { status: "resolved" } },
  { label: "Resolve in the next release", icon: "check", body: { status: "resolved", statusDetails: { inNextRelease: true } } },
  { label: "Archive until it escalates", icon: "idle", body: { status: "ignored", substatus: "archived_until_escalating", statusDetails: {} } },
  { label: "Archive forever", icon: "cross", body: { status: "ignored", substatus: "archived_forever", statusDetails: {} } },
  { label: "Unresolve", icon: "need", body: { status: "unresolved", substatus: "ongoing" } },
];

const DONE = { Resolving: "Resolved", Archiving: "Archived", Reopening: "Reopened" };

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

const when = (iso) => (iso ? Date.parse(iso) : 0);
const num = (n) => {
  const v = Number(n ?? 0);
  return v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
};

export default class Sentry extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.backTo = p.backTo ?? null;
    this.demo = Boolean(p.demo);
    this.screen = "list";
    this.tab = localStorage.getItem("tab") ?? "unresolved";
    this.project = localStorage.getItem("project");
    this.lists = {};
    this.found = null;
    this.filter = "";
    this.at = 0;
    this.cur = null;
    this.detail = null;
    this.menu = null;
    this.flash = this.err = this.busy = "";
    this.projects = [];
    this.width = 900;
    this.hasLinear = false;
    cx.spawn(async (cx) => {
      this.hasLinear = (await fs.readFile(`${appHome()}/mods/linear/main.js`, "utf8").catch(() => null)) !== null;
      cx.notify();
    });

    this.keys = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Type to filter, or an issue's short ID…  ← → to change tabs" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.lookUp(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.on("blur", (_e, cx) => {
      cx.timer.after(40, () => {
        if (this.screen === "list" && !this.signedOut && !this.closing) this.input.focus();
      });
    });
    this.input.focus();
    cx.timer.after(400, () => this.screen === "list" && this.input.focus());

    cx.spawn(async (cx) => {
      await this.readCache(cx);
      await this.start(cx);
      if (p.issue) await this.openById(p.issue, cx);
      cx.notify();
    });
    cx.timer.every(60000, (cx) => this.screen === "list" && !this.busy && !this.signedOut && this.loadAll(cx));

    // Key bindings and `herdr-app do`: sentry.escape, sentry.next,
    // sentry.prev, sentry.reload, sentry.demo.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "escape") this.escape(cx);
        else if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1, cx);
        else if (c === "reload") this.reload(cx);
        else if (c === "demo") {
          this.demo = !this.demo;
          this.lists = {};
          this.found = null;
          this.project = this.demo ? null : localStorage.getItem("project");
          this.screen = "list";
          await this.start(cx);
        }
        cx.notify();
      }
    });
  }

  // ── Sentry ─────────────────────────────────────────────────────────────

  api(method, path, body) {
    if (this.demo) return Promise.resolve().then(() => demoApi(method, path, body));
    return sentry(method, `/api/0/organizations/${encodeURIComponent(this.org)}${path}`, body);
  }

  // The organization and its projects; the project shown is the one you
  // chose last, else sentry-cli's default, else all of them.
  async start(cx) {
    this.err = "";
    this.signedOut = false;
    if (this.demo) {
      this.org = DEMO_ORG;
      this.projects = DEMO_PROJECTS;
      this.project ??= DEMO_PROJECTS[0].id;
      return this.loadAll(cx);
    }
    try {
      const c = await conf();
      this.base = c.base;
      if (!c.token) throw new ApiError("No Sentry token.", NO_TOKEN);
      if (this.demo) return;
      this.org = c.org;
      if (!this.org) {
        const orgs = await sentry("GET", "/api/0/organizations/");
        this.org = orgs?.[0]?.slug;
        if (!this.org) throw new Error("This token sees no Sentry organization.");
      }
      const ps = await this.api("GET", "/projects/?all_projects=1");
      // The demo was turned on while this asked Sentry: it has the screen now.
      if (this.demo) return;
      this.projects = (ps ?? []).filter((p) => p.isMember !== false).map((p) => ({ id: p.id, slug: p.slug }));
      if (this.project == null) {
        // sentry-cli's default project, else the one the shown space's repo
        // is named after, else the only one.
        const here = (place(spaces().find((s) => s.active) ?? {}) ?? "").split("/");
        const p = this.projects.find((p) => p.slug === c.project) ?? this.projects.find((p) => here.includes(p.slug));
        this.project = p?.id ?? (this.projects.length === 1 ? this.projects[0].id : ALL);
      }
      if (this.project !== ALL && !this.projects.some((p) => p.id === this.project)) this.project = ALL;
    } catch (e) {
      this.signedOut = Boolean(e?.signedOut);
      this.err = this.signedOut ? "" : String(e?.message ?? e);
      if (this.signedOut) this.keys.focus();
      return cx.notify();
    }
    this.seedAll();
    this.loadAll(cx);
  }

  // Signs in in a terminal of its own: sentry-cli's login, which opens the
  // page for a new token in the browser and keeps it in ~/.sentryclirc.
  signIn() {
    this.dismiss();
    run("space.new", { name: "Sentry sign-in", argv: ["sentry-cli", "login"] });
  }

  projectName() {
    return this.projects.find((p) => p.id === this.project)?.slug ?? "All projects";
  }

  // The next project: all of them, then each in turn.
  switchProject(cx) {
    if (!this.projects.length) return;
    const order = [ALL, ...this.projects.map((p) => p.id)];
    this.project = order[(order.indexOf(this.project) + 1) % order.length];
    localStorage.setItem("project", this.project);
    this.lists = {};
    this.found = null;
    this.at = 0;
    this.seedAll();
    this.loadAll(cx);
    cx.notify();
  }

  // ── lists ──────────────────────────────────────────────────────────────

  loadAll(cx) {
    for (const t of TABS) this.load(t.id, cx);
  }

  async readCache(cx) {
    if (this.demo) return;
    this.cache = JSON.parse((await fs.readFile(CACHE, "utf8").catch(() => null)) ?? "{}");
    this.seedAll();
    cx.notify();
  }

  seedAll() {
    const kept = this.cache?.lists?.[this.project ?? ALL];
    if (!kept || this.demo) return;
    for (const t of TABS) {
      const l = this.lists[t.id];
      if (kept[t.id] && !(l?.loaded && !l.cached)) this.lists[t.id] = { ...l, items: kept[t.id], loaded: true, cached: true, loading: l?.loading };
    }
  }

  keep(tab, items) {
    if (this.demo) return;
    const c = (this.cache ??= {});
    ((c.lists ??= {})[this.project ?? ALL] ??= {})[tab] = items;
    fs.writeFile(CACHE, JSON.stringify(c)).catch(() => {});
  }

  issuesPath(query) {
    const q = { query, sort: "date", statsPeriod: "14d", limit: "100", project: this.project || "-1" };
    return `/issues/?${Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
  }

  load(tab, cx) {
    const l = (this.lists[tab] ??= { items: [], loaded: false });
    if (l.loading || !this.org) return;
    l.loading = true;
    cx.notify();
    const project = this.project;
    cx.spawn(async (cx) => {
      try {
        const res = await this.api("GET", this.issuesPath(TABS.find((t) => t.id === tab).query));
        if (project !== this.project) return;
        l.items = (res ?? []).map(slim);
        l.error = "";
        l.cached = false;
        this.keep(tab, l.items);
      } catch (e) {
        if (e?.signedOut) this.signedOut = true;
        l.error = String(e?.message ?? e);
      }
      l.loading = false;
      l.loaded = true;
      cx.notify();
    });
  }

  reload(cx) {
    if (this.screen === "issue") return this.loadDetail(cx);
    this.loadAll(cx);
  }

  // A short ID in the filter: looked up across the organization, shortly
  // after you stop typing.
  lookUp(cx) {
    const q = this.filter.trim();
    if (!SHORT_ID.test(q)) {
      this.found = null;
      return;
    }
    cx.timer.after(300, (cx) => {
      if (this.filter.trim() !== q) return;
      cx.spawn(async (cx) => {
        try {
          const res = await this.api("GET", `/shortids/${encodeURIComponent(q.toUpperCase())}/`);
          if (this.filter.trim() === q && res?.group) this.found = { query: q, issues: [slim(res.group)] };
        } catch {}
        cx.notify();
      });
    });
  }

  step(d, cx) {
    const i = TABS.findIndex((t) => t.id === this.tab);
    this.tab = TABS[(i + d + TABS.length) % TABS.length].id;
    localStorage.setItem("tab", this.tab);
    this.at = 0;
    cx.notify();
  }

  matches(x) {
    const hay = [x.shortId, x.title, x.culprit, x.project?.slug, x.level, x.assignee, x.release].filter(Boolean).join(" ").toLowerCase();
    return this.filter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // The rows shown, grouped by project when all of them are listed.
  shownRows() {
    const l = this.lists[this.tab];
    const all = !this.project;
    const rows = (l?.items ?? []).filter((x) => this.matches(x)).map((x) => ({ issue: x, group: all ? x.project.slug : null }));
    if (all) rows.sort((a, b) => a.group.localeCompare(b.group));
    if (this.found && this.filter.trim() === this.found.query) {
      const listed = new Set(rows.map((r) => r.issue.id));
      for (const is of this.found.issues) if (!listed.has(is.id)) rows.push({ issue: is, group: "Not in this list" });
    }
    return rows;
  }

  enter(cx) {
    const r = this.shown?.[this.at];
    if (r) this.openIssue(r.issue, cx);
  }

  // ── an issue ───────────────────────────────────────────────────────────

  focusKeys(cx) {
    cx.timer.after(30, () => this.keys.focus());
  }

  openIssue(is, cx, direct = false) {
    this.screen = "issue";
    this.cur = is;
    this.detail = null;
    this.menu = null;
    this.err = this.flash = "";
    this.direct = direct;
    this.loadDetail(cx);
    this.focusKeys(cx);
    cx.notify();
  }

  // From another mod, or a key binding's props: an issue by its id or short ID.
  async openById(ref, cx) {
    try {
      const id = String(ref.id ?? ref.shortId ?? ref);
      const group = SHORT_ID.test(id) && !/^\d+$/.test(id)
        ? (await this.api("GET", `/shortids/${encodeURIComponent(id.toUpperCase())}/`)).group
        : await this.api("GET", `/issues/${encodeURIComponent(id)}/`);
      this.openIssue(slim(group), cx, true);
    } catch (e) {
      this.say(String(e?.message ?? e), cx, true);
    }
  }

  // The issue as it is now, and its latest event: the exception, the stack
  // and the tags that tell where it happened.
  loadDetail(cx) {
    const is = this.cur;
    cx.spawn(async (cx) => {
      try {
        const [group, event] = await Promise.all([
          this.api("GET", `/issues/${is.id}/`),
          this.api("GET", `/issues/${is.id}/events/latest/`).catch(() => null),
        ]);
        if (this.cur?.id !== is.id) return;
        this.cur = slim(group);
        this.detail = { ...describe(event), firstRelease: group.firstRelease?.shortVersion ?? null, lastRelease: group.lastRelease?.shortVersion ?? null };
        this.replaceRow(this.cur);
        this.err = "";
      } catch (e) {
        this.err = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  replaceRow(is) {
    for (const l of Object.values(this.lists)) {
      const i = l?.items?.findIndex((x) => x.id === is.id) ?? -1;
      if (i >= 0) l.items[i] = is;
    }
  }

  back(cx) {
    if (this.direct && this.backTo) {
      this.dismiss();
      return openOverlay({ mod: this.backTo.mod, kind: "dialog", width: 0.8, height: 0.8, props: this.backTo.props ?? {} });
    }
    this.direct = false;
    const id = this.cur?.id;
    this.screen = "list";
    this.menu = null;
    this.err = this.flash = "";
    const i = this.shownRows().findIndex((r) => r.issue.id === id);
    if (i >= 0) this.at = i;
    cx.timer.after(30, () => this.input.focus());
    cx.notify();
  }

  escape(cx) {
    if (this.menu) {
      this.menu = null;
      return cx.notify();
    }
    if (this.screen !== "list") return this.back(cx);
    this.dismiss();
  }

  dismiss() {
    this.closing = true;
    closeOverlay(props().overlay);
  }

  open(url, cx) {
    if (!url) return;
    if (this.demo) return this.say(`Demo: would open ${url}`, cx);
    cx.open_url(url);
  }

  copy(text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.say(`Copied ${text}`, cx);
  }

  say(text, cx, isErr = false) {
    this.flash = isErr ? "" : text;
    this.err = isErr ? text : "";
    cx.notify();
  }

  // ── changing it ────────────────────────────────────────────────────────

  change(is, body, doing, cx) {
    this.busy = `${doing} ${is.shortId}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.api("PUT", `/issues/?id=${encodeURIComponent(is.id)}`, body);
        this.say(`${DONE[doing] ?? doing} ${is.shortId}.`, cx);
      } catch (e) {
        this.say(String(e?.message ?? e), cx, true);
      }
      this.busy = "";
      if (this.screen === "issue") this.loadDetail(cx);
      this.loadAll(cx);
    });
  }

  statusMenu(cx, is = this.cur) {
    if (!is) return;
    const items = STATUSES.filter((s) => !(s.body.status === "unresolved" && is.status === "unresolved")).map((s) => ({
      label: s.label,
      icon: s.icon,
      run: (cx) => this.change(is, s.body, s.body.status === "resolved" ? "Resolving" : s.body.status === "ignored" ? "Archiving" : "Reopening", cx),
    }));
    this.menu = { title: `Set ${is.shortId} to`, items, at: 0 };
    cx.notify();
  }

  // Takes the issue: assigned to you, the token's user.
  takeIt(cx, is = this.cur) {
    if (!is) return;
    this.busy = `Assigning ${is.shortId} to you…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.me ??= await this.whoAmI();
        await this.api("PUT", `/issues/?id=${encodeURIComponent(is.id)}`, { assignedTo: `user:${this.me}` });
        this.say(`${is.shortId} is yours.`, cx);
      } catch (e) {
        this.say(String(e?.message ?? e), cx, true);
      }
      this.busy = "";
      if (this.screen === "issue") this.loadDetail(cx);
      this.loadAll(cx);
    });
  }

  // The token's user: asked as a user, else as a member of the organization.
  async whoAmI() {
    if (this.demo) return DEMO_ME;
    const u = await sentry("GET", "/api/0/users/me/").catch(() => null);
    if (u?.id) return u.id;
    const m = await this.api("GET", "/members/me/").catch(() => null);
    if (m?.user?.id) return m.user.id;
    throw new Error("Sentry won't say who you are: give the token the member:read scope.");
  }

  // The Linear issue linked to it (Sentry's Linear integration), in the
  // Linear mod, esc there coming back here; else in the browser.
  openLinear(cx, is = this.cur) {
    const link = is?.links.find((l) => l.linear);
    if (!link) return this.say("No Linear issue is linked to it in Sentry.", cx);
    if (!this.hasLinear) return this.open(link.url, cx);
    this.dismiss();
    openOverlay({ mod: "linear", kind: "dialog", width: 0.8, height: 0.8, props: {
      issue: { key: link.linear, workspaceKey: /linear\.app\/([^/]+)/.exec(link.url)?.[1] },
      back: "sentry",
      backTo: { mod: "sentry", label: is.shortId, props: { issue: { id: is.id }, backTo: this.backTo ?? undefined } },
    } });
  }

  // ── an agent on it ─────────────────────────────────────────────────────

  // The space for an issue's project: one whose folder is its repo (named as
  // the project), else the one shown.
  spaceFor(is) {
    const slug = is.project?.slug ?? "";
    const local = spaces().filter((s) => !s.machine);
    const inRepo = (s) => {
      const p = place(s) ?? "";
      return p.split("/").includes(slug);
    };
    return local.find((s) => s.active && inRepo(s)) ?? local.find(inRepo) ?? spaces().find((s) => s.active) ?? null;
  }

  // The agents on an issue: those in a tab named after its short ID.
  agentsOf(is) {
    if (!is) return [];
    return agents().filter((a) => a.tab_name?.includes(is.shortId) || a.title?.includes(is.shortId))
      .map((a) => ({ name: a.title || a.tab_name, status: a.status, address: a.address }));
  }

  // A tab named after the issue, in its project's space, with an agent told
  // to fix it. With an agent already on it, goes there instead.
  startAgent(cx, is = this.cur) {
    if (!is) return;
    const on = this.agentsOf(is)[0];
    if (on) {
      this.dismiss();
      return run("agent.focus", { terminal: on.address });
    }
    const s = this.spaceFor(is);
    if (!s) return this.say("No space to start it in.", cx, true);
    if (this.demo) return this.say(`Demo: would open a tab ${is.shortId} in ${s.name} with an agent told to fix it.`, cx);
    this.busy = "Finding the agent to start…";
    cx.notify();
    cx.spawn(async (cx) => {
      const known = await knownAgents({ on: s.machine }).catch(() => []);
      const agent = known.find((a) => a.installed && a.key === "claude") ?? known.find((a) => a.installed);
      this.busy = "";
      if (!agent) return this.say("No agent is installed to start.", cx, true);
      const spec = { space: s.id, name: is.shortId, argv: agent.run, task: PROMPT(is) };
      const folder = place(s);
      if (folder) spec.folder = folder;
      run("space.select", { id: s.id });
      run("tab.new", spec);
      this.dismiss();
    });
  }

  // ── keys ───────────────────────────────────────────────────────────────

  menuKey(k, cx) {
    const m = this.menu;
    const n = m.items.length;
    if (k === "down") m.at = (m.at + 1) % n;
    else if (k === "up") m.at = (m.at + n - 1) % n;
    else if (k === "enter") this.choose(m.items[m.at], cx);
    else if (/^[1-9]$/.test(k) && Number(k) <= n) this.choose(m.items[Number(k) - 1], cx);
    else return false;
    return true;
  }

  choose(item, cx) {
    this.menu = null;
    item.run(cx);
    cx.notify();
  }

  issueKey(k, cx) {
    if (this.menu) return this.menuKey(k, cx);
    const is = this.cur;
    switch (k) {
      case "left":
      case "backspace":
        this.back(cx);
        break;
      case "s":
        this.startAgent(cx);
        break;
      case "c":
        this.statusMenu(cx);
        break;
      case "r":
        this.change(is, STATUSES[0].body, "Resolving", cx);
        break;
      case "a":
        this.takeIt(cx);
        break;
      case "l":
        this.openLinear(cx);
        break;
      case "o":
        this.open(is.permalink, cx);
        break;
      case "y":
        this.copy(is.shortId, cx);
        break;
      case "u":
        this.loadDetail(cx);
        break;
      default:
        return false;
    }
    return true;
  }

  listKey(k, cx) {
    if (this.signedOut) return false;
    const n = this.shown?.length ?? 0;
    const r = this.shown?.[this.at];
    if (k === "down" && n) (this.at = Math.min(n - 1, this.at + 1)), this.follow();
    else if (k === "up" && n) (this.at = Math.max(0, this.at - 1)), this.follow();
    else if (k === "pagedown" && n) (this.at = Math.min(n - 1, this.at + 12)), this.follow();
    else if (k === "pageup" && n) (this.at = Math.max(0, this.at - 12)), this.follow();
    else if (k === "right" && !this.filter) this.step(1, cx);
    else if (k === "left" && !this.filter) this.step(-1, cx);
    else if (k === "ctrl-s" && r) this.startAgent(cx, r.issue);
    else if (k === "ctrl-r" && r) this.change(r.issue, STATUSES[0].body, "Resolving", cx);
    else if (k === "ctrl-o" && r) this.open(r.issue.permalink, cx);
    else if (k === "ctrl-t") this.switchProject(cx);
    else return false;
    return true;
  }

  // ── drawing ────────────────────────────────────────────────────────────

  // An issue's row, one line: its level, short ID and title, the culprit
  // quietly after; then its agents, events, users, when last seen, and who
  // has it, in columns so the rows line up.
  issueCard(o, is, on) {
    const color = levelColor(o, is.level);
    const ag = this.agentsOf(is);
    const busy = ag.find((a) => a.status === "working");
    const wide = this.width >= 760;
    const stat = (text, w) => div().flex_none().w(w).text_size(12).text_color(o.muted).font_family(MONO).child(text);
    return h_flex()
      .id(`is-${is.id}`)
      .flex_none()
      .h(34)
      .pl(10)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .when(on, (el) => el.bg(o.raised).shadow_sm())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .child(div().flex_none().w(3).h(16).rounded(2).when(on, (el) => el.bg(color)))
      .child(div().flex_none().w(8).h(8).rounded_full().bg(color))
      .child(div().flex_none().w(wide ? 130 : 100).font_family(MONO).text_size(11.5).text_color(o.muted).truncate().child(is.shortId))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_shrink(1).min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(o.fg).child(is.title))
        .when(wide && Boolean(is.culprit), (el) => el.child(div().flex_shrink(2).min_w(0).truncate().text_size(12).text_color(o.dim).child(is.culprit))))
      .when(ag.length > 0, (el) => el.child(busy
        ? h_flex().flex_none().gap(4).items_center().child(icon("work", o.work, 12).spin(1100)).child(div().text_size(12).text_color(o.work).child("agent"))
        : h_flex().flex_none().gap(4).items_center().child(icon("person", o.dim, 12)).child(div().text_size(12).text_color(o.dim).child("agent"))))
      .child(stat(num(is.count), 44))
      .child(h_flex().flex_none().w(40).gap(3).items_center().when(Boolean(is.userCount), (el) => el.child(icon("person", o.dim, 11)).child(div().text_size(12).font_family(MONO).text_color(o.muted).child(num(is.userCount)))))
      .child(div().flex_none().w(64).text_size(12).text_color(o.dim).child(ago(when(is.lastSeen))))
      .when(wide, (el) => el.child(div().flex_none().w(110).truncate().text_size(12).text_color(o.dim).child(is.assignee ?? "")));
  }

  heading(o, label, n) {
    return h_flex().flex_none().h(HEADING_H).px(10).pt(8).gap(8).items_center().text_size(10.5)
      .child(div().font_semibold().text_color(o.dim).child(label.toUpperCase()))
      .child(div().font_medium().text_color(o.dim).child(String(n)))
      .child(div().flex_1().h(1).bg(o.line));
  }

  tabBar(t, o) {
    let bar = h_flex().flex_none().gap(4).items_center().children(TABS.map((tb) => {
      const on = tb.id === this.tab;
      const l = this.lists[tb.id];
      return h_flex().id(`tab-${tb.id}`).flex_none().h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
        .when(on, (el) => el.bg(o.raised).shadow_sm())
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.tab = tb.id;
          localStorage.setItem("tab", tb.id);
          this.at = 0;
          cx.notify();
        })
        .child(l?.loading ? icon("work", o.accent, 12).spin(1100) : icon(tb.icon, on ? o.fg : o.dim, 12))
        .child(div().when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(this.width < 700 ? tb.short : tb.label))
        .child(countPill(o, l?.loaded ? l.items.length : null, on));
    }));
    bar = bar.child(div().flex_1());
    // The project: a click (or ctrl+t) goes to the next, all of them first.
    if (this.org) {
      bar = bar.child(h_flex().id("proj").flex_none().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(o.line)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.switchProject(cx))
        .child(icon("project", o.dim, 12))
        .child(div().text_size(12).text_color(o.muted).child(this.projectName()))
        .child(div().font_family(MONO).text_size(11).text_color(o.dim).child(this.org)));
    }
    return bar;
  }

  note(o, text, color) {
    return div().px(14).py(10).text_size(12.8).text_color(color ?? o.dim).child(text);
  }

  listBody(o) {
    const notes = [];
    const entries = [];
    this.entryOf = [];
    const l = this.lists[this.tab];
    const rows = this.shown;
    if (l?.error) notes.push(this.note(o, l.error, o.fix));
    else if (!rows.length) {
      const empty = this.err ? "" : !l?.loaded || l.loading ? "Loading…"
        : this.filter ? "Nothing matches. A short ID (STOREFRONT-4K) looks in the whole organization."
        : this.tab === "mine" ? "Nothing is assigned to you." : this.tab === "new" ? "Nothing new in the last 24 hours." : "No unresolved issues.";
      if (empty) notes.push(this.note(o, empty));
    }
    let last;
    rows.forEach((r, i) => {
      if (r.group && r.group !== last) {
        entries.push({ key: `h-${r.group}`, h: HEADING_H, el: () => this.heading(o, r.group, rows.filter((x) => x.group === r.group).length) });
      }
      last = r.group;
      this.entryOf[i] = entries.length;
      entries.push({ key: `r-${r.issue.id}`, row: i, h: ROW_H, el: () => div().h(ROW_H).pb(2).child(this.issueCard(o, r.issue, i === this.at)) });
    });
    return { notes, entries };
  }

  listView(o) {
    const { notes, entries } = this.listBody(o);
    return v_flex().flex_1().min_h(0).gap(2)
      .children(notes)
      .when(entries.length > 0, (el) => el.child(
        div().relative().h(Math.min(LIST_H, entries.reduce((h, e) => h + e.h, 0))).min_h(0).flex_shrink(1)
          .child(v_virtual_list("se-rows", entries.length, entries.map((e) => e.h), (i) => entries[i].key,
            (range) => entries.slice(range.start, range.end).map((e) => e.el())).track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => {
              const e = entries.find((x) => x.key === key);
              if (e?.row == null) return;
              if (e.row === this.at) return this.enter(cx);
              this.at = e.row;
              cx.notify();
            }))
          .child(Scrollbar.vertical("se-rows").absolute().inset_0())));
  }

  follow() {
    const e = this.entryOf?.[this.at];
    if (e == null) return;
    this.scroll.scroll_to_item(this.at === 0 ? 0 : e);
  }

  field(o, label, kids) {
    return h_flex().gap(10).items_center().min_h(24)
      .child(div().flex_none().w(72).text_size(12).text_color(o.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().items_center().children([kids].flat().filter(Boolean)));
  }

  backButton(o, label) {
    return h_flex().id("back").flex_none().h(24).px(8).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
      .on_click((_e, cx) => this.back(cx))
      .child(icon("back", o.muted, 13))
      .child(div().text_size(12).text_color(o.muted).child(label));
  }

  fromLabel() {
    if (this.direct && this.backTo?.label) return this.backTo.label;
    const tb = TABS.find((x) => x.id === this.tab);
    return tb?.short ?? "Sentry";
  }

  // An issue's screen.
  issueView(o) {
    const is = this.cur;
    const d = this.detail;
    const color = levelColor(o, is.level);
    const ag = this.agentsOf(is);
    const txt = (s, c = o.fg) => div().text_color(c).child(s);
    const status = is.status === "resolved" ? "Resolved" : is.status === "ignored" ? "Archived" : is.substatus === "regressed" ? "Regressed" : is.substatus === "new" ? "New" : "Unresolved";
    return v_flex().flex_1().min_h(0).gap(10)
      .child(
        h_flex().flex_none().gap(10).items_center()
          .child(this.backButton(o, this.fromLabel()))
          .child(chip(o, "level", [div().w(7).h(7).rounded_full().bg(color), is.level], { color }))
          .child(chip(o, "status", [status], { color: is.status === "resolved" ? o.review : null, click: (cx) => this.statusMenu(cx) }))
          .when(is.isUnhandled, (el) => el.child(chip(o, "unhandled", ["unhandled"], { color: o.fix })))
          .child(div().font_family(MONO).text_size(12.5).text_color(o.muted).child(is.shortId))
          .child(div().text_size(12.5).text_color(o.dim).child(is.project?.slug ?? ""))
          .child(div().flex_1()),
      )
      .child(div().flex_none().text_size(17).font_semibold().text_color(o.fg).line_height(1.35).child(is.title ?? ""))
      .when(Boolean(is.culprit), (el) => el.child(div().flex_none().font_family(MONO).text_size(12).text_color(o.muted).child(is.culprit)))
      .child(this.field(o, "Events", [txt(`${num(is.count)} events`), txt("·", o.dim), txt(`${num(is.userCount)} users`), txt("·", o.dim),
        txt(`first ${ago(when(is.firstSeen))}`, o.muted), txt(`last ${ago(when(is.lastSeen))}`, o.muted)]))
      .child(this.field(o, "Assignee", is.assignee ? [icon("person", o.dim, 13), txt(is.assignee)] : [txt("nobody", o.dim), chip(o, "take", ["take it"], { color: o.accent, click: (cx) => this.takeIt(cx) })]))
      .when(Boolean(d?.firstRelease || d?.lastRelease), (el) => el.child(this.field(o, "Releases", chip(o, "rel", [`${d?.firstRelease ?? "?"} → ${d?.lastRelease ?? "?"}`], { mono: true }))))
      .when((d?.tags ?? []).length > 0, (el) => el.child(this.field(o, "Tags", (d?.tags ?? []).map(([k, v], i) => chip(o, `tg-${i}`, [div().text_color(o.dim).child(k), v], { mono: true })))))
      .when(is.links.length > 0, (el) => el.child(this.field(o, "Linked", is.links.map((l, i) =>
        chip(o, `ln-${i}`, [l.name], { color: o.accent, click: (cx) => (l.linear ? this.openLinear(cx) : this.open(l.url, cx)) })))))
      .when(ag.length === 0, (el) => el.child(h_flex().flex_none().gap(10).items_center().px(12).py(8).rounded(8).bg(tint(o.accent, 0.1))
        .child(icon("play", o.accent, 15))
        .child(div().flex_1().min_w(0).text_color(o.fg).child(`Start: an agent in a tab of ${this.spaceFor(is)?.name ?? "the space shown"}, told to find the cause and fix it`))
        .child(h_flex().id("start-btn").flex_none().h(26).px(10).items_center().rounded(6).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => this.startAgent(cx))
          .child(div().text_size(12).font_semibold().text_color(o.surface).child("Start")))))
      .when(ag.length > 0, (el) => el.child(
        v_flex().flex_none().gap(1)
          .child(div().px(2).pb(2).text_size(10.5).font_semibold().text_color(o.dim).child(`AGENTS ${ag.length}`))
          .children(ag.slice(0, 4).map((a, i) => h_flex().id(`ag-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
            .on_click(() => {
              this.dismiss();
              run("agent.focus", { terminal: a.address });
            })
            .child(a.status === "working" ? icon("work", o.work, 14).spin(1100) : a.status === "blocked" ? icon("need", o.need, 14) : icon("idle", o.dim, 14))
            .child(div().min_w(0).truncate().text_size(12.5).font_medium().text_color(o.fg).child(a.name))
            .child(div().flex_1())
            .child(div().flex_none().text_size(11.5).text_color(o.dim).child(a.status ?? ""))))))
      .child(div().flex_none().h(1).bg(o.line))
      .child(v_flex().id("is-body").h(360).min_h(0).flex_shrink(1).overflow_y_scrollbar().pr(6)
        .child(d
          ? TextView.markdown(`md-${is.id}`, d.markdown).selectable(true).text_size(13).text_color(o.muted).on_link_click((url, cx) => this.open(url, cx))
          : div().text_size(12.8).text_color(this.err ? o.fix : o.dim).child(this.err || "Loading…")));
  }

  menuView(o) {
    const m = this.menu;
    return v_flex().flex_none().gap(2).p(10).rounded(10).border_1().border_color(o.line).bg(o.raised).shadow_md()
      .child(div().px(6).pb(6).text_size(13).font_semibold().text_color(o.fg).child(m.title))
      .children(m.items.map((it, i) => {
        const on = i === m.at;
        return h_flex().id(`mi-${i}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(tint(o.accent, 0.18)))
          .when(!on, (el) => el.hover((s) => s.bg(o.sunk)))
          .on_click((_e, cx) => this.choose(it, cx))
          .child(div().flex_none().w(14).font_family(MONO).text_size(11.5).text_color(o.dim).child(String(i + 1)))
          .when(Boolean(it.icon), (el) => el.child(icon(it.icon, o.muted, 13)))
          .child(div().text_size(13).when(on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(it.label));
      }));
  }

  footer(o) {
    const k = (keys, label, fn, id) => key(o, keys, label, fn, id);
    if (this.menu) {
      return [k(["↑", "↓"], "choose", () => {}, "f-ch"), k(["enter"], "do it", (cx) => this.choose(this.menu.items[this.menu.at], cx), "f-go"), k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.screen === "issue") {
      const is = this.cur;
      return [
        k(["s"], this.agentsOf(is).length ? "its agent" : "start", (cx) => this.startAgent(cx), "f-s"),
        k(["r"], "resolve", (cx) => this.change(is, STATUSES[0].body, "Resolving", cx), "f-r"),
        k(["c"], "status", (cx) => this.statusMenu(cx), "f-c"),
        k(["a"], "take it", (cx) => this.takeIt(cx), "f-a"),
        ...(is.links.some((l) => l.linear) ? [k(["l"], "Linear", (cx) => this.openLinear(cx), "f-l")] : []),
        k(["o"], "Sentry", (cx) => this.open(is.permalink, cx), "f-o"),
        k(["y"], "copy ID", (cx) => this.copy(is.shortId, cx), "f-y"),
        k(["esc"], "back", (cx) => this.escape(cx), "f-esc"),
      ];
    }
    if (this.signedOut) return [k(["esc"], "close", (cx) => this.escape(cx), "f-esc")];
    const sel = this.shown?.[this.at];
    return [
      k(["↑", "↓"], "choose", () => {}, "f-ch"),
      k(["enter"], "open", (cx) => this.enter(cx), "f-go"),
      k(["^s"], "start", (cx) => sel && this.startAgent(cx, sel.issue), "f-s"),
      k(["^r"], "resolve", (cx) => sel && this.change(sel.issue, STATUSES[0].body, "Resolving", cx), "f-r"),
      k(["^o"], "Sentry", (cx) => sel && this.open(sel.issue.permalink, cx), "f-o"),
      k(["^t"], "project", (cx) => this.switchProject(cx), "f-t"),
      k(["←", "→"], "tabs", (cx) => this.step(1, cx), "f-tab"),
      k(["esc"], "close", (cx) => this.escape(cx), "f-esc"),
    ];
  }

  signInView(o) {
    return v_flex().flex_none().gap(12).px(14).py(18).items_start()
      .child(div().text_size(15).font_semibold().text_color(o.fg).child("Sign in to Sentry"))
      .child(div().text_size(13).text_color(o.muted).line_height(1.5).child(
        "Sentry did not accept a token. Signing in opens a terminal here that runs `sentry-cli login`. It opens Sentry in your browser to make a user auth token. Give it the scopes org:read, project:read, member:read, event:read and event:write, then paste it in the terminal. The token goes to ~/.sentryclirc, and sentry-cli uses it too. Then open this again."))
      .child(h_flex().id("signin-btn").flex_none().h(30).px(14).items_center().rounded(7).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
        .on_click(() => this.signIn())
        .child(div().text_size(12.5).font_semibold().text_color(o.surface).child("Sign in")));
  }

  render() {
    const t = theme();
    const o = tones(t);
    this.shown = this.shownRows();
    if (this.screen === "list") this.at = Math.max(0, Math.min(this.at, this.shown.length - 1));
    const note = this.busy || this.err || this.flash;
    const noteColor = this.busy ? o.accent : this.err ? o.fix : o.muted;
    const scr = this.screen;
    return v_flex()
      .id("sentry")
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .when(scr !== "list" || this.signedOut, (el) => el.track_focus(this.keys))
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 20) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") this.escape(cx);
        else if (!(scr === "issue" ? this.issueKey(k, cx) : this.menu ? this.menuKey(k, cx) : this.listKey(k, cx))) return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(scr === "list" && !this.signedOut, (el) => el
        .child(h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(o.line).bg(o.sunk)
          .child(icon("search", o.dim, 15))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(o.fg))
          .when(this.demo, (el) => el.child(div().flex_none().text_size(12).text_color(o.muted).child("Demo · made-up organization"))))
        .child(this.tabBar(t, o))
        .child(this.listView(o)))
      .when(scr === "list" && Boolean(this.signedOut), (el) => el.child(this.signInView(o)))
      .when(scr === "issue", (el) => el.child(this.issueView(o)))
      .when(Boolean(this.menu), (el) => el.child(this.menuView(o)))
      .when(Boolean(note), (el) => el.child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(this.busy), (el) => el.child(icon("work", o.accent, 12).spin(1100)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(noteColor).child(note))))
      .child(h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line).children(this.footer(o)));
  }
}

// An issue as the lists keep it: what the rows and the screen draw.
function slim(g) {
  const a = g.assignedTo;
  const links = (g.annotations ?? []).map((x) => (typeof x === "string" ? { name: x.replace(/<[^>]*>/g, ""), url: /href="([^"]+)"/.exec(x)?.[1] ?? null } : { name: x.displayName, url: x.url }))
    .filter((l) => l.name)
    .map((l) => ({ ...l, linear: /linear\.app/.test(l.url ?? "") ? LINEAR_KEY.exec(l.name)?.[1] ?? null : null }));
  return {
    id: g.id,
    shortId: g.shortId,
    title: g.title,
    culprit: g.culprit || null,
    permalink: g.permalink,
    level: g.level ?? "error",
    status: g.status,
    substatus: g.substatus ?? null,
    isUnhandled: Boolean(g.isUnhandled),
    count: g.count,
    userCount: g.userCount ?? 0,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    project: { id: g.project?.id, slug: g.project?.slug ?? "" },
    assignee: a ? a.name || a.email || null : null,
    links,
  };
}

const fence = (lines) => ["```", ...lines, "```"].join("\n");

// The latest event as markdown: its exception and stack (the app's own
// frames, the deepest first), its message, and where it happened.
function describe(ev) {
  if (!ev) return { markdown: "*No event to show.*", tags: [] };
  const out = [];
  const exc = ev.entries?.find((e) => e.type === "exception")?.data?.values ?? [];
  for (const v of [...exc].reverse()) {
    out.push(`**${v.type ?? "Error"}**${v.value ? `: ${v.value}` : ""}`);
    const frames = v.stacktrace?.frames ?? [];
    const app = frames.filter((f) => f.inApp);
    const shown = (app.length ? app : frames).slice(-12).reverse();
    if (shown.length) out.push(fence(shown.map((f) => `${f.function || "?"}  ${f.filename || f.module || f.absPath || "?"}:${f.lineNo ?? "?"}${f.colNo ? `:${f.colNo}` : ""}`)));
  }
  const msg = ev.entries?.find((e) => e.type === "message")?.data?.formatted ?? (exc.length ? "" : ev.message);
  if (msg) out.push(msg);
  const req = ev.entries?.find((e) => e.type === "request")?.data;
  if (req?.url) out.push(`${req.method ?? "GET"} \`${req.url}\``);
  const crumbs = ev.entries?.find((e) => e.type === "breadcrumbs")?.data?.values ?? [];
  if (crumbs.length) {
    out.push("**Last breadcrumbs**", fence(crumbs.slice(-8).map((c) =>
      `${c.category ?? c.type ?? ""}  ${String(c.message ?? (c.data?.url ? `${c.data.method ?? ""} ${c.data.url} ${c.data.status_code ?? ""}` : "")).replace(/\s+/g, " ").slice(0, 160)}`)));
  }
  if (ev.dateCreated) out.push(`*Latest event ${new Date(ev.dateCreated).toLocaleString()}*`);
  const want = ["environment", "release", "browser", "os", "transaction", "url", "handled"];
  const short = (k, v) => (k === "release" && /^[0-9a-f]{40}$/.test(v) ? v.slice(0, 12) : v.length > 60 ? v.slice(0, 59) + "…" : v);
  const tags = want.map((k) => [k, ev.tags?.find((t) => t.key === k)?.value]).filter(([, v]) => v).map(([k, v]) => [k, short(k, String(v))]);
  return { markdown: out.join("\n\n") || "*No exception in the latest event.*", tags };
}
