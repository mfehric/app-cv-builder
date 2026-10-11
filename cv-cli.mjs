// Usage: node cv-cli.mjs <result.json> <out-basename-without-extension>
// Writes <base>.pdf (ATS-friendly), <base>.docx (editable in Word) and <base>.tex (LaTeX, opens in Overleaf) from result.cv_markdown.
import fs from 'fs'
import { buildPdf } from './pdf.js'
import { buildDocx } from './docx.js'
import { buildLatex } from './latex.js'
const [, , src, base] = process.argv
const r = JSON.parse(fs.readFileSync(src, 'utf8'))
// Conservative Helvetica-like width estimate (no canvas in node).
const w = (c) => (/[iljtf.,:;'!|() ]/.test(c) ? 0.28 : /[mwMW]/.test(c) ? 0.8 : /[A-ZČĆĐŠŽ]/.test(c) ? 0.66 : 0.52)
const measure = (t, size, bold) => [...t].reduce((a, c) => a + w(c), 0) * size * (bold ? 1.06 : 1)
fs.writeFileSync(base + '.pdf', buildPdf(r.cv_markdown, measure))
fs.writeFileSync(base + '.docx', buildDocx(r.cv_markdown))
fs.writeFileSync(base + '.tex', buildLatex(r.cv_markdown))
console.log('wrote', base + '.pdf', base + '.docx', base + '.tex')
