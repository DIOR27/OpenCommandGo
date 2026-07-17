// @ts-check

/**
 * Scrape model tables from the Command Code docs page.
 *
 * Usage (standalone):
 *   node src/shared/fetch-docs-models.js [section ...]
 *
 * Examples:
 *   node src/shared/fetch-docs-models.js              # all sections
 *   node src/shared/fetch-docs-models.js "Open Source" # one section
 */

const DOCS_URL = "https://commandcode.ai/docs/reference/cli/models"

const SECTIONS = /** @type {const} */ ({
  "open-source": "Open Source", anthropic: "Anthropic",
  "open-ai": "OpenAI", google: "Google", sakana: "Sakana",
  meta: "Meta", "x-ai": "xAI",
})

/**
 * @param {string} html
 * @returns {string[]}
 */
function parseCaps(html) {
  const m = html.match(/aria-label="Capabilities:\s*(.*?)"/)
  return m ? m[1].split(",").map(c => c.trim()) : []
}

/**
 * @param {string} html
 * @returns {Record<string, Array<{model_id: string, name: string, capabilities: string, best_for: string}>>}
 */
function parseModels(html) {
  /** @type {Record<string, Array<{model_id: string, name: string, capabilities: string, best_for: string}>>} */
  const result = {}
  let currentSection = /** @type {string|null} */ (null)
  let inTbody = false, inTr = false
  let col = 0
  /** @type {string[]} */
  let row = []
  let tdRaw = ""
  let capturing = false

  // Tokenize: tags and text
  /** @type {Array<{type: "tag"|"text", value: string}>} */
  const tokens = []
  const re = /(<[^>]+>)|([^<]+)/gs
  let m
  while ((m = re.exec(html)) !== null) {
    if (m[1]) tokens.push({ type: "tag", value: m[1] })
    else if (m[2].trim()) tokens.push({ type: "text", value: m[2] })
  }

  for (const tok of tokens) {
    // Capture text content inside <td> (original script skipped text tokens)
    if (tok.type === "text" && capturing) {
      tdRaw += tok.value
      continue
    }
    if (tok.type !== "tag") continue
    const tag = tok.value
    const closing = tag.startsWith("</")
    const name = closing ? tag.slice(2, -1).split(/\s/)[0] : tag.slice(1, -1).split(/\s/)[0]
    const lower = name.toLowerCase()

    if (!closing) {
      // Section header
      const id = lower === "h2" ? tag.match(/id="([^"]+)"/)?.[1] : null
      if (id && id in SECTIONS) {
        currentSection = SECTIONS[/** @type {keyof typeof SECTIONS} */ (id)]
        continue
      }
      if (lower === "table" && currentSection) continue
      if (currentSection === null) continue
      if (lower === "tbody") { inTbody = true; continue }
      if (lower === "tr" && inTbody) { inTr = true; row = []; col = 0; continue }
      if (lower === "td") { col++; tdRaw = ""; capturing = true; tdRaw += tag; continue }
      if (capturing) tdRaw += tag
    } else {
      if (capturing) tdRaw += tag
      if (lower === "td" && capturing) {
        capturing = false
        row.push(col === 3
          ? parseCaps(tdRaw).join(", ")
          : tdRaw.replace(/<[^>]+>/g, "").trim())
      }
      if (lower === "tr" && inTr) {
        inTr = false
        if (row.length >= 4 && currentSection) {
          (result[currentSection] ??= []).push({
            model_id: row[0],
            name: row[1],
            capabilities: row[2],
            best_for: row[3] || "",
          })
        }
      }
      if (lower === "table") { currentSection = null; inTbody = false }
    }
  }
  return result
}

/**
 * Fetch and parse the Command Code models page.
 * @param {string[]} [categories] - Section names to filter; omit for all.
 * @returns {Promise<Record<string, Array<{model_id: string, name: string, capabilities: string, best_for: string}>>>}
 */
export async function fetchDocsModels(categories) {
  const resp = await fetch(DOCS_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching docs`)
  const all = parseModels(await resp.text())
  if (!categories?.length) return all
  return Object.fromEntries(
    categories.filter(c => all[c]).map(c => [c, all[c]])
  )
}

// Standalone CLI runner
const { argv } = process
if (import.meta.url.endsWith(argv[1]?.replace(/\\/g, "/")) ?? false) {
  const cats = argv.slice(2)
  fetchDocsModels(cats.length ? cats : undefined)
    .then(d => console.log(JSON.stringify(d, null, 2)))
    .catch(e => { console.error("Error:", e.message); process.exit(1) })
}
