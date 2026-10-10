// Minimal text-PDF writer for CVs: A4, Helvetica (+Bold), selectable text.
// č ć đ (and capitals) are mapped through a /Differences encoding; Š Ž š ž come from WinAnsi.
const EXTRA = { 'č': 1, 'Č': 2, 'ć': 3, 'Ć': 4, 'đ': 5, 'Đ': 6 }
const WIN = { '–': 0x96, '—': 0x97, '•': 0x95, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '…': 0x85, 'š': 0x9a, 'Š': 0x8a, 'ž': 0x9e, 'Ž': 0x8e, '€': 0x80, '→': 0x2d }

function encode(text) {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (EXTRA[ch]) out += String.fromCharCode(EXTRA[ch])
    else if (WIN[ch]) out += String.fromCharCode(WIN[ch])
    else if (c >= 32 && c < 127) out += ch
    else if (c >= 160 && c < 256) out += ch
    else {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
      out += base.length === 1 && base.charCodeAt(0) < 127 ? base : '?'
    }
  }
  return out
}
const esc = (s) => s.replace(/[\\()]/g, (m) => '\\' + m)

// Parse the light markdown our CVs use into [{text, size, bold, indent, gapBefore, rule}] blocks.
function parse(md) {
  const blocks = []
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/(^|\s)[_*]([^_*]+)[_*](?=\s|$|[.,;])/g, '$1$2').replace(/`/g, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').trimEnd()
    if (!line.trim() || /^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push({ gap: 5 }); continue }
    let m
    if ((m = line.match(/^#\s+(.*)/))) blocks.push({ text: m[1], size: 20, bold: true, gap: 2 })
    else if ((m = line.match(/^#{2}\s+(.*)/))) blocks.push({ text: m[1].toUpperCase(), size: 11.5, bold: true, gap: 8, rule: true })
    else if ((m = line.match(/^#{3,}\s+(.*)/))) blocks.push({ text: m[1], size: 10.5, bold: true, gap: 4 })
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) blocks.push({ text: m[1], size: 10, bullet: true, gap: 1 })
    else blocks.push({ text: line, size: 10, gap: 1 })
  }
  return blocks
}

export function buildPdf(md, measure) {
  // measure(text, size, bold) -> width in points (supplied by the caller, canvas-based in the app)
  const W = 595, H = 842, M = 50, maxW = W - 2 * M
  const pages = [[]]
  let y = H - M
  const put = (cmd, lh) => {
    if (y - lh < M) { pages.push([]); y = H - M }
    y -= lh
    pages[pages.length - 1].push(cmd(y))
  }
  for (const b of parse(md)) {
    if (b.gap && !b.text) { y -= b.gap; continue }
    y -= b.gap || 0
    const size = b.size, lh = size * 1.3, x0 = M + (b.bullet ? 12 : 0), width = maxW - (b.bullet ? 12 : 0)
    const words = b.text.split(/\s+/)
    let cur = '', lines = []
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w
      if (cur && measure(t, size, b.bold) > width) { lines.push(cur); cur = w } else cur = t
    }
    if (cur) lines.push(cur)
    lines.forEach((ln, i) => {
      const font = b.bold ? 'F2' : 'F1'
      put((yy) => {
        let s = `BT /${font} ${size} Tf ${x0} ${yy.toFixed(2)} Td (${esc(encode(ln))}) Tj ET`
        if (b.bullet && i === 0) s += ` BT /F1 ${size} Tf ${M + 2} ${yy.toFixed(2)} Td (${esc(encode('•'))}) Tj ET`
        if (b.rule && i === lines.length - 1) s += ` 0.6 w ${M} ${(yy - 3).toFixed(2)} m ${W - M} ${(yy - 3).toFixed(2)} l S`
        return s
      }, lh)
    })
  }
  // Assemble objects: 1 catalog, 2 pages, 3 F1, 4 F2, then per page: page obj + content obj.
  const diff = '/Differences [1 /ccaron /Ccaron /cacute /Cacute /dcroat /Dcroat]'
  const objs = []
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  const enc = `<< /Type /Encoding /BaseEncoding /WinAnsiEncoding ${diff} >>`
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${enc} >>`
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding ${enc} >>`
  pages.forEach((cmds, i) => {
    const stream = cmds.join('\n')
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
    objs[6 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  let pdf = '%PDF-1.4\n', offsets = []
  for (let i = 1; i < objs.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const bytes = new Uint8Array(pdf.length)
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 255
  return bytes
}
