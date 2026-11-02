// A made-up Sentry organization for the demo (`herdr-app do sentry.demo`):
// the same answers the REST API gives, for the paths the mod asks, so every
// screen works without a token. Changes stay in memory.

const HOUR = 3600000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

export const DEMO_ORG = "acme";
const PROJECTS = [
  { id: "11", slug: "storefront", isMember: true },
  { id: "12", slug: "checkout-api", isMember: true },
];

const issue = (id, shortId, project, level, title, culprit, count, users, firstH, lastH, extra = {}) => ({
  id, shortId, title, culprit, level, count: String(count), userCount: users,
  firstSeen: at(firstH), lastSeen: at(lastH), status: "unresolved", substatus: firstH < 24 ? "new" : "ongoing",
  isUnhandled: level !== "warning", permalink: `https://acme.sentry.io/issues/${id}/`,
  project: PROJECTS.find((p) => p.slug === project), assignedTo: null, annotations: [], ...extra,
});

const ME = { type: "user", id: "1", name: "You", email: "you@example.com" };

const ISSUES = [
  issue("901", "STOREFRONT-4K", "storefront", "error", "TypeError: Cannot read properties of undefined (reading 'price')", "CartSummary in src/cart/summary.ts", 312, 87, 30, 0.2),
  issue("902", "STOREFRONT-4M", "storefront", "error", "Error: Payment session expired", "POST /checkout/confirm", 41, 29, 6, 0.6, { assignedTo: ME }),
  issue("903", "STOREFRONT-4N", "storefront", "warning", "Slow render: ProductGrid took 2400 ms", "/products/[category]", 1840, 512, 3, 1.1),
  issue("904", "STOREFRONT-4P", "storefront", "error", "ChunkLoadError: Loading chunk 812 failed", "app:///_app/immutable/chunks/812.js", 96, 71, 2, 2.4),
  issue("905", "STOREFRONT-4Q", "storefront", "error", "Error: Too many requests to the inventory service", "GET /api/stock/[sku]", 18, 9, 52, 5, {
    assignedTo: ME,
    annotations: [{ displayName: "SHOP-128", url: "https://linear.app/acme/issue/SHOP-128/stock-lookups-get-rate-limited" }],
  }),
  issue("906", "STOREFRONT-4R", "storefront", "error", "RangeError: Invalid time value", "formatDelivery in src/lib/dates.ts", 7, 5, 70, 20),
  issue("907", "STOREFRONT-4S", "storefront", "fatal", "Error: Database connection pool exhausted", "server.handle", 3, 3, 96, 30),
  issue("911", "CHECKOUT-API-2C", "checkout-api", "error", "KeyError: 'currency'", "orders.totals in orders/totals.py", 58, 0, 12, 0.4),
  issue("912", "CHECKOUT-API-2D", "checkout-api", "error", "TimeoutError: Card network did not answer in 10 s", "payments.authorize", 22, 0, 40, 3),
];

const frame = (fn, file, line, col) => ({ function: fn, filename: file, lineNo: line, colNo: col, inApp: true });

function latest(is) {
  return {
    dateCreated: is.lastSeen,
    entries: [
      { type: "exception", data: { values: [{ type: is.title.split(":")[0], value: is.title.split(": ").slice(1).join(": "), stacktrace: { frames: [
        frame("load", "src/routes/+layout.ts", 18, 9),
        frame("getCart", "src/cart/store.ts", 64, 21),
        frame("summarize", "src/cart/summary.ts", 37, 14),
      ] } }] } },
      { type: "request", data: { method: "GET", url: "https://shop.example.com/cart" } },
      { type: "breadcrumbs", data: { values: [
        { category: "navigation", message: "/products/shoes → /cart" },
        { category: "fetch", data: { method: "GET", url: "/api/cart", status_code: 200 } },
        { category: "ui.click", message: "button.checkout" },
      ] } },
    ],
    tags: [
      { key: "environment", value: "production" },
      { key: "release", value: "storefront@2.14.0" },
      { key: "browser", value: "Firefox 131.0" },
      { key: "os", value: "macOS 15.1" },
      { key: "url", value: "https://shop.example.com/cart" },
      { key: "handled", value: is.isUnhandled ? "no" : "yes" },
    ],
  };
}

// The answer to one call, as `api(method, path, body)` gets it.
export function demoApi(method, path, body) {
  const [route, query = ""] = path.split("?");
  const params = Object.fromEntries(query.split("&").filter(Boolean).map((kv) => kv.split("=").map(decodeURIComponent)));
  if (route === "/projects/") return PROJECTS;
  if (route === "/issues/" && method === "PUT") {
    const is = ISSUES.find((x) => x.id === params.id);
    if (is && body.status) Object.assign(is, { status: body.status, substatus: body.substatus ?? null });
    if (is && body.assignedTo) is.assignedTo = ME;
    return {};
  }
  if (route === "/issues/") {
    const q = params.query ?? "";
    return ISSUES.filter((x) => (params.project === "-1" || x.project.id === params.project)
      && (!/is:unresolved/.test(q) || x.status === "unresolved")
      && (!/firstSeen:-24h/.test(q) || Date.now() - Date.parse(x.firstSeen) < 24 * HOUR)
      && (!/assigned:me/.test(q) || x.assignedTo?.id === ME.id));
  }
  let m = /^\/issues\/(\d+)\/events\/latest\/$/.exec(route);
  if (m) return latest(ISSUES.find((x) => x.id === m[1]));
  m = /^\/issues\/(\d+)\/$/.exec(route);
  if (m) {
    const is = ISSUES.find((x) => x.id === m[1]);
    if (!is) throw new Error("Sentry: 404");
    return { ...is, firstRelease: { shortVersion: "2.9.1" }, lastRelease: { shortVersion: "2.14.0" } };
  }
  m = /^\/shortids\/([^/]+)\/$/.exec(route);
  if (m) {
    const is = ISSUES.find((x) => x.shortId === m[1]);
    if (!is) throw new Error("Sentry: 404");
    return { group: is };
  }
  throw new Error(`Demo: no answer for ${method} ${path}`);
}

export const DEMO_PROJECTS = PROJECTS.map((p) => ({ id: p.id, slug: p.slug }));
export const DEMO_ME = ME.id;
