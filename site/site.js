// Melodi site: themes, download links, lightbox. The 3D scene lives in scene.js
// and is loaded separately so the page still works if WebGL or the CDN fails.

export const THEMES = [
  { id: "amber", note: "phosphor amber", bg: "#0b0a08", accent: "#f5a83c", fg: "#e8dfcc", second: "#ff6e5e" },
  { id: "phosphor", note: "green terminal", bg: "#050a06", accent: "#3dff7a", fg: "#c8f5d0", second: "#7cd6c9" },
  { id: "ice", note: "cool blue", bg: "#070b12", accent: "#5cc8ff", fg: "#dbe7ff", second: "#b9a4ff" },
  { id: "catppuccin", note: "soft pastel dark", bg: "#1e1e2e", accent: "#cba6f7", fg: "#cdd6f4", second: "#f38ba8" },
  { id: "gruvbox", note: "warm retro dark", bg: "#1d2021", accent: "#fabd2f", fg: "#ebdbb2", second: "#fb4934" },
  { id: "mono", note: "white on black", bg: "#0a0a0a", accent: "#ffffff", fg: "#e6e6e6", second: "#777777" },
  { id: "paper", note: "light, for daytime", bg: "#f3ecdc", accent: "#b45309", fg: "#2a2216", second: "#1f6f8b" },
];

const REPO = "nixxane/melodi";
const RELEASES = `https://github.com/${REPO}/releases/latest`;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------- themes

function swatch(t) {
  const sw = document.createElement("span");
  sw.className = "sw";
  sw.setAttribute("aria-hidden", "true");
  for (const c of [t.bg, t.accent, t.fg, t.second]) {
    const i = document.createElement("i");
    i.style.background = c;
    sw.appendChild(i);
  }
  return sw;
}

function buildThemeControls() {
  const dock = $(".theme-dock");
  const list = $(".theme-list");
  for (const t of THEMES) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.setAttribute("role", "radio");
    chip.dataset.theme = t.id;
    chip.append(swatch(t), t.id);
    chip.addEventListener("click", () => setTheme(t.id));
    dock.appendChild(chip);

    const item = document.createElement("button");
    item.className = "theme-item";
    item.setAttribute("role", "radio");
    item.dataset.theme = t.id;
    const name = document.createElement("span");
    name.className = "t-name";
    name.textContent = t.id;
    const note = document.createElement("span");
    note.className = "t-note";
    note.textContent = t.note;
    item.append(swatch(t), name, note);
    item.addEventListener("click", () => setTheme(t.id));
    list.appendChild(item);

    // Warm the cache so switching is instant.
    const pre = new Image();
    pre.src = `img/theme-${t.id}.webp`;
  }
}

export function setTheme(id, { silent = false } = {}) {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = t.id;
  $('meta[name="theme-color"]').setAttribute("content", t.bg);
  for (const b of $$("[data-theme][role=radio]")) b.setAttribute("aria-checked", String(b.dataset.theme === t.id));
  const shot = $("#theme-shot");
  shot.style.opacity = "0.35";
  shot.onload = () => (shot.style.opacity = "1");
  shot.src = `img/theme-${t.id}.webp`;
  shot.alt = `Melodi home screen in the ${t.id} theme`;
  $("#theme-caption").textContent = t.id;
  $(".stage-fallback").src = `img/theme-${t.id}.webp`;
  try {
    localStorage.setItem("melodi-site-theme", t.id);
  } catch {
    /* private mode */
  }
  if (!silent) window.dispatchEvent(new CustomEvent("melodi-theme", { detail: t }));
}

// ---------------------------------------------------------------- downloads

function detectOS() {
  const ua = navigator.userAgent.toLowerCase();
  const plat = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  if (plat.includes("win") || ua.includes("windows")) return "windows";
  if (plat.includes("mac") || ua.includes("mac os")) return "mac";
  if (ua.includes("android") || ua.includes("iphone") || ua.includes("ipad")) return "mobile";
  if (ua.includes("ubuntu") || ua.includes("debian")) return "debian";
  if (plat.includes("linux") || ua.includes("linux")) return "linux";
  return "unknown";
}

async function setupDownloads() {
  const os = detectOS();
  const primary = $("#dl-primary");
  const label = $("#dl-os");
  const labels = { windows: "windows", linux: "linux", debian: "linux", mac: "your OS", mobile: "desktop", unknown: "your OS" };
  label.textContent = labels[os];

  const card = $(`.install .os[data-os="${os === "debian" ? "debian" : os}"]`);
  card?.classList.add("recommended");
  if (os === "mac" || os === "mobile") primary.href = "#install";

  let assets = {};
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(String(r.status));
    const rel = await r.json();
    $("#dl-version").textContent = rel.tag_name;
    for (const a of rel.assets ?? []) {
      const n = a.name.toLowerCase();
      if (n.endsWith(".sig") || n.endsWith(".json")) continue;
      if (n.endsWith("-setup.exe")) assets.exe = a.browser_download_url;
      else if (n.endsWith(".appimage")) assets.appimage = a.browser_download_url;
      else if (n.endsWith(".deb")) assets.deb = a.browser_download_url;
    }
  } catch {
    // Rate-limited or offline: every link already points at the releases page.
    return;
  }

  for (const a of $$("[data-asset]")) {
    const url = assets[a.dataset.asset];
    if (url) a.href = url;
  }
  const want = { windows: "exe", linux: "appimage", debian: "deb" }[os];
  if (want && assets[want]) primary.href = assets[want];
  else if (os !== "mac" && os !== "mobile") primary.href = RELEASES;
}

// ---------------------------------------------------------------- lightbox

function setupLightbox() {
  const dlg = $("#lightbox");
  const img = $("img", dlg);
  for (const z of $$(".zoom")) {
    z.addEventListener("click", () => {
      img.src = z.dataset.src;
      img.alt = $("img", z).alt;
      dlg.showModal();
    });
  }
  $("#lightbox-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
}

// ---------------------------------------------------------------- boot

buildThemeControls();
let saved = "amber";
try {
  saved = localStorage.getItem("melodi-site-theme") || "amber";
} catch {
  /* ignore */
}
setTheme(saved, { silent: true });
setupDownloads();
setupLightbox();

// 3D scene: optional enhancement.
import("./scene.js")
  .then((m) => m.start(THEMES.find((t) => t.id === document.documentElement.dataset.theme) ?? THEMES[0]))
  .catch((e) => {
    console.warn("3D scene unavailable:", e);
    document.documentElement.classList.add("no-webgl");
  });
