// Minimal editable .docx writer for CVs (no dependencies): stored-zip + WordprocessingML.
const te = new TextEncoder()
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

function zip(files) {
  const parts = [], central = []
  let off = 0
  const u16 = (n) => [n & 255, (n >> 8) & 255], u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
  for (const [name, text] of files) {
    const nb = te.encode(name), data = te.encode(text), crc = crc32(data)
    const head = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)]
    parts.push(new Uint8Array(head), nb, data)
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb)
    off += head.length + nb.length + data.length
  }
  const csize = central.reduce((a, p) => a + p.length, 0)
  const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(csize), ...u32(off), 0, 0])
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of all) { out.set(p, o); o += p.length }
  return out
}

// "**bold**", "_italic_" and [text](url) -> runs
function runs(text, base = {}) {
  const clean = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/`/g, '')
  const out = []
  const re = /\*\*(.+?)\*\*|(^|\s)_([^_]+)_(?=\s|$|[.,;])/g
  let last = 0, m
  const push = (t, o) => { if (t) out.push(run(t, { ...base, ...o })) }
  while ((m = re.exec(clean))) {
    push(clean.slice(last, m.index), {})
    if (m[1] != null) push(m[1], { b: true })
    else { push(m[2], {}); push(m[3], { i: true }) }
    last = re.lastIndex
  }
  push(clean.slice(last), {})
  return out.join('')
}
const run = (t, o) => `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${o.b ? '<w:b/>' : ''}${o.i ? '<w:i/>' : ''}<w:sz w:val="${(o.size || 10.5) * 2}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`
const para = (inner, { before = 0, after = 40, indent = 0, hanging = 0, rule = false } = {}) =>
  `<w:p><w:pPr>${rule ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/></w:pBdr>' : ''}<w:spacing w:before="${before}" w:after="${after}"/>${indent ? `<w:ind w:left="${indent}" w:hanging="${hanging}"/>` : ''}</w:pPr>${inner}</w:p>`

export function buildDocx(md) {
  const body = []
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    let m
    if (!line.trim() || /^\s*([-*_])\1{2,}\s*$/.test(line)) continue
    if ((m = line.match(/^#\s+(.*)/))) body.push(para(runs(m[1], { b: true, size: 20 }), { after: 40 }))
    else if ((m = line.match(/^#{2}\s+(.*)/))) body.push(para(runs(m[1].toUpperCase(), { b: true, size: 11.5 }), { before: 180, after: 60, rule: true }))
    else if ((m = line.match(/^#{3,}\s+(.*)/))) body.push(para(runs(m[1], { b: true, size: 10.5 }), { before: 80 }))
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) body.push(para(run('•\t', {}) + runs(m[1]), { indent: 360, hanging: 240, after: 20 }))
    else body.push(para(runs(line)))
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', doc],
  ])
}
