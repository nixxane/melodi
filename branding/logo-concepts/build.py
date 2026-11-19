"""Generates the melodi logo concept SVGs and the preview page.

Colours come from the app's theme variables (src/styles.css). Each SVG falls
back to the default amber theme when opened on its own; when inlined in
index.html it follows whichever theme is picked there.

Run: python build.py
"""
import json
from pathlib import Path

HERE = Path(__file__).parent

STYLE = """<style>
.bg{fill:var(--bg,#0b0a08)}.bg2{fill:var(--bg-2,#12100c)}
.ln{fill:none;stroke:var(--line,#3b3325)}
.a{fill:var(--accent,#f5a83c)}.as{fill:none;stroke:var(--accent,#f5a83c)}.ao{stroke:var(--accent,#f5a83c)}
.d{fill:var(--accent-dim,#8a6226)}.ds{fill:none;stroke:var(--accent-dim,#8a6226)}
.f{fill:var(--fg,#e8dfcc)}.fs{fill:none;stroke:var(--fg,#e8dfcc)}
.k{fill:var(--accent-ink,#120d05)}.fa{fill:var(--faint,#64594a)}
.r{stroke-linecap:round;stroke-linejoin:round}
.scan{fill:url(#scan);pointer-events:none}
</style>"""

DEFS = """<defs>
<filter id="glow" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="2.2" result="b"/><feComponentTransfer in="b" result="b2"><feFuncA type="linear" slope=".6"/></feComponentTransfer><feMerge><feMergeNode in="b2"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.4" style="fill:var(--scanline,rgba(0,0,0,.18))"/></pattern>
<clipPath id="tileclip"><rect width="128" height="128" rx="24"/></clipPath>
{extra}</defs>"""


def svg(body, extra_defs="", clip=False):
    content = f'<g filter="url(#glow)">{body}</g>'
    if clip:
        content = f'<g clip-path="url(#tileclip)">{content}</g>'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
        + STYLE + DEFS.format(extra=extra_defs)
        + '<rect class="bg" width="128" height="128" rx="24"/>'
        + content
        + '<rect class="ln" x="7.5" y="7.5" width="113" height="113" rx="17" stroke-width="1.5"/>'
        + '<rect class="scan" width="128" height="128" rx="24"/></svg>'
    )


def pixel(rows, size=7):
    cls = {"X": "a", "O": "d", "E": "bg", "N": "f", "C": "d", "K": "k"}
    w, h = len(rows[0]), len(rows)
    ox, oy = (128 - w * size) / 2, (128 - h * size) / 2
    out = []
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in cls:
                out.append(f'<rect class="{cls[ch]}" x="{ox + x * size}" y="{oy + y * size}" width="{size + .2}" height="{size + .2}"/>')
    return "".join(out)


SPIRAL = ("M46 64A18 18 0 0 1 82 64A20 20 0 0 1 42 64A22 22 0 0 1 86 64A24 24 0 0 1 38 64"
          "A26 26 0 0 1 90 64A28 28 0 0 1 34 64A30 30 0 0 1 94 64A32 32 0 0 1 30 64"
          "A34 34 0 0 1 98 64A36 36 0 0 1 26 64")

LOGOS = [
    ("01-flourish-m", "flourish m",
     "One stroke draws a lowercase m whose tail ends in a note head. Simple enough for the tray icon.",
     svg('<g transform="translate(5 -4)"><path class="as r" stroke-width="10" d="M18 96V66a14 14 0 0 1 28 0v30M46 66a14 14 0 0 1 28 0v14a12 12 0 0 0 12 12"/><circle class="a" cx="93" cy="92" r="9"/></g>')),

    ("02-spiral-vinyl", "spiral vinyl",
     "The grooves are one spiral, so the record looks like it's spinning. The label is a play button.",
     svg(f'<circle class="bg2 ln" cx="63" cy="64" r="46" stroke-width="1.5" style="fill:var(--bg-2,#12100c)"/>'
         f'<path class="ds" stroke-width="1.4" d="{SPIRAL}"/>'
         '<circle class="a" cx="63" cy="64" r="13"/><path class="k" d="M60 58.5L69 64L60 69.5Z"/>'
         '<path class="fs r" stroke-width="4" d="M110 16L104 25L86 50"/><circle class="f" cx="110" cy="16" r="5"/>')),

    ("03-melodic-contour", "melodic contour",
     "Five notes on a staff trace a melody shaped like an m. The name, drawn literally.",
     svg('<path class="ln" stroke-width="1.5" d="M14 40H114M14 52H114M14 64H114M14 76H114M14 88H114"/>'
         '<path class="ds r" stroke-width="4" d="M26 86C34 60 38 44 45 44C54 44 56 72 64 72C72 72 74 44 83 44C90 44 94 60 102 86"/>'
         + "".join(f'<ellipse class="a" cx="{x}" cy="{y}" rx="8" ry="6" transform="rotate(-22 {x} {y})"/>'
                   for x, y in [(26, 86), (45, 44), (64, 72), (83, 44), (102, 86)]))),

    ("04-headphone-m", "headphone m",
     "The headband dips in the middle, so the headphones become an m.",
     svg('<path class="as r" stroke-width="9" d="M28 80V64C28 38 60 34 64 58C68 34 100 38 100 64V80"/>'
         '<rect class="a" x="17" y="70" width="22" height="30" rx="10"/><rect class="a" x="89" y="70" width="22" height="30" rx="10"/>'
         '<rect class="k" x="24" y="78" width="8" height="14" rx="4" opacity=".5"/><rect class="k" x="96" y="78" width="8" height="14" rx="4" opacity=".5"/>')),

    ("05-prompt", "prompt",
     "A shell prompt, a wave and a blinking cursor. Closest to how the app actually looks.",
     svg('<path class="as r" stroke-width="8" d="M24 48L40 62L24 76"/>'
         '<path class="fs r" stroke-width="7" d="M50 64C56 50 62 50 68 64S80 78 86 64"/>'
         '<rect class="a" x="93" y="50" width="12" height="26"><animate attributeName="opacity" values="1;0" dur="1.1s" repeatCount="indefinite" calcMode="discrete"/></rect>')),

    ("06-folded-ribbon", "folded ribbon",
     "An M folded from one strip, with the folds in the dim accent. Bold at any size.",
     svg('<path class="a" d="M24 36H38V92H24Z"/><path class="d" d="M24 36H38L71 78H57Z"/>'
         '<path class="a" d="M57 78H71L104 36H90Z"/><path class="d" d="M90 36H104V92H90Z"/>')),

    ("07-horizon", "horizon",
     "Two hills make an m with the sun rising between them. Late-night listening; a nod to the sleep timer.",
     svg('<g clip-path="url(#clipH)"><rect width="128" height="128" style="fill:var(--bg-2,#12100c)"/>'
         '<circle class="f" cx="64" cy="58" r="6"/><circle class="fa" cx="40" cy="34" r="1.6"/><circle class="fa" cx="90" cy="32" r="1.3"/><circle class="fa" cx="82" cy="46" r="1"/>'
         '<path class="a" d="M0 128V94C22 94 30 52 46 52C58 52 60 76 64 76C68 76 70 52 82 52C98 52 106 94 128 94V128Z"/></g>'
         '<circle class="ln" cx="64" cy="64" r="44" stroke-width="1.5"/>',
         extra_defs='<clipPath id="clipH"><circle cx="64" cy="64" r="44"/></clipPath>')),

    ("08-bunny-headphones", "bunny: headphones",
     "The mascot, drawn as amber line art: eyes closed, headphones on, a note floating by. For splash and empty states.",
     svg('<g transform="rotate(-10 48 38)"><ellipse class="bg ao" stroke-width="4" cx="48" cy="38" rx="10" ry="26"/><ellipse class="d" cx="48" cy="41" rx="4" ry="16"/></g>'
         '<g transform="rotate(10 80 38)"><ellipse class="bg ao" stroke-width="4" cx="80" cy="38" rx="10" ry="26"/><ellipse class="d" cx="80" cy="41" rx="4" ry="16"/></g>'
         '<ellipse class="bg ao" stroke-width="4" cx="64" cy="80" rx="32" ry="28"/>'
         '<path class="fs r" stroke-width="5" d="M27 82C27 36 101 36 101 82"/>'
         '<rect class="a" x="21" y="70" width="13" height="25" rx="6.5"/><rect class="a" x="94" y="70" width="13" height="25" rx="6.5"/>'
         '<path class="as r" stroke-width="3.2" d="M48 80q5-5 10 0M70 80q5-5 10 0"/>'
         '<circle class="d" cx="45" cy="90" r="4"/><circle class="d" cx="83" cy="90" r="4"/>'
         '<path class="a" d="M60.5 87h7l-3.5 4z"/><path class="as r" stroke-width="2" d="M64 91v2.5q-3 3.5-6 1M64 93.5q3 3.5 6 1"/>'
         '<path class="as r" stroke-width="3" d="M106 20v16M106 20q6 2 8 8"/><ellipse class="a" cx="102.5" cy="37" rx="4.5" ry="3.5" transform="rotate(-20 102.5 37)"/>')),

    ("09-note-bunny", "bunny: note",
     "The bunny is an eighth note: head is the note head, the upright ear the stem, the floppy ear the flag.",
     svg('<g transform="translate(2 0)">'
         '<rect class="a" x="63" y="22" width="13" height="66" rx="6.5"/><rect class="d" x="66.5" y="30" width="6" height="38" rx="3"/>'
         '<path class="a" d="M71 24C90 28 104 42 98 66C95 52 86 45 73 42Z"/>'
         '<ellipse class="a" cx="50" cy="88" rx="24" ry="18" transform="rotate(-20 50 88)"/>'
         '<circle class="k" cx="44" cy="88" r="3.2"/><circle class="k" cx="60" cy="82" r="3.2"/>'
         '<path class="k" d="M51 91.5l4-1.5l-1 4z"/>'
         '<circle class="d" cx="39" cy="96" r="4"/><circle class="d" cx="66" cy="90" r="4"/></g>')),

    ("10-vinyl-bunny", "bunny: vinyl",
     "A record whose label is the bunny's face, ears poking out the top.",
     svg('<g transform="rotate(-12 46 32)"><ellipse class="bg ao" stroke-width="3.5" cx="46" cy="32" rx="10" ry="22"/><ellipse class="d" cx="46" cy="35" rx="4" ry="13"/></g>'
         '<g transform="rotate(12 82 32)"><ellipse class="bg ao" stroke-width="3.5" cx="82" cy="32" rx="10" ry="22"/><ellipse class="d" cx="82" cy="35" rx="4" ry="13"/></g>'
         '<circle class="ln" cx="64" cy="74" r="40" stroke-width="1.5" style="fill:var(--bg-2,#12100c)"/>'
         '<g class="ds" stroke-width="1.3"><circle cx="64" cy="74" r="34"/><circle cx="64" cy="74" r="29"/><circle cx="64" cy="74" r="24"/></g>'
         '<circle class="a" cx="64" cy="74" r="17"/>'
         '<circle class="k" cx="57.5" cy="72" r="2.4"/><circle class="k" cx="70.5" cy="72" r="2.4"/>'
         '<path class="k" d="M62 77h4l-2 2.4z"/>', clip=True)),

    ("11-peek-bunny", "bunny: peek",
     "Just ears and eyes peeking up over the bottom edge. The clearest at 16 px.",
     svg('<g transform="rotate(-8 50 62)"><ellipse class="bg ao" stroke-width="4" cx="50" cy="62" rx="11" ry="30"/><ellipse class="d" cx="50" cy="65" rx="4.5" ry="20"/></g>'
         '<g transform="rotate(14 80 64)"><ellipse class="bg ao" stroke-width="4" cx="80" cy="64" rx="11" ry="30"/><ellipse class="d" cx="80" cy="67" rx="4.5" ry="20"/></g>'
         '<circle class="bg ao" stroke-width="4" cx="64" cy="134" r="46"/>'
         '<circle class="a" cx="50" cy="110" r="5"/><circle class="a" cx="78" cy="110" r="5"/>'
         '<path class="a" d="M60.5 117h7l-3.5 4z"/>'
         '<circle class="d" cx="40" cy="119" r="4.5"/><circle class="d" cx="88" cy="119" r="4.5"/>', clip=True)),

    ("12-pixel-bunny", "bunny: pixel",
     "An 8-bit bunny on the app's character grid. Built for the terminal look and crisp at tray size.",
     svg(pixel([
         "..X......X..",
         ".XOX....XOX.",
         ".XOX....XOX.",
         ".XOX....XOX.",
         ".XOX....XOX.",
         ".XXXXXXXXXX.",
         "XXXXXXXXXXXX",
         "XXEXXXXXXEXX",
         "XXXXXKKXXXXX",
         "XCXXXXXXXXCX",
         ".XXXXXXXXXX.",
         "..XXXXXXXX..",
     ]))),
]

THEMES = {
    "amber": "--bg:#0b0a08;--bg-2:#12100c;--line:#3b3325;--fg:#e8dfcc;--dim:#a3967c;--faint:#64594a;--accent:#f5a83c;--accent-dim:#8a6226;--accent-ink:#120d05;--scanline:rgba(0,0,0,.18)",
    "phosphor": "--bg:#050a06;--bg-2:#0a120c;--line:#1f3a26;--fg:#c8f5d0;--dim:#7fb88c;--faint:#4a6e53;--accent:#3dff7a;--accent-dim:#1e8040;--accent-ink:#021006;--scanline:rgba(0,0,0,.18)",
    "ice": "--bg:#070b12;--bg-2:#0c1220;--line:#22314f;--fg:#dbe7ff;--dim:#8fa3c8;--faint:#536384;--accent:#5cc8ff;--accent-dim:#2a6a8f;--accent-ink:#04101a;--scanline:rgba(0,0,0,.18)",
    "catppuccin": "--bg:#1e1e2e;--bg-2:#181825;--line:#45475a;--fg:#cdd6f4;--dim:#a6adc8;--faint:#7f849c;--accent:#cba6f7;--accent-dim:#7f6a9c;--accent-ink:#1e1e2e;--scanline:rgba(0,0,0,.12)",
    "gruvbox": "--bg:#1d2021;--bg-2:#282828;--line:#504945;--fg:#ebdbb2;--dim:#bdae93;--faint:#7c6f64;--accent:#fabd2f;--accent-dim:#b57614;--accent-ink:#1d2021;--scanline:rgba(0,0,0,.18)",
    "mono": "--bg:#0a0a0a;--bg-2:#111111;--line:#333333;--fg:#e6e6e6;--dim:#a0a0a0;--faint:#5c5c5c;--accent:#ffffff;--accent-dim:#777777;--accent-ink:#000000;--scanline:rgba(0,0,0,.18)",
    "paper": "--bg:#f3ecdc;--bg-2:#ebe2cd;--line:#c8b894;--fg:#2a2216;--dim:#5f523c;--faint:#8f8064;--accent:#b45309;--accent-dim:#d9a066;--accent-ink:#fff8ec;--scanline:rgba(60,40,10,.06)",
}

PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>melodi logo concepts</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
body{margin:0;padding:28px 16px;background:var(--bg);color:var(--fg);font:13px/20px 'JetBrains Mono',Consolas,monospace;transition:background .2s}
.wrap{max-width:1120px;margin:0 auto}
h1{font-size:13px;margin:0;color:var(--accent)}p{margin:0;color:var(--dim)}
.themes{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 22px}
.themes button{font:inherit;background:none;border:0;color:var(--dim);cursor:pointer;padding:0 4px}
.themes button.on{background:var(--accent);color:var(--accent-ink)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:20px 16px}
.panel{position:relative;border:1px solid var(--line);padding:22px 18px 18px}
.panel>.t{position:absolute;top:-11px;left:12px;background:var(--bg);padding:0 6px;color:var(--accent);font-weight:700}
.panel>.t:before{content:'\\2524 ';color:var(--line)}.panel>.t:after{content:' \\251C';color:var(--line)}
.row{display:flex;gap:16px;align-items:flex-start}.big svg{width:128px;height:128px;display:block}
.sizes{display:flex;align-items:flex-end;gap:12px;margin-top:14px}
.s48 svg{width:48px;height:48px}.s32 svg{width:32px;height:32px}.s16 svg{width:16px;height:16px}
.word{display:flex;align-items:center;gap:10px;margin-top:14px;font-weight:700;font-size:20px}.word svg{width:30px;height:30px}
.word span{color:var(--accent)}svg{display:block}
</style></head><body><div class="wrap">
<h1>melodi / logo concepts</h1>
<p>Every logo uses the app's own theme colours. Pick a theme to see each one the way it would look in the app.</p>
<div class="themes" id="themes"></div><div class="grid" id="grid"></div></div>
<script>
const LOGOS=__LOGOS__;const THEMES=__THEMES__;
const g=document.getElementById('grid');
g.innerHTML=LOGOS.map(([f,n,d,s])=>`<div class="panel"><div class="t">${n}</div><div class="row"><div class="big">${s}</div><p>${d}</p></div><div class="sizes"><div class="s48">${s}</div><div class="s32">${s}</div><div class="s16">${s}</div></div><div class="word">${s}<span>melodi</span></div></div>`).join('');
const tb=document.getElementById('themes');
function setTheme(t){document.body.setAttribute('style',THEMES[t]);[...tb.children].forEach(b=>b.classList.toggle('on',b.textContent==='[ '+t+' ]'));}
tb.innerHTML=Object.keys(THEMES).map(t=>`<button>[ ${t} ]</button>`).join('');
[...tb.children].forEach((b,i)=>b.onclick=()=>setTheme(Object.keys(THEMES)[i]));
setTheme('amber');
</script></body></html>"""

for f in HERE.glob("[0-9][0-9]-*.svg"):
    f.unlink()
for name, _, _, s in LOGOS:
    (HERE / f"{name}.svg").write_text(s, encoding="utf-8")
page = PAGE.replace("__LOGOS__", json.dumps([[n, t, d, s] for n, t, d, s in LOGOS])).replace("__THEMES__", json.dumps(THEMES))
(HERE / "index.html").write_text(page, encoding="utf-8")
print(f"wrote {len(LOGOS)} logos")
