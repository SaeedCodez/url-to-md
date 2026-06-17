import { HTMLRewriter } from "https://ghuc.cc/worker-tools/html-rewriter/index.ts";


// ============================================================
//  MarkdownGrab — Cloudflare Worker
//  Fetches any web page and returns its meaningful content as
//  clean Markdown. Built to feed LLMs: drops scripts, styles,
//  nav/footer/aside chrome, and keeps headings, text, lists,
//  tables, links and code. No UI on the output — just Markdown.
//
//  Usage:   https://<your-worker>.workers.dev/?url=https://example.com
//  Deploy:  paste this whole file as your Worker script.
// ============================================================

const HOMEPAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>MarkdownGrab — URL to Markdown</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0c0e11;--panel:#15181d;--line:#262b33;--text:#e7eaee;
    --muted:#8a929d;--faint:#5b636e;--accent:#7aa2ff;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  }
  body{
    min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:24px;background:var(--bg);color:var(--text);
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .card{width:100%;max-width:540px}
  .eyebrow{
    font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;
    color:var(--faint);margin-bottom:14px;
  }
  h1{font-size:26px;font-weight:600;letter-spacing:-.5px;line-height:1.2;margin-bottom:8px}
  h1 b{color:var(--accent);font-weight:600}
  .lead{color:var(--muted);font-size:14.5px;margin-bottom:26px;max-width:460px}
  .row{display:flex;gap:8px}
  .field{
    flex:1;min-width:0;display:flex;align-items:center;gap:8px;
    background:var(--panel);border:1px solid var(--line);border-radius:11px;
    padding:0 14px;transition:border-color .15s;
  }
  .field:focus-within{border-color:var(--accent)}
  .field .proto{font-family:var(--mono);font-size:13px;color:var(--faint);user-select:none}
  input{
    flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--text);
    font-family:var(--mono);font-size:13.5px;padding:13px 0;direction:ltr;
  }
  input::placeholder{color:var(--faint)}
  button{
    background:var(--accent);color:#0b0d10;border:none;border-radius:11px;
    padding:0 22px;font-size:14px;font-weight:600;cursor:pointer;flex-shrink:0;
    transition:opacity .15s,transform .08s;
  }
  button:hover{opacity:.9}button:active{transform:scale(.97)}
  .err{display:none;margin-top:12px;color:#f08a8a;font-size:13px}
  .err.show{display:block}
  .note{
    margin-top:24px;padding-top:20px;border-top:1px solid var(--line);
    color:var(--muted);font-size:13px;line-height:1.75;
  }
  code{
    font-family:var(--mono);font-size:12px;background:var(--panel);
    border:1px solid var(--line);border-radius:5px;padding:2px 6px;color:#c9d2de;
    direction:ltr;display:inline-block;
  }
</style>
</head>
<body>
  <div class="card">
    <p class="eyebrow">Cloudflare Worker</p>
    <h1>URL → <b>Markdown</b></h1>
    <p class="lead">Pull the readable content out of any web page as clean Markdown — built to hand to an LLM with far fewer tokens than raw HTML.</p>
    <div class="row">
      <div class="field">
        <span class="proto">https://</span>
        <input id="u" type="text" placeholder="example.com/article" autocomplete="off" spellcheck="false">
      </div>
      <button onclick="go()">Convert</button>
    </div>
    <div class="err" id="e">Enter a valid URL.</div>
    <p class="note">
      Programmatic use: add <code>?url=</code> to this worker's address, e.g.
      <code>?url=https://example.com</code>. The response is Markdown served as
      <code>text/plain</code> so it also renders in the browser.
    </p>
  </div>
<script>
  var i=document.getElementById('u'),e=document.getElementById('e');
  i.focus();
  i.addEventListener('keydown',function(ev){if(ev.key==='Enter')go();});
  function go(){
    var v=i.value.trim();
    if(!v){show();return;}
    if(!/^https?:\\/\\//i.test(v))v='https://'+v;
    try{new URL(v);}catch(_){show();return;}
    location.href='/?url='+encodeURIComponent(v);
  }
  function show(){e.classList.add('show');setTimeout(function(){e.classList.remove('show');},2500);i.focus();}
<\/script>
</body>
</html>`;

// ─── Main handler ───────────────────────────────────────────
export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    const target = reqUrl.searchParams.get("url");
    if (!target) {
      return new Response(HOMEPAGE, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }

    // normalize
    let targetUrl = target.trim();
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return errText("Invalid URL.", 400);
    }

    // block local / private ranges (basic SSRF guard)
    if (isBlockedHost(parsed.hostname)) {
      return errText("Access to local/private addresses is not allowed.", 403);
    }

    // fetch target
    let res;
    try {
      res = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        redirect: "follow",
      });
    } catch (err) {
      return errText("Failed to fetch the target site: " + err.message, 502);
    }

    const base = res.url || targetUrl; // final URL after redirects
    const ct = res.headers.get("content-type") || "";

    const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
    const isTextLike =
      /^text\/|application\/(json|ld\+json|xml|rss\+xml|atom\+xml|javascript)/i.test(ct);

    // binary / unsupported → short note instead of garbage
    if (!isHtml && !isTextLike) {
      return out(
        `# Non-text resource\n\n**Source:** ${base}\n\n` +
          `> Content-Type \`${ct || "unknown"}\` — this tool only converts HTML/text pages to Markdown.\n`,
        200
      );
    }

    // decode with the page's charset (default UTF-8)
    const ab = await res.arrayBuffer();
    let charset = "utf-8";
    const cm = /charset=["']?([^;"']+)/i.exec(ct);
    if (cm) charset = cm[1].trim();
    let text;
    try {
      text = new TextDecoder(charset).decode(ab);
    } catch {
      text = new TextDecoder("utf-8").decode(ab);
    }

    // plain text / json / xml → already useful for an LLM, return raw
    if (!isHtml) return out(text, 200);

    let md;
    try {
      md = await htmlToMarkdown(text, base);
    } catch (err) {
      return errText("Conversion error: " + err.message, 500);
    }
    return out(md, 200);
  },
};

// ─── HTML → Markdown ────────────────────────────────────────
async function htmlToMarkdown(html, base) {
  const parts = [];
  let lastCh = "\n";
  let skipDepth = 0; // inside a stripped subtree (script/style/nav/...)
  let preDepth = 0; // inside <pre> (verbatim code)
  let quoteDepth = 0; // blockquote nesting
  let cellBuf = null; // current table cell text (null = not in a cell)
  const listStack = []; // {type:'ul'|'ol', n:number}
  const tableStack = []; // {rows, cols, cur:[]}
  let titleBuf = "";
  let captureTitle = false;
  let metaDesc = "";

  const VOID = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);

  // ---- output primitives ----
  function push(s) {
    if (s === "" || s == null) return;
    parts.push(s);
    lastCh = s[s.length - 1];
  }
  function quotePrefix() {
    return quoteDepth > 0 ? "> ".repeat(quoteDepth) : "";
  }
  function nl() {
    const p = "\n" + quotePrefix();
    parts.push(p);
    lastCh = p[p.length - 1];
  }
  function block() {
    if (parts.length === 0 && quoteDepth === 0) return; // no leading blank
    const p = "\n\n" + quotePrefix();
    parts.push(p);
    lastCh = p[p.length - 1];
  }
  function emitText(raw) {
    let t = raw.replace(/[ \t\r\n\f\v]+/g, " ");
    if (t === "") return;
    if (lastCh === "\n" || lastCh === " ") {
      t = t.replace(/^ +/, "");
      if (t === "") return;
    }
    parts.push(t);
    lastCh = t[t.length - 1];
  }
  function absUrl(u) {
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  }
  function sanitizeCell(s) {
    return s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  }
  function inlineSkip() {
    return skipDepth > 0 || preDepth > 0 || cellBuf !== null;
  }

  const rw = new HTMLRewriter();

  // ---- metadata (registered before skip; head/title still captured) ----
  rw.on("title", {
    element(el) {
      captureTitle = true;
      el.onEndTag(() => {
        captureTitle = false;
      });
    },
  });
  rw.on("meta", {
    element(el) {
      const name = (el.getAttribute("name") || "").toLowerCase();
      const prop = (el.getAttribute("property") || "").toLowerCase();
      if (name === "description" || prop === "og:description") {
        const c = el.getAttribute("content");
        if (c && !metaDesc) metaDesc = c;
      }
    },
  });

  // ---- strip whole subtrees (registered before content handlers) ----
  const SKIP =
    "script, style, noscript, template, svg, head, iframe, object, embed, " +
    "canvas, audio, video, nav, aside, footer, button, " +
    "[role=navigation], [aria-hidden=true], [hidden]";
  rw.on(SKIP, {
    element(el) {
      if (VOID.has(el.tagName)) return; // void element: no subtree text
      skipDepth++;
      el.onEndTag(() => {
        skipDepth--;
      });
    },
  });

  // ---- headings ----
  rw.on("h1,h2,h3,h4,h5,h6", {
    element(el) {
      if (skipDepth > 0 || cellBuf !== null) return;
      const lvl = Math.min(6, Math.max(1, Number(el.tagName.slice(1)) || 1));
      block();
      push("#".repeat(lvl) + " ");
      el.onEndTag(() => {
        if (skipDepth > 0) return;
        block();
      });
    },
  });

  // ---- generic block elements ----
  rw.on(
    "p,div,section,article,main,header,figure,figcaption,dl,dt,dd,address,details,summary",
    {
      element(el) {
        if (skipDepth > 0 || cellBuf !== null) return;
        block();
        el.onEndTag(() => {
          if (skipDepth > 0 || cellBuf !== null) return;
          block();
        });
      },
    }
  );

  // ---- rules & breaks ----
  rw.on("hr", {
    element() {
      if (skipDepth > 0 || cellBuf !== null) return;
      block();
      push("---");
      block();
    },
  });
  rw.on("br", {
    element() {
      if (skipDepth > 0) return;
      if (cellBuf !== null) {
        cellBuf += " ";
        return;
      }
      if (preDepth > 0) {
        push("\n");
        return;
      }
      nl();
    },
  });

  // ---- inline emphasis ----
  function wrap(sel, mk) {
    rw.on(sel, {
      element(el) {
        if (inlineSkip()) return;
        push(mk);
        el.onEndTag(() => push(mk));
      },
    });
  }
  wrap("strong,b", "**");
  wrap("em,i", "*");
  wrap("del,s,strike", "~~");

  // ---- inline code ----
  rw.on("code", {
    element(el) {
      if (inlineSkip()) return; // inside <pre> -> handled as block code
      push("`");
      el.onEndTag(() => push("`"));
    },
  });

  // ---- preformatted / fenced code ----
  rw.on("pre", {
    element(el) {
      if (skipDepth > 0 || cellBuf !== null) return;
      block();
      push("```\n");
      preDepth++;
      el.onEndTag(() => {
        if (lastCh !== "\n") push("\n");
        push("```");
        preDepth = Math.max(0, preDepth - 1);
        block();
      });
    },
  });

  // ---- blockquote ----
  rw.on("blockquote", {
    element(el) {
      if (skipDepth > 0 || cellBuf !== null) return;
      block();
      quoteDepth++;
      el.onEndTag(() => {
        quoteDepth = Math.max(0, quoteDepth - 1);
        block();
      });
    },
  });

  // ---- lists ----
  rw.on("ul,ol", {
    element(el) {
      if (skipDepth > 0 || cellBuf !== null) return;
      if (listStack.length === 0) block();
      else nl();
      const type = el.tagName === "ol" ? "ol" : "ul";
      let start = 1;
      if (type === "ol") {
        const s = el.getAttribute("start");
        if (s && !isNaN(Number(s))) start = Number(s);
      }
      listStack.push({ type, n: start });
      el.onEndTag(() => {
        listStack.pop();
        if (listStack.length === 0) block();
      });
    },
  });
  rw.on("li", {
    element(el) {
      if (skipDepth > 0 || cellBuf !== null) return;
      const depth = Math.max(0, listStack.length - 1);
      const parent = listStack[listStack.length - 1];
      let marker = "- ";
      if (parent && parent.type === "ol") {
        marker = parent.n + ". ";
        parent.n++;
      }
      nl();
      push("  ".repeat(depth) + marker);
    },
  });

  // ---- links ----
  rw.on("a", {
    element(el) {
      if (skipDepth > 0 || preDepth > 0 || cellBuf !== null) return;
      const hrefRaw = el.getAttribute("href");
      if (!hrefRaw) return;
      const href = hrefRaw.trim();
      if (/^(javascript:|#|mailto:|tel:|data:|about:)/i.test(href)) return;
      const abs = absUrl(href);
      push("[");
      const mark = parts.length;
      el.onEndTag(() => {
        if (parts.length === mark) {
          // empty link text -> drop the bracket entirely
          parts.pop();
          lastCh = parts.length ? parts[parts.length - 1].slice(-1) : "\n";
        } else {
          push("](" + abs + ")");
        }
      });
    },
  });

  // ---- images ----
  rw.on("img", {
    element(el) {
      if (skipDepth > 0) return;
      let src = (el.getAttribute("src") || el.getAttribute("data-src") || "").trim();
      const alt = (el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
      if (!src || /^data:/i.test(src)) {
        // skip inline data URIs (token bloat); keep alt text if any
        if (cellBuf !== null && alt) cellBuf += alt;
        else if (alt) emitText(alt);
        return;
      }
      const abs = absUrl(src);
      if (cellBuf !== null) {
        cellBuf += alt || abs;
        return;
      }
      push("![" + alt + "](" + abs + ")");
    },
  });

  // ---- tables ----
  rw.on("table", {
    element(el) {
      if (skipDepth > 0 || cellBuf !== null) return;
      block();
      tableStack.push({ rows: 0, cols: 0, cur: [] });
      el.onEndTag(() => {
        const t = tableStack.pop();
        if (t && cellBuf !== null) {
          t.cur.push(sanitizeCell(cellBuf));
          cellBuf = null;
        }
        block();
      });
    },
  });
  rw.on("tr", {
    element(el) {
      if (skipDepth > 0) return;
      const t = tableStack[tableStack.length - 1];
      if (!t) return;
      t.cur = [];
      el.onEndTag(() => {
        if (cellBuf !== null) {
          t.cur.push(sanitizeCell(cellBuf));
          cellBuf = null;
        }
        if (t.cur.length === 0) return;
        push("\n| " + t.cur.join(" | ") + " |");
        t.rows++;
        if (t.rows === 1) {
          t.cols = t.cur.length;
          push("\n| " + Array(t.cols).fill("---").join(" | ") + " |");
        }
      });
    },
  });
  rw.on("td,th", {
    element(el) {
      if (skipDepth > 0) return;
      const t = tableStack[tableStack.length - 1];
      if (!t) return;
      if (cellBuf !== null) t.cur.push(sanitizeCell(cellBuf)); // recover malformed
      cellBuf = "";
      el.onEndTag(() => {
        if (cellBuf !== null) {
          t.cur.push(sanitizeCell(cellBuf));
          cellBuf = null;
        }
      });
    },
  });

  // ---- all text, in document order ----
  rw.onDocument({
    text(node) {
      const t = node.text;
      if (!t) return;
      if (captureTitle) {
        titleBuf += t;
        return;
      }
      if (skipDepth > 0) return;
      if (cellBuf !== null) {
        cellBuf += t;
        return;
      }
      if (preDepth > 0) {
        parts.push(t);
        if (t.length) lastCh = t[t.length - 1];
        return;
      }
      emitText(t);
    },
  });

  // drive the stream so all handlers run
  const driven = rw.transform(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
  );
  await driven.arrayBuffer();

  // ---- assemble & tidy ----
  let body = parts.join("");
  // clean whitespace, but never touch the inside of fenced code blocks
  body = body
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    )
    .join("");
  body = body.replace(/^\s+/, "").replace(/\s+$/, "");

  const title = titleBuf.replace(/\s+/g, " ").trim();
  const desc = metaDesc.replace(/\s+/g, " ").trim();

  let head = "";
  if (title) head += "# " + title + "\n\n";
  head += "**Source:** " + base + "\n";
  if (desc) head += "\n> " + desc + "\n";
  head += "\n---\n\n";

  return (
    head +
    (body ||
      "_No extractable text content found — the page may render its content with client-side JavaScript._") +
    "\n"
  );
}

// ─── helpers ────────────────────────────────────────────────
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function out(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
      ...cors(),
    },
  });
}

function errText(msg, status) {
  return out("# Error\n\n" + msg + "\n", status || 500);
}

function isBlockedHost(h) {
  h = (h || "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.startsWith("127.") ||
    h.startsWith("192.168.") ||
    h.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.startsWith("169.254.") ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "::1"
  );
}