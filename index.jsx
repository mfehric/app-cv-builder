import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Plus, Trash, Copy, Check, Document, Sparkles, ArrowLeft, Calendar, Link, Reload } from '@openai/apps-sdk-ui/components/Icon'

// Fast, local relevance hint (no AI): how many of the profile's own terms show up in an ad.
import { buildLatex } from './latex.js'

// Overleaf's "open a snippet" endpoint: a top-level POST creates a new project from the .tex.
function openInOverleaf(tex, name) {
  const form = document.createElement('form')
  form.method = 'POST'; form.action = 'https://www.overleaf.com/docs'; form.target = '_blank'
  for (const [k, v] of [['encoded_snip', encodeURIComponent(tex)], ['snip_name', name], ['engine', 'pdflatex']]) {
    const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i)
  }
  document.body.appendChild(form); form.submit(); form.remove()
}

const STOP = new Set('i a an and or the to of in for with on at is are as be we you your our new that this will can who have has from role roles team work experience skills student students program per год'.split(' '))
const tokenize = (s) => ((s || '').toLowerCase().match(/[a-zčćđšž0-9+#.]{3,}/gi) || []).filter((t) => !STOP.has(t))
function profileTokenSet(profile) {
  const parts = [profile.skills, profile.extra, profile.basics?.headline]
  for (const sec of ['education', 'experience', 'projects', 'research', 'awards']) for (const e of profile[sec] || []) parts.push(e.title, e.org, e.text)
  return new Set(tokenize(parts.join(' ')))
}
function matchScore(item, pset) {
  if (pset.size < 6) return null // too little profile to say anything honest
  const toks = new Set(tokenize(`${item.title} ${item.category || ''} ${item.text || ''}`))
  if (!toks.size) return null
  let hit = 0
  for (const t of toks) if (pset.has(t)) hit++
  return Math.min(100, hit * 14)
}
// UI language: English by default, Bosnian via the toggle. Stored data values (statuses, kinds, source)
// stay in their original form and are only translated when displayed.
let LANG = 'en'
const L = (en, bs) => (LANG === 'bs' ? bs : en)
const kindLabel = (k) => ({ Praksa: L('Internship', 'Praksa'), Istraživanje: L('Research', 'Istraživanje'), Grant: L('Grant', 'Grant'), Program: L('Programme', 'Program') }[k] || k)
const statusLabel = (v) => ({ 'Zanima me': L('Interested', 'Zanima me'), Aplicirano: L('Applied', 'Aplicirano'), Intervju: L('Interview', 'Intervju'), Odbijeno: L('Rejected', 'Odbijeno'), Ponuda: L('Offer', 'Ponuda') }[v] || v)
const srcLabel = (v) => (v === 'AI pretraga' ? L('AI search', 'AI pretraga') : v)
const regionLabel = (v) => ({ bih: 'BiH', rs: L('Serbia', 'Srbija'), hr: L('Croatia', 'Hrvatska'), balkan: L('Balkans', 'Balkan'), eu: L('Europe', 'Evropa'), asia: L('Asia', 'Azija'), us: L('Americas', 'Amerika'), remote: 'Remote' }[v] || v)
const aiTypes = () => [['', L('Internships & jobs', 'Prakse i poslovi')], ['research', L('Research (university, institute)', 'Istraživanje (faks, institut)')], ['grants', L('Grants & scholarships', 'Grantovi i stipendije')], ['spring', L('Spring weeks / summer programmes', 'Spring week / ljetni programi')]]
const aiTypePrompt = (t) => (LANG === 'bs' ? {
  research: 'VRSTA: istraživačke pozicije na fakultetima, institutima i laboratorijama (research assistant, PhD pozicije, istraživački internshipi, asistent na fakultetu). Koristi i EURAXESS, Academic Positions, sajtove fakulteta (ETF, PMF Sarajevo, Zagreb, Beograd, Ljubljana, ETH, TU) i istraživačke grupe iz profila. kind postavi na "Istraživanje".',
  grants: 'VRSTA: grantovi, stipendije i fellowshipovi (master/PhD/istraživanje u inostranstvu, npr. Chevening, DAAD, Erasmus Mundus, Fulbright, Swiss Excellence, MEXT, regionalni i fakultetski grantovi). Uključi SAMO ono na šta se osoba iz BiH može prijaviti (provjeri državljanstvo u uslovima). kind postavi na "Grant".',
  spring: 'VRSTA: spring week / insight / ljetni programi i rane karijere (banke, quant firme, big tech: Spring Week, Summer Analyst, STEP, Explore, Insight programi), uz napomenu da li su namijenjeni prvoj/drugoj godini. kind postavi na "Program".',
} : {
  research: 'TYPE: research positions at universities, institutes and labs (research assistant, PhD positions, research internships, teaching assistant). Also use EURAXESS, Academic Positions, university sites (ETF, PMF Sarajevo, Zagreb, Belgrade, Ljubljana, ETH, TU) and research groups matching the profile. Set kind to "Istraživanje".',
  grants: 'TYPE: grants, scholarships and fellowships (master/PhD/research abroad, e.g. Chevening, DAAD, Erasmus Mundus, Fulbright, Swiss Excellence, MEXT, regional and university grants). Include ONLY what a person from Bosnia and Herzegovina can apply for (check citizenship in the eligibility terms). Set kind to "Grant".',
  spring: 'TYPE: spring weeks / insight programmes / summer programmes and early-careers schemes (banks, quant firms, big tech: Spring Week, Summer Analyst, STEP, Explore, Insight programmes), noting whether they target first/second-year students. Set kind to "Program".',
})[t]
// Visa / work-authorisation hint. A per-posting or per-company AI check (visa.json) wins over what the
// collector auto-detected from the posting text; both are hints, not legal advice.
const visaFor = (item, visa) => {
  const m = visa?.items || {}
  const v = m[item.id] || m['co:' + (item.company || '').toLowerCase()]
  if (v?.status && v.status !== 'unknown') return v
  if (item.visa) return { status: item.visa, note: item.visa_note, auto: true }
  return v || null
}
const VISA_CLS = { yes: 'ok', no: 'bad', citizen: 'bad', auth: 'warn', unknown: '' }
const visaLabel = (st) => ({ yes: L('Sponsors visa', 'Sponzoriše vizu'), no: L('No visa sponsorship', 'Bez sponzorstva vize'), citizen: L('Citizens / clearance only', 'Samo državljani / clearance'), auth: L('Work authorisation required', 'Potrebna dozvola rada'), unknown: L('Visa: unknown', 'Viza: nepoznato') }[st] || st)
function VisaPill({ v }) {
  if (!v?.status) return null
  const tip = `${v.note || ''}${v.url ? ' · ' + v.url : ''}${v.auto ? L(' (auto-detected from the posting text)', ' (automatski iz teksta oglasa)') : L(' (AI check)', ' (AI provjera)')}`.trim()
  return <span className={`cvb-pill ${VISA_CLS[v.status] || ''}`} title={tip}>{visaLabel(v.status)}</span>
}
const visaPrompt = (appId, item, key) => LANG === 'bs'
  ? `Provjeri sponzoriše li ovaj poslodavac radne vize / kakva je dozvola rada potrebna za kandidata iz profila (državljanstvo i lokacija su u profilu).
Pozicija: ${item.title}
Kompanija: ${item.company}
Lokacija: ${item.location || '-'}
Link: ${item.url || '-'}

1. Pročitaj profil /data/apps/${appId}/profile.json (polja location i citizenship u basics; ako državljanstvo ili dozvola rada nisu navedeni, NE pretpostavljaj ništa: ocijeni samo iz oglasa i u bilješci napiši da korisnik nije naveo državljanstvo).
2. Otvori oglas (WebFetch) i traži izjave o sponzorisanju vize, radnoj dozvoli, državljanstvu ili sigurnosnoj provjeri. Zatim pogledaj stranice kompanije (karijere / FAQ / „visa") i pretraži web za politiku sponzorisanja te kompanije za tu državu i ulogu (npr. EU Blue Card, H-1B, Skilled Worker). Preferiraj zvanične izvore.
3. Odredi status: "yes" (sponzoriše ili nudi preseljenje + vizu, izričito navedeno), "no" (izričito ne sponzoriše), "citizen" (traži državljanstvo ili sigurnosnu provjeru), "auth" (mora već imati dozvolu rada, bez info o sponzorstvu) ili "unknown". NIKAD ne pogađaj: "yes"/"no" samo uz izvor koji si stvarno pročitao. Dodaj kratku bilješku s dokazom i URL izvora.
4. Ažuriraj /data/apps/${appId}/visa.json (oblik {"updated":<ms>,"items":{"<ključ>":{"status":"...","note":"...","url":"...","at":<ms>}}}), spajajući s postojećim sadržajem: upiši pod ključ "${key}" (ova pozicija) i, ako politika važi za cijelu kompaniju, ISTO i pod "co:${(item.company || '').toLowerCase()}". Ne mijenjaj druge fajlove.
5. U chatu odgovori u 2 rečenice: presuda i izvor.`
  : `Check whether this employer sponsors work visas / what work authorisation is required, for the candidate described in the profile (citizenship and location are in the profile).
Position: ${item.title}
Company: ${item.company}
Location: ${item.location || '-'}
Link: ${item.url || '-'}

1. Read the profile /data/apps/${appId}/profile.json (see basics.location and basics.citizenship; if citizenship or work authorisation is not stated, do NOT assume anything: judge from the posting alone and say in the note that the user has not stated their citizenship).
2. Open the posting (WebFetch) and look for statements about visa sponsorship, work authorisation, citizenship or security clearance. Then check the company's careers / FAQ / "visa" pages and search the web for the company's sponsorship policy for that country and role (e.g. EU Blue Card, H-1B, Skilled Worker). Prefer official sources.
3. Decide the status: "yes" (explicitly sponsors, or offers relocation + visa support), "no" (explicitly does not sponsor), "citizen" (citizenship or security clearance required), "auth" (must already hold work authorisation, no sponsorship information) or "unknown". NEVER guess: use "yes"/"no" only with a source you actually read. Add a short note with the evidence and the source URL.
4. Update /data/apps/${appId}/visa.json (shape {"updated":<ms>,"items":{"<key>":{"status":"...","note":"...","url":"...","at":<ms>}}}), merging with the existing content: write the entry under the key "${key}" (this posting) and, if the policy is company-wide, ALSO under "co:${(item.company || '').toLowerCase()}". Do not change other files.
5. Reply in chat in 2 sentences: the verdict and the source.`

const matchCls = (n) => (n == null ? '' : n >= 55 ? 'ok' : n >= 30 ? 'warn' : '')

// Region filter — matches an ad's free-text location against country/region vocabularies.
const KW_BIH = ['bosnia', 'herzegovina', 'hercegovin', 'sarajevo', 'banja luka', 'banjaluka', 'tuzla', 'mostar', 'zenica', 'bijeljina', 'bih']
const KW_RS = ['serbia', 'srbija', 'belgrade', 'beograd', 'novi sad', 'kragujevac', 'subotica', 'niš']
const KW_HR = ['croatia', 'hrvatska', 'zagreb', 'split', 'rijeka', 'osijek', 'zadar', 'varaždin']
const KW_BALKAN = [...KW_BIH, ...KW_RS, ...KW_HR, 'slovenia', 'ljubljana', 'maribor', 'montenegro', 'crna gora', 'podgorica', 'macedonia', 'makedonij', 'skopje', 'kosovo', 'pristina', 'priština', 'albania', 'albanij', 'tirana']
const KW_EU = [...KW_BALKAN, 'europe', 'evrop', 'emea', 'united kingdom', 'london', 'manchester', 'ireland', 'dublin', 'germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg', 'france', 'paris', 'spain', 'madrid', 'barcelona', 'netherlands', 'amsterdam', 'poland', 'warsaw', 'krakow', 'sweden', 'stockholm', 'portugal', 'lisbon', 'porto', 'italy', 'rome', 'milan', 'austria', 'vienna', 'switzerland', 'zurich', 'geneva', 'belgium', 'brussels', 'denmark', 'copenhagen', 'norway', 'oslo', 'finland', 'helsinki', 'czech', 'prague', 'romania', 'bucharest', 'hungary', 'budapest', 'greece', 'athens', 'bulgaria', 'sofia', 'estonia', 'tallinn', 'lithuania', 'latvia', 'luxembourg']
const KW_ASIA = ['india', 'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'delhi', 'pune', 'gurgaon', 'noida', 'singapore', 'china', 'beijing', 'shanghai', 'shenzhen', 'japan', 'tokyo', 'korea', 'seoul', 'hong kong', 'taiwan', 'taipei', 'vietnam', 'hanoi', 'indonesia', 'jakarta', 'philippines', 'manila', 'thailand', 'bangkok', 'malaysia', 'kuala lumpur', 'pakistan', 'karachi', 'lahore', 'israel', 'tel aviv', 'united arab emirates', 'dubai', 'abu dhabi']
const KW_US = ['united states', 'usa', 'u.s.', 'new york', 'san francisco', 'bay area', 'seattle', 'boston', 'austin', 'chicago', 'los angeles', 'san jose', 'california', 'texas', 'washington', 'atlanta', 'denver', 'miami', 'canada', 'toronto', 'vancouver', 'montreal', 'ottawa', 'waterloo']
const KW_REMOTE = ['remote', 'anywhere', 'distributed', 'work from home', 'na daljinu']
const REGIONS = [['bih', 'BiH', KW_BIH], ['rs', 'Srbija', KW_RS], ['hr', 'Hrvatska', KW_HR], ['balkan', 'Balkan', KW_BALKAN], ['eu', 'Evropa', KW_EU], ['asia', 'Azija', KW_ASIA], ['us', 'Amerika', KW_US], ['remote', 'Remote', KW_REMOTE]]
const inRegion = (loc, v) => {
  if (!v) return true
  const r = REGIONS.find((x) => x[0] === v)
  if (!r) return true
  const s = (loc || '').toLowerCase()
  return r[2].some((k) => s.includes(k))
}

const getSections = () => [
  { key: 'education', label: L('Education', 'Obrazovanje'), hint: L('University, major, GPA, key courses', 'Fakultet, smjer, prosjek, bitni predmeti') },
  { key: 'experience', label: L('Experience', 'Iskustvo'), hint: L('Jobs, internships, volunteering', 'Posao, praksa, volontiranje') },
  { key: 'projects', label: L('Projects', 'Projekti'), hint: L('Personal, university, hackathons, GitHub', 'Lični, faks, hackatoni, GitHub') },
  { key: 'research', label: L('Research', 'Istraživanje'), hint: L('Papers, labs, mentors', 'Radovi, laboratorije, mentori') },
  { key: 'awards', label: L('Awards & competitions', 'Nagrade i takmičenja'), hint: L('Scholarships, rankings, certificates', 'Stipendije, rangiranja, certifikati') },
]
const EMPTY = { basics: { name: '', headline: '', email: '', phone: '', location: '', citizenship: '', links: '' }, skills: '', extra: '', education: [], experience: [], projects: [], research: [], awards: [] }
const STATUSES = ['Zanima me', 'Aplicirano', 'Intervju', 'Odbijeno', 'Ponuda']
const uid = () => Math.random().toString(36).slice(2, 10)
const daysLeft = (d) => (d ? Math.ceil((new Date(d) - new Date(new Date().toDateString())) / 864e5) : null)

const CSS = `
* { box-sizing: border-box; }
.cvb { min-height: 100%; color: var(--text); background: var(--bg); font-family: var(--font); padding: 16px 16px 80px; max-width: 860px; margin: 0 auto; }
.cvb h1 { font-size: 22px; margin: 0 0 4px; }
.cvb .sub { color: var(--muted); font-size: 14px; margin-bottom: 16px; }
.cvb-tabs { display: flex; gap: 6px; margin-bottom: 18px; background: var(--surface); padding: 4px; border-radius: 12px; border: 1px solid var(--border); }
.cvb-tab { flex: 1; min-height: 44px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer; }
.cvb-tab[aria-selected=true] { background: var(--accent); color: #fff; }
.cvb-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
.cvb-card h3 { margin: 0 0 8px; font-size: 15px; }
.cvb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 560px) { .cvb-grid { grid-template-columns: 1fr; } }
.cvb input, .cvb textarea, .cvb select { width: 100%; min-height: 44px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2, var(--bg)); color: var(--text); font: inherit; font-size: 15px; }
.cvb textarea { resize: vertical; min-height: 88px; line-height: 1.45; }
.cvb label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
.cvb-btn { min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; justify-content: center; }
.cvb-btn.pri { background: var(--accent); border-color: var(--accent); color: #fff; }
.cvb-btn:disabled { opacity: .5; cursor: default; }
.cvb-btn:focus-visible, .cvb input:focus-visible, .cvb textarea:focus-visible, .cvb-job:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cvb-icon { width: 44px; padding: 0; }
.cvb-entry { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px; }
.cvb-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cvb-job { display: block; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin-bottom: 10px; }
.cvb-job b { font-size: 16px; }
.cvb-meta { color: var(--muted); font-size: 13px; display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; align-items: center; }
.cvb-pill { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 99px; background: var(--surface-2, var(--border)); color: var(--text); }
.cvb-pill.warn { background: #f59e0b33; color: #b45309; }
.cvb-pill.bad { background: #ef444433; color: #b91c1c; }
.cvb-pill.ok { background: #10b98133; color: #047857; }
.cvb-src { font-size: 12px; color: var(--muted); }
.cvb-item { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px; margin-bottom: 10px; display: flex; gap: 10px; align-items: flex-start; }
.cvb-item .grow { flex: 1; min-width: 0; }
.cvb-item b { font-size: 15px; display: block; overflow-wrap: anywhere; }
.cvb-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.cvb-chip { min-height: 36px; padding: 0 12px; border-radius: 99px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
.cvb-chip[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: #fff; }
.cvb-empty { text-align: center; color: var(--muted); padding: 36px 12px; }
.cvb-score { font-size: 44px; font-weight: 800; line-height: 1; }
.cvb-list { margin: 6px 0 0; padding-left: 18px; line-height: 1.5; font-size: 14px; }
.cvb-cv { white-space: pre-wrap; font-size: 14px; line-height: 1.5; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.cvb-busy { display: flex; gap: 10px; align-items: center; color: var(--muted); }
.cvb-spin { animation: cvbspin 1s linear infinite; }
@keyframes cvbspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cvb-spin { animation: none; } }
`

function Field({ label, value, onChange, area, type, placeholder }) {
  return (
    <div>
      <label>{label}</label>
      {area ? <textarea value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /> : <input type={type || 'text'} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
    </div>
  )
}

const SEC_KEYS = ['education', 'experience', 'projects', 'research', 'awards']
// Merge an imported profile into the current one without overwriting anything the user already wrote.
function mergeImported(cur, imp) {
  const next = { ...cur, basics: { ...cur.basics } }
  for (const [k, v] of Object.entries(imp.basics || {})) if (typeof v === 'string' && v.trim() && !String(next.basics[k] || '').trim()) next.basics[k] = v.trim()
  for (const sec of SEC_KEYS) {
    const have = new Set((cur[sec] || []).map((e) => `${e.title}|${e.org}`.toLowerCase().trim()))
    const add = (imp[sec] || []).filter((e) => e && (e.title || e.text)).filter((e) => !have.has(`${e.title || ''}|${e.org || ''}`.toLowerCase().trim()))
      .map((e) => ({ id: uid(), title: e.title || '', org: e.org || '', period: e.period || '', text: e.text || '' }))
    next[sec] = [...(cur[sec] || []), ...add]
  }
  for (const k of ['skills', 'extra']) {
    const v = typeof imp[k] === 'string' ? imp[k].trim() : ''
    if (v && !String(cur[k] || '').toLowerCase().includes(v.toLowerCase())) next[k] = cur[k] ? `${cur[k]}\n${v}` : v
  }
  return next
}
const countImported = (imp) => SEC_KEYS.reduce((n, s) => n + (imp[s]?.length || 0), 0)

function ImportCard({ appId, profile, setProfile, openChat, setError }) {
  const store = window.mobius.storage
  const [state, setState] = useState(null) // {startedAt, chatId} while waiting
  const [proposal, setProposal] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => { // pick up a result left from an earlier session
    store.get('import/state.json').then((s) => { if (s) setState(s) }).catch(() => {})
    store.get('import/profile.json').then((p) => { if (p && !p.applied) setProposal(p) }).catch(() => {})
  }, [store])
  useEffect(() => {
    if (!state?.startedAt || proposal) return
    const t = setInterval(async () => {
      const p = await store.get('import/profile.json').catch(() => null)
      if (p && p.at >= state.startedAt && !p.applied) setProposal(p)
    }, 4000)
    return () => clearInterval(t)
  }, [state?.startedAt, proposal, store])

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > 5 * 1024 * 1024) { setError(L('File is larger than 5 MB.', 'Fajl je veći od 5 MB.')); return }
    setBusy(true); setError('')
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      const startedAt = Date.now()
      await store.set('import/cv.json', { name: f.name, type: f.type, size: f.size, b64: btoa(bin) })
      const prompt = `Import an existing CV into the CV Builder profile (app id ${appId}).

1. Read /data/apps/${appId}/import/cv.json. It is JSON {name, type, size, b64}: base64 of the uploaded CV file. Decode b64 into a file in your scratch directory ($TMPDIR) keeping the extension from "name".
2. Get its text: for PDF or an image use the Read tool on the decoded file (PDFs and images are supported); for .docx use python-docx (pip install python-docx if missing) or unzip word/document.xml; for .txt/.md just read it. If you cannot read it, say so plainly in chat and write nothing.
3. Extract ONLY what the document actually says. Never invent or embellish. Keep the document's own language. Put concrete detail (technologies, numbers, results) into each entry's "text".
4. Write /data/apps/${appId}/import/profile.json with exactly this shape (omit nothing, use "" or [] when unknown):
{"at": ${startedAt}, "basics": {"name": "", "headline": "", "email": "", "phone": "", "location": "", "citizenship": "", "links": ""}, "skills": "", "extra": "", "education": [{"title": "degree / programme", "org": "institution", "period": "", "text": ""}], "experience": [{"title": "role", "org": "employer", "period": "", "text": ""}], "projects": [{"title": "", "org": "", "period": "", "text": ""}], "research": [{"title": "", "org": "", "period": "", "text": ""}], "awards": [{"title": "", "org": "", "period": "", "text": ""}]}
"at" must be exactly that number. Put publications under research, certificates and competitions under awards, languages and tools into skills, anything else worth keeping into extra. Do not touch /data/apps/${appId}/profile.json or any other file.
5. Delete the decoded copy and /data/apps/${appId}/import/cv.json when done (it is personal data). Reply in chat with 2 sentences: what you found.`
      const { chatId } = await window.mobius.chat.start({ draft: prompt, title: L('Import CV', 'Uvoz CV-a') })
      const s = { startedAt, chatId, name: f.name }
      setState(s); setProposal(null)
      await store.set('import/state.json', s)
    } catch (err) { setError(L('Import failed: ', 'Uvoz nije uspio: ') + err.message) }
    setBusy(false)
  }

  const apply = async () => {
    setProfile(mergeImported(profile, proposal))
    await store.set('import/profile.json', { ...proposal, applied: true }).catch(() => {})
    setProposal(null); setState(null)
    store.set('import/state.json', null).catch(() => {})
  }
  const discard = async () => {
    await store.set('import/profile.json', { ...proposal, applied: true }).catch(() => {})
    setProposal(null); setState(null)
    store.set('import/state.json', null).catch(() => {})
  }
  const waiting = state?.startedAt && !proposal

  return (
    <div className="cvb-card">
      <h3>{L('Import an existing CV', 'Uvezi postojeći CV')}</h3>
      <div className="sub" style={{ margin: '0 0 10px' }}>{L('Upload a PDF, Word or text CV and the AI fills in your profile. You review it before anything is added, and nothing you already wrote is overwritten.', 'Učitaj CV (PDF, Word ili tekst) i AI popuni profil. Pregledaš prije nego se išta doda, a ništa što si već napisao/la se ne briše.')}</div>
      <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" onChange={onFile} style={{ display: 'none' }} aria-label={L('Choose CV file', 'Izaberi CV fajl')} />
      <div className="cvb-row">
        <button className="cvb-btn pri" disabled={busy || waiting} onClick={() => fileRef.current?.click()}><Plus width={16} height={16} /> {busy ? L('Uploading…', 'Šaljem…') : L('Choose CV file', 'Izaberi CV fajl')}</button>
        {state?.chatId && <button className="cvb-btn" onClick={() => openChat(state.chatId)}>{L('Open AI chat', 'Otvori AI chat')}</button>}
      </div>
      {waiting && <div className="cvb-busy" style={{ marginTop: 12 }}><Reload className="cvb-spin" width={18} height={18} /> {L('AI is reading your CV… the result appears here.', 'AI čita tvoj CV… rezultat se pojavi ovdje.')}</div>}
      {proposal && (
        <div style={{ marginTop: 12 }}>
          <b>{L('Found', 'Pronađeno')}: </b>
          <span className="sub">{[proposal.basics?.name, `${countImported(proposal)} ${L('entries', 'unosa')}`, proposal.skills ? L('skills', 'vještine') : ''].filter(Boolean).join(' · ')}</span>
          <ul className="cvb-list">
            {SEC_KEYS.filter((s) => proposal[s]?.length).map((s) => <li key={s}>{proposal[s].length} × {({ education: L('Education', 'Obrazovanje'), experience: L('Experience', 'Iskustvo'), projects: L('Projects', 'Projekti'), research: L('Research', 'Istraživanje'), awards: L('Awards', 'Nagrade') })[s]}: {proposal[s].slice(0, 3).map((e) => e.title || e.org).filter(Boolean).join(', ')}{proposal[s].length > 3 ? '…' : ''}</li>)}
          </ul>
          <div className="cvb-row" style={{ marginTop: 10 }}>
            <button className="cvb-btn pri" onClick={apply}><Check width={16} height={16} /> {L('Add to my profile', 'Dodaj u moj profil')}</button>
            <button className="cvb-btn" onClick={discard}>{L('Discard', 'Odbaci')}</button>
          </div>
          <div className="sub" style={{ marginTop: 8 }}>{L('Review and edit the entries below after adding.', 'Nakon dodavanja pregledaj i uredi unose ispod.')}</div>
        </div>
      )}
    </div>
  )
}

function ProfileTab({ profile, setProfile, appId, openChat, setError }) {
  const set = (patch) => setProfile({ ...profile, ...patch })
  const setBasic = (k, v) => set({ basics: { ...profile.basics, [k]: v } })
  const updEntry = (sec, id, patch) => set({ [sec]: profile[sec].map((e) => (e.id === id ? { ...e, ...patch } : e)) })
  return (
    <div>
      <ImportCard appId={appId} profile={profile} setProfile={setProfile} openChat={openChat} setError={setError} />
      <div className="cvb-card">
        <h3>{L('Basics', 'Osnovno')}</h3>
        <div className="cvb-grid">
          <Field label={L('Full name', 'Ime i prezime')} value={profile.basics.name} onChange={(v) => setBasic('name', v)} />
          <Field label={L('Headline (e.g. CS student, SE/Data)', 'Naslov (npr. student računarstva, SE/Data)')} value={profile.basics.headline} onChange={(v) => setBasic('headline', v)} />
          <Field label="Email" value={profile.basics.email} onChange={(v) => setBasic('email', v)} />
          <Field label={L('Phone', 'Telefon')} value={profile.basics.phone} onChange={(v) => setBasic('phone', v)} />
          <Field label={L('Location', 'Lokacija')} value={profile.basics.location} onChange={(v) => setBasic('location', v)} />
          <Field label={L('Citizenship / work authorisation (used for visa checks)', 'Državljanstvo / dozvola rada (koristi se za provjeru vize)')} value={profile.basics.citizenship || ''} onChange={(v) => setBasic('citizenship', v)} placeholder={L('e.g. Bosnian citizen, no EU work permit', 'npr. državljanin BiH, bez EU dozvole rada')} />
          <Field label={L('Links (GitHub, LinkedIn)', 'Linkovi (GitHub, LinkedIn)')} value={profile.basics.links} onChange={(v) => setBasic('links', v)} />
        </div>
      </div>
      {getSections().map((s) => (
        <div className="cvb-card" key={s.key}>
          <div className="cvb-row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{s.label}</h3>
            <button className="cvb-btn" onClick={() => set({ [s.key]: [...profile[s.key], { id: uid(), title: '', org: '', period: '', text: '' }] })}><Plus width={16} height={16} /> {L('Add', 'Dodaj')}</button>
          </div>
          {profile[s.key].length === 0 && <div className="sub" style={{ margin: '8px 0 0' }}>{s.hint}</div>}
          {profile[s.key].map((e) => (
            <div className="cvb-entry" key={e.id}>
              <div className="cvb-grid">
                <Field label={L('Title / role', 'Naziv / uloga')} value={e.title} onChange={(v) => updEntry(s.key, e.id, { title: v })} />
                <Field label={L('Organization', 'Organizacija')} value={e.org} onChange={(v) => updEntry(s.key, e.id, { org: v })} />
              </div>
              <Field label={L('Period', 'Period')} value={e.period} onChange={(v) => updEntry(s.key, e.id, { period: v })} placeholder={L('e.g. 06/2025 – 09/2025', 'npr. 06/2025 – 09/2025')} />
              <Field area label={L('What you did (include everything: numbers, technologies, results)', 'Šta si radio/la (piši sve, brojke, tehnologije, rezultati)')} value={e.text} onChange={(v) => updEntry(s.key, e.id, { text: v })} />
              <button className="cvb-btn" style={{ marginTop: 8 }} onClick={() => set({ [s.key]: profile[s.key].filter((x) => x.id !== e.id) })}><Trash width={16} height={16} /> {L('Remove', 'Ukloni')}</button>
            </div>
          ))}
        </div>
      ))}
      <div className="cvb-card">
        <h3>{L('Skills', 'Vještine')}</h3>
        <Field area label={L('Programming languages, tools, frameworks, maths, spoken languages…', 'Jezici, alati, frameworci, matematika, jezici (govorni)…')} value={profile.skills} onChange={(v) => set({ skills: v })} />
      </div>
      <div className="cvb-card">
        <h3>{L('Everything else about me', 'Sve ostalo o meni')}</h3>
        <Field area label={L('Hobbies, volunteering, goals, anything that might be relevant. The AI picks what to use.', 'Hobiji, volontiranje, ciljevi, bilo šta što bi moglo biti relevantno. AI bira šta će upotrijebiti.')} value={profile.extra} onChange={(v) => set({ extra: v })} />
      </div>
    </div>
  )
}

function DeadlinePill({ d }) {
  const n = daysLeft(d)
  if (n == null) return null
  const cls = n < 0 ? 'bad' : n <= 7 ? 'warn' : 'ok'
  return <span className={`cvb-pill ${cls}`}>{n < 0 ? L('Expired', 'Isteklo') : n === 0 ? L('Due today', 'Ističe danas') : L(`${n} d left`, `Još ${n} d`)}</span>
}

function JobForm({ onSave, onCancel }) {
  const [j, setJ] = useState({ title: '', company: '', url: '', posted: '', deadline: '', text: '' })
  const u = (k) => (v) => setJ({ ...j, [k]: v })
  return (
    <div className="cvb-card">
      <h3>{L('New position', 'Nova pozicija')}</h3>
      <div className="cvb-grid">
        <Field label={L('Position', 'Pozicija')} value={j.title} onChange={u('title')} placeholder={L('e.g. Quant Research Intern', 'npr. Quant Research Intern')} />
        <Field label={L('Company / institution', 'Kompanija / institucija')} value={j.company} onChange={u('company')} />
        <Field label={L('Date posted', 'Datum objave')} type="date" value={j.posted} onChange={u('posted')} />
        <Field label={L('Application deadline', 'Rok prijave')} type="date" value={j.deadline} onChange={u('deadline')} />
      </div>
      <Field label="Link" value={j.url} onChange={u('url')} />
      <Field area label={L('Posting text (paste all of it; with a link, the text is optional)', 'Tekst oglasa (zalijepi cijeli; ako imaš link, može i bez teksta)')} value={j.text} onChange={u('text')} />
      <div className="cvb-row" style={{ marginTop: 12 }}>
        <button className="cvb-btn pri" disabled={!j.title.trim() || !(j.text.trim() || j.url.trim())} onClick={() => onSave(j)}>{L('Save', 'Spremi')}</button>
        <button className="cvb-btn" onClick={onCancel}>{L('Cancel', 'Odustani')}</button>
      </div>
    </div>
  )
}

function JobDetail({ job, result, busy, onBack, onTailor, onUpdate, onDelete, chatId, openChat, visa, onCheckVisa }) {
  const [copied, setCopied] = useState(false)
  const copy = async (what) => {
    const text = what === 'tex' ? buildLatex(result.cv_markdown) : result.cv_markdown || ''
    const ok = await window.mobius.clipboard.writeText(text)
    if (ok) { setCopied(what); setTimeout(() => setCopied(false), 1500) }
  }
  const overleafName = `CV ${job.company || ''} ${job.title || ''}`.replace(/\s+/g, ' ').trim().slice(0, 80)
  return (
    <div>
      <button className="cvb-btn" onClick={onBack}><ArrowLeft width={16} height={16} /> {L('Positions', 'Pozicije')}</button>
      <div className="cvb-card" style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 18 }}>{job.title}</h3>
        <div className="sub" style={{ margin: 0 }}>{job.company}</div>
        <div className="cvb-meta">
          {job.posted && <span><Calendar width={14} height={14} /> {L('Posted', 'Objavljeno')} {job.posted}</span>}
          {job.deadline && <span>{L('Deadline', 'Rok')} {job.deadline}</span>}
          <DeadlinePill d={job.deadline} />
          <VisaPill v={visaFor({ id: job.fromDiscover || job.id, company: job.company }, visa)} />
          {job.url && <a href={job.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}><Link width={14} height={14} /> {L('Posting', 'Oglas')}</a>}
        </div>
        <label>{L('Status', 'Status')}</label>
        <select value={job.status} onChange={(e) => onUpdate({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select>
        <div className="cvb-row" style={{ marginTop: 12 }}>
          <button className="cvb-btn pri" disabled={busy} onClick={onTailor}><Sparkles width={16} height={16} /> {result ? L('Tailor again', 'Ponovo prilagodi') : L('Tailor CV', 'Prilagodi CV')}</button>
          <button className="cvb-btn" onClick={onCheckVisa}>{L('Check visa / work authorisation', 'Provjeri vizu / dozvolu rada')}</button>
          {chatId && <button className="cvb-btn" onClick={() => openChat(chatId)}>{L('Open AI chat', 'Otvori chat s AI-jem')}</button>}
          <button className="cvb-btn cvb-icon" aria-label={L('Delete position', 'Obriši poziciju')} onClick={onDelete}><Trash width={16} height={16} /></button>
        </div>
        {busy && <div className="cvb-busy" style={{ marginTop: 12 }}><Reload className="cvb-spin" width={18} height={18} /> {L('The AI is reading your profile and the posting… the result will appear here.', 'AI čita profil i oglas… rezultat se pojavi ovdje.')}</div>}
      </div>
      {result && (
        <>
          <div className="cvb-card">
            <div className="cvb-row" style={{ gap: 16 }}>
              <div className="cvb-score">{result.fit}<span style={{ fontSize: 18, color: 'var(--muted)' }}>/100</span></div>
              <div style={{ flex: 1, minWidth: 200 }}><b>{L('Fit', 'Podudarnost')}</b><div className="sub" style={{ margin: 0 }}>{result.summary}</div></div>
            </div>
          </div>
          {result.strengths?.length > 0 && <div className="cvb-card"><h3>{L('What you already have', 'Šta već imaš')}</h3><ul className="cvb-list">{result.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
          {result.gaps?.length > 0 && <div className="cvb-card"><h3>{L('What is missing and how to fix it', 'Šta fali i kako popraviti')}</h3><ul className="cvb-list">{result.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
          <div className="cvb-card">
            <div className="cvb-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>{L('Tailored CV', 'Prilagođen CV')}</h3>
              <div className="cvb-row">
              {chatId && <button className="cvb-btn pri" onClick={() => openChat(chatId)}><Document width={16} height={16} /> {L('PDF, Word & LaTeX (in chat)', 'PDF, Word i LaTeX (u chatu)')}</button>}
              <button className="cvb-btn" onClick={() => openInOverleaf(buildLatex(result.cv_markdown), overleafName)}><Link width={16} height={16} /> {L('Open in Overleaf', 'Otvori u Overleafu')}</button>
              <button className="cvb-btn" onClick={() => copy('tex')}>{copied === 'tex' ? <Check width={16} height={16} /> : <Copy width={16} height={16} />} {copied === 'tex' ? L('Copied', 'Kopirano') : 'LaTeX'}</button>
              <button className="cvb-btn" onClick={() => copy('md')}>{copied === 'md' ? <Check width={16} height={16} /> : <Copy width={16} height={16} />} {copied === 'md' ? L('Copied', 'Kopirano') : L('Copy', 'Kopiraj')}</button>
              </div>
            </div>
            <div className="cvb-cv">{result.cv_markdown}</div>
          </div>
        </>
      )}
    </div>
  )
}

function DiscoverTab({ appId, token, jobs, onAdd, setError, openChat, profile, visa, onCheckVisa }) {
  const store = window.mobius.storage
  const [data, setData] = useState(null)
  const [sources, setSources] = useState(null)
  const [aiFinds, setAiFinds] = useState([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [running, setRunning] = useState(false)
  const [showSrc, setShowSrc] = useState(false)
  const [showAi, setShowAi] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiNote, setAiNote] = useState('')
  const [sort, setSort] = useState('new')
  const [region, setRegion] = useState('')
  const [showExpired, setShowExpired] = useState(false)
  const [aiType, setAiType] = useState('')
  const [visaF, setVisaF] = useState('')
  const [adding, setAdding] = useState('')
  const pset = useMemo(() => profileTokenSet(profile || {}), [profile])
  const load = useCallback(async () => {
    try { setData(await store.get('discover.json')); setSources(await store.get('sources.json')) } catch (e) { setError(L('Could not load the list: ', 'Učitavanje liste nije uspjelo: ') + e.message) }
  }, [store])
  useEffect(() => { load() }, [load])
  // AI finds are written by an agent chat turn, so watch the file for live updates.
  useEffect(() => store.subscribe('ai-finds.json', (v) => setAiFinds(v?.items || [])), [store])

  const refresh = async () => {
    setRunning(true); setError('')
    const before = data?.updated || 0
    try {
      const r = await fetch(`/api/apps/${appId}/run-job`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 3000))
        const d = await store.get('discover.json').catch(() => null)
        if (d && d.updated > before) { setData(d); setSources(await store.get('sources.json')); setRunning(false); return }
      }
      setError(L('Refreshing is taking longer than usual. Try again in a minute.', 'Osvježavanje traje duže nego obično. Pokušaj ponovo za minut.'))
    } catch (e) { setError(L('Refresh failed: ', 'Osvježavanje nije uspjelo: ') + e.message) }
    setRunning(false)
  }

  const saveSources = async (patch) => {
    const next = { ...sources, ...patch }
    setSources(next)
    try { await store.set('sources.json', next) } catch (e) { setError(L('Could not save sources: ', 'Spremanje izvora nije uspjelo: ') + e.message) }
  }
  const lines = (v) => v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)

  const runAiSearch = async () => {
    setError(''); setAiNote('')
    const extra = aiText.trim()
    const regLabel = region ? regionLabel(region) : ''
    const today = new Date().toISOString().slice(0, 10)
    const bs = LANG === 'bs'
    const typeLine = aiType ? `\n   ${aiTypePrompt(aiType)}` : ''
    const regionLine = regLabel
      ? (bs ? `\n   REGIJA/FOKUS: ${regLabel}. Traži oglase čija je lokacija u toj regiji (ili remote za tu regiju) i koristi lokalne job portale te regije (npr. za Balkan: posao.ba, kolektiv.ba, boljiposao.com, poslovi.infostud.com, mojposao.net, helloworld.rs; za Evropu/Aziju odgovarajuće regionalne portale).`
        : `\n   REGION/FOCUS: ${regLabel}. Look for postings located in that region (or remote for that region) and use that region's local job portals (e.g. for the Balkans: posao.ba, kolektiv.ba, boljiposao.com, poslovi.infostud.com, mojposao.net, helloworld.rs; for Europe/Asia the matching regional portals).`)
      : ''
    const extraLine = extra
      ? (bs ? `\n   Korisnik je posebno tražio: """${extra}"""  — ovo ispoštuj (konkretni sajtovi, firme, gradovi ili oblasti).` : `\n   The user specifically asked for: """${extra}"""  — honour this (specific sites, companies, cities or fields).`)
      : (regLabel ? '' : (bs ? `\n   Pošto korisnik nije zadao filter, fokus na lokaciju iz profila (grad i region) + relevantne remote prakse iz profila.` : `\n   The user gave no filter, so focus on the location in the profile (city and region) plus relevant remote internships matching the profile.`))
    const prompt = bs ? `Pronađi AKTUELNE otvorene prakse / junior pozicije za korisnika aplikacije CV Builder (app id ${appId}) i upiši ih u fajl koji aplikacija čita.

1. Pročitaj profil korisnika: /data/apps/${appId}/profile.json (lokacija, vještine, oblast interesa). Iz njega izvuci ključne riječi i grad/regiju.
2. Pretraži web (WebSearch/WebFetch) za trenutno OTVORENE prakse, pripravništva, akademije i junior/entry pozicije koje odgovaraju profilu.${typeLine}${regionLine}${extraLine}
3. Uzmi SAMO stvarne, trenutno otvorene oglase s ispravnim linkom i rokom koji nije istekao (danas je ${today}); rok upiši samo ako si ga stvarno vidio na stranici. NIKAD ne izmišljaj oglas, firmu, rok ni link. Ako nešto nisi mogao potvrditi, preskoči.
4. Spoji s postojećim nalazima: pročitaj /data/apps/${appId}/ai-finds.json ako postoji (oblik {"updated":<ms>,"items":[...]}), i zadrži ranije stavke koje su i dalje validne. Dedupliciraj po url-u.
5. Upiši nazad /data/apps/${appId}/ai-finds.json tačno ovog oblika:
{"updated": <trenutni ms epoch>, "items": [ {"id":"ai-<kratki jedinstveni>", "source":"AI pretraga", "kind":"Praksa|Full-time|Istraživanje|Grant|Program", "title":"...", "company":"...", "location":"...", "url":"https://...", "posted":"YYYY-MM-DD ili prazno", "deadline":"YYYY-MM-DD ili prazno", "category":"", "visa":"yes|no|citizen|auth ili prazno (samo ako piše na stranici)", "visa_note":"", "text":"kratak opis / zašto odgovara"} ] }
Najviše ~25 najrelevantnijih. Ne mijenjaj druge fajlove.
6. U chatu kratko (2-3 rečenice) reci koliko si našao i par najzanimljivijih. Nalazi se automatski pojave u kartici „Otkrij" pod izvorom „AI pretraga".` : `Find CURRENT, open internships / junior positions for the user of the CV Builder app (app id ${appId}) and write them to the file the app reads.

1. Read the user's profile: /data/apps/${appId}/profile.json (location, skills, interests). Extract keywords and the city/region from it.
2. Search the web (WebSearch/WebFetch) for currently OPEN internships, trainee programmes, academies and junior/entry roles that match the profile.${typeLine}${regionLine}${extraLine}
3. Include ONLY real, currently open postings with a working link and a deadline that has not passed (today is ${today}); write a deadline only if you actually saw it on the page. NEVER invent a posting, company, deadline or link. If you could not confirm something, skip it.
4. Merge with existing finds: read /data/apps/${appId}/ai-finds.json if it exists (shape {"updated":<ms>,"items":[...]}) and keep earlier items that are still valid. De-duplicate by url.
5. Write /data/apps/${appId}/ai-finds.json back in exactly this shape:
{"updated": <current ms epoch>, "items": [ {"id":"ai-<short unique>", "source":"AI pretraga", "kind":"Praksa|Full-time|Istraživanje|Grant|Program", "title":"...", "company":"...", "location":"...", "url":"https://...", "posted":"YYYY-MM-DD or empty", "deadline":"YYYY-MM-DD or empty", "category":"", "visa":"yes|no|citizen|auth or empty (only if the page states it)", "visa_note":"", "text":"short description / why it fits (in English)"} ] }
Keep the literal values "AI pretraga" for source and the exact kind values listed (Praksa = internship, Istraživanje = research); the app translates them for display. At most ~25 of the most relevant. Do not change other files.
6. In chat, reply briefly (2-3 sentences, in English) with how many you found and a few highlights. The finds appear automatically in the "Discover" tab under the source "AI search".`
    try {
      const { chatId } = await window.mobius.chat.start({ draft: prompt, title: L('AI opportunity search', 'AI pretraga praksi') })
      setAiNote(L('AI search started in the chat — finds appear here as soon as the AI writes them.', 'AI pretraga je pokrenuta u chatu — nalazi se pojave ovdje čim ih AI upiše.')); setShowAi(false)
      if (chatId && openChat) openChat(chatId)
    } catch (e) { setError(L('Could not start the AI search: ', 'Pokretanje AI pretrage nije uspjelo: ') + e.message) }
  }

  const addItem = async (it) => {
    setAdding(it.id)
    let text = it.text || ''
    if (!text && it.gh) {
      try {
        const res = await fetch(`/api/proxy?url=${encodeURIComponent(`https://boards-api.greenhouse.io/v1/boards/${it.gh[0]}/jobs/${it.gh[1]}`)}`, { headers: { Authorization: `Bearer ${token}` } })
        const j = await res.json()
        const html = new DOMParser().parseFromString(j.content || '', 'text/html')
        text = (html.documentElement.textContent || '').replace(/\s+\n/g, '\n').trim().slice(0, 6000)
      } catch (e) { /* the agent will read the link instead */ }
    }
    await onAdd({ title: it.title, company: it.company, url: it.url, posted: it.posted, deadline: it.deadline || '', text, fromDiscover: it.id })
    setAdding('')
  }

  const have = new Set(jobs.map((j) => j.fromDiscover).filter(Boolean))
  const visaOk = (v, f) => !f || (f === 'yes' ? v?.status === 'yes' : !(v?.status === 'no' || v?.status === 'citizen'))
  const scored = [...aiFinds, ...(data?.items || [])].map((i) => ({ ...i, _score: matchScore(i, pset) }))
  const items = scored
    .filter((i) => (!kind || i.kind === kind) && inRegion(i.location, region) && visaOk(visaFor(i, visa), visaF) && (showExpired || !(i.deadline && daysLeft(i.deadline) < 0)) && (!q || `${i.title} ${i.company} ${i.location}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (sort === 'match' ? (b._score ?? -1) - (a._score ?? -1) : 0))
  const age = data?.updated ? Math.round((Date.now() - data.updated) / 36e5) : null

  return (
    <div>
      <div className="cvb-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="cvb-src">{data ? L(`${data.count} positions · refreshed ${age < 1 ? 'less than an hour' : age + ' h'} ago · automatically every day at 07:00`, `${data.count} pozicija · osvježeno prije ${age < 1 ? 'manje od sata' : age + ' h'} · automatski svaki dan u 07:00`) : L('No list yet. Click Refresh.', 'Još nema liste. Klikni Osvježi.')}</div>
        <div className="cvb-row">
          <button className="cvb-btn" onClick={() => { setShowAi(!showAi); setShowSrc(false) }}><Sparkles width={16} height={16} /> {L('AI search', 'AI pretraga')}</button>
          <button className="cvb-btn" onClick={() => { setShowSrc(!showSrc); setShowAi(false) }}>{L('Sources', 'Izvori')}</button>
          <button className="cvb-btn pri" disabled={running} onClick={refresh}><Reload width={16} height={16} className={running ? 'cvb-spin' : ''} /> {running ? L('Searching…', 'Traži…') : L('Refresh', 'Osvježi')}</button>
        </div>
      </div>
      {aiNote && <div className="cvb-card" style={{ borderColor: 'var(--accent)' }}><div className="cvb-busy"><Sparkles width={16} height={16} /> {aiNote}</div></div>}
      {showAi && (
        <div className="cvb-card">
          <h3>{L('AI opportunity search', 'AI pretraga praksi')}</h3>
          <div className="cvb-src" style={{ marginBottom: 8 }}>{L('The AI searches the web for current opportunities matching your profile and adds them here under “AI search”. A chat opens where you can follow the progress.', 'AI pretraži web za aktuelne prakse prema tvom profilu i upiše ih ovdje pod „AI pretraga". Otvara se chat u kojem vidiš napredak.')}{region ? L(` Focus: ${regionLabel(region)} (from the region filter below).`, ` Fokus: ${regionLabel(region)} (iz filtera regije dolje).`) : ''}</div>
          <label>{L('What are you looking for', 'Šta tražiš')}</label>
          <div className="cvb-chips">
            {aiTypes().map(([k, l]) => <button key={k} className="cvb-chip" aria-pressed={aiType === k} onClick={() => setAiType(k)}>{l}</button>)}
          </div>
          <Field area label={L('Optional: specific sites, companies, cities or fields (empty = your location + profile)', 'Opcionalno: konkretni sajtovi, firme, gradovi ili oblasti (prazno = tvoja lokacija + profil)')} value={aiText} onChange={setAiText} placeholder={L('e.g. infobip.com/careers, mistral.ba, remote ML internships', 'npr. infobip.com/careers, mistral.ba, remote ML prakse')} />
          <button className="cvb-btn pri" style={{ marginTop: 10 }} onClick={runAiSearch}><Sparkles width={16} height={16} /> {L('Run AI search', 'Pokreni AI pretragu')}</button>
        </div>
      )}
      {data?.errors?.length > 0 && <div className="cvb-src" style={{ marginBottom: 8 }}>{L('Some sources did not respond: ', 'Neki izvori nisu odgovorili: ')}{data.errors.join('; ')}</div>}
      {showSrc && sources && (
        <div className="cvb-card">
          <h3>{L('Where to search', 'Odakle se traži')}</h3>
          <Field area label={L('Keywords in the title (comma or new line)', 'Ključne riječi u nazivu (zarezom ili novi red)')} value={(sources.keywords || []).join(', ')} onChange={(v) => saveSources({ keywords: lines(v) })} />
          <Field area label={L('Greenhouse companies (e.g. stripe, databricks): the token from boards.greenhouse.io/<token>', 'Greenhouse kompanije (npr. stripe, databricks) – oznaka iz linka boards.greenhouse.io/<oznaka>')} value={(sources.greenhouse || []).join(', ')} onChange={(v) => saveSources({ greenhouse: lines(v) })} />
          <Field area label={L('Lever companies: the token from jobs.lever.co/<token>', 'Lever kompanije – oznaka iz linka jobs.lever.co/<oznaka>')} value={(sources.lever || []).join(', ')} onChange={(v) => saveSources({ lever: lines(v) })} />
          <Field area label={L('Recruitee companies (local/regional, e.g. zira): the token from <token>.recruitee.com', 'Recruitee kompanije (lokalne/regionalne, npr. zira) – oznaka iz linka <oznaka>.recruitee.com')} value={(sources.recruitee || []).join(', ')} onChange={(v) => saveSources({ recruitee: lines(v) })} />
          <div className="cvb-src" style={{ margin: '0 0 8px' }}>{L('Recruitee, Workable and EURAXESS sources you add show every currently open position (no keyword or age filter) because you picked them by hand.', 'Recruitee kompanije koje sam dodaš prikazuju sve trenutno otvorene pozicije (bez filtera ključnih riječi i starosti), jer su ručno odabrane.')}</div>
          <Field label={L('Posting age (days)', 'Starost oglasa (dana)')} type="number" value={sources.max_age_days ?? 90} onChange={(v) => saveSources({ max_age_days: Number(v) || 90 })} />
          <div className="cvb-src" style={{ marginTop: 8 }}>{L('GitHub internship and full-time lists (Simplify) are included. Changes apply from the next refresh.', 'GitHub liste praksi i full-time pozicija (Simplify) su uključene. Izmjene vrijede od sljedećeg osvježavanja.')}</div>
        </div>
      )}
      <input aria-label={L('Search', 'Pretraga')} placeholder={L('Search title, company, location…', 'Pretraži naziv, kompaniju, lokaciju…')} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      <div className="cvb-chips">
        {[['', L('All', 'Sve')], ['Praksa', L('Internships', 'Prakse')], ['Full-time', 'Full-time'], ['Istraživanje', L('Research', 'Istraživanje')], ['Grant', L('Grants', 'Grantovi')], ['Program', L('Spring weeks / programmes', 'Spring week / programi')]].map(([k, l]) => <button key={k} className="cvb-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
        <button className="cvb-chip" aria-pressed={showExpired} onClick={() => setShowExpired(!showExpired)}>{L('Show expired', 'Prikaži istekle')}</button>
        {pset.size >= 6 && (
          <>
            <span aria-hidden style={{ flexBasis: '100%', height: 0 }} />
            <span className="cvb-src" style={{ alignSelf: 'center' }}>{L('Sort:', 'Poredaj:')}</span>
            {[['new', L('Newest', 'Najnovije')], ['match', L('By match', 'Po podudarnosti')]].map(([k, l]) => <button key={k} className="cvb-chip" aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}
          </>
        )}
      </div>
      <div className="cvb-chips">
        <span className="cvb-src" style={{ alignSelf: 'center' }}>{L('Region:', 'Regija:')}</span>
        <button className="cvb-chip" aria-pressed={region === ''} onClick={() => setRegion('')}>{L('All', 'Sve')}</button>
        {REGIONS.map(([v]) => <button key={v} className="cvb-chip" aria-pressed={region === v} onClick={() => setRegion(v)}>{regionLabel(v)}</button>)}
      </div>
      <div className="cvb-chips">
        <span className="cvb-src" style={{ alignSelf: 'center' }}>{L('Visa:', 'Viza:')}</span>
        {[['', L('All', 'Sve')], ['yes', L('Sponsors visa', 'Sponzoriše vizu')], ['open', L('Hide “no sponsorship”', 'Sakrij „bez sponzorstva“')]].map(([k, l]) => <button key={k} className="cvb-chip" aria-pressed={visaF === k} onClick={() => setVisaF(k)}>{l}</button>)}
      </div>
      {region && <div className="cvb-src" style={{ margin: '-4px 0 10px' }}>{L('Filters by the posting’s location. For fuller local results add regional companies under “Sources” or run “AI search”.', 'Filtrira po lokaciji oglasa. Za pune lokalne rezultate dodaj regionalne firme u „Izvori" ili pokreni „AI pretraga".')}</div>}
      {items.length === 0 && <div className="cvb-empty">{data ? L('No results for this filter.', 'Nema rezultata za ovaj filter.') : ''}</div>}
      {items.slice(0, 150).map((i) => (
        <div className="cvb-item" key={i.id}>
          <div className="grow">
            <b>{i.title}</b>
            <div className="sub" style={{ margin: '2px 0 0' }}>{i.company}{i.location ? ` · ${i.location}` : ''}</div>
            <div className="cvb-meta">
              <span className="cvb-pill">{kindLabel(i.kind)}</span>
              {i._score != null && <span className={`cvb-pill ${matchCls(i._score)}`} title={L('Quick local estimate: how many of your skills/terms appear in the posting', 'Brza lokalna procjena: koliko se tvojih vještina/pojmova pojavljuje u oglasu')}>~{i._score}% match</span>}
              <span>{L('Posted', 'Objavljeno')} {i.posted || '?'}</span>
              {i.deadline && <DeadlinePill d={i.deadline} />}
              <VisaPill v={visaFor(i, visa)} />
              {i.deadline && <span>{L('Deadline', 'Rok')} {i.deadline}</span>}
              <span className="cvb-src">{srcLabel(i.source)}</span>
              <a href={i.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{L('Posting', 'Oglas')}</a>
              <button className="cvb-chip" onClick={() => onCheckVisa(i, i.id)}>{L('Check visa', 'Provjeri vizu')}</button>
            </div>
          </div>
          <button className="cvb-btn" disabled={have.has(i.id) || adding === i.id} onClick={() => addItem(i)}>{have.has(i.id) ? <Check width={16} height={16} /> : <Plus width={16} height={16} />}{have.has(i.id) ? L('Added', 'Dodano') : L('Track', 'Prati')}</button>
        </div>
      ))}
      {items.length > 150 && <div className="cvb-src" style={{ textAlign: 'center' }}>{L(`Showing 150 of ${items.length}. Narrow the search.`, `Prikazano 150 od ${items.length}. Suzi pretragu.`)}</div>}
    </div>
  )
}

function GuideTab() {
  const steps = [
    [L('1. Fill in your Profile', '1. Popuni Profil'), L('Write everything about yourself: education, experience, projects, research, awards, skills and anything else. More detail gives better CVs. Already have a CV? Use “Import an existing CV” to fill it in from a PDF or Word file. Be honest: the AI only uses what is here and never invents experience.', 'Upiši sve o sebi: obrazovanje, iskustvo, projekte, istraživanje, nagrade, vještine i ostalo. Što više detalja, to bolji CV. Već imaš CV? Koristi „Uvezi postojeći CV“ da se profil popuni iz PDF ili Word fajla. Budi iskren/a: AI koristi samo ono što je ovdje i nikad ne izmišlja iskustvo.')],
    [L('2. Find positions in Discover', '2. Nađi pozicije u Otkrij'), L('A free list of open internships and junior roles is collected every day from GitHub lists and company job boards. Filter by type and region, search, and press Track on the ones you like. “AI search” looks further for research positions, grants and spring weeks (uses AI).', 'Besplatna lista otvorenih praksi i junior pozicija prikuplja se svaki dan s GitHub lista i stranica kompanija. Filtriraj po tipu i regiji, pretraži i klikni Prati na one koje želiš. “AI pretraga” traži dalje: istraživačke pozicije, grantove i spring week programe (koristi AI).')],
    [L('3. Manage them in Positions', '3. Vodi ih u Pozicijama'), L('Each tracked position shows its deadline, date posted and your status (Interested, Applied, Interview, Rejected, Offer). You can also add one by hand and paste the posting text.', 'Svaka praćena pozicija ima rok, datum objave i tvoj status (Zanima me, Aplicirano, Intervju, Odbijeno, Ponuda). Možeš dodati i ručno uz zalijepljen tekst oglasa.')],
    [L('4. Tailor your CV', '4. Prilagodi CV'), L('Open a position and press Tailor CV. The AI picks and orders the most relevant parts of your profile and gives a fit score, what you already have, what is missing and how to fix it before the deadline. A PDF (for application systems), an editable Word file and a LaTeX file are attached in the AI chat, and Open in Overleaf creates a ready-to-edit Overleaf project from the CV.', 'Otvori poziciju i klikni Prilagodi CV. AI bira i slaže najrelevantnije iz profila te daje ocjenu podudarnosti, šta već imaš, šta fali i kako to popraviti prije roka. PDF (za sisteme prijave), uređivljiv Word i LaTeX fajl dobiješ u AI chatu, a Otvori u Overleafu pravi gotov Overleaf projekat od CV-a.')],
  ]
  const faq = [
    [L('What costs AI usage?', 'Šta troši AI?'), L('Only Tailor CV, Check visa and AI search, each when you press the button. Opening the app and the daily Discover refresh use no AI.', 'Samo Prilagodi CV, Provjeri vizu i AI pretraga, i to kad klikneš dugme. Otvaranje aplikacije i dnevno osvježavanje Otkrij ne koriste AI.')],
    [L('Where is my data?', 'Gdje su moji podaci?'), L('Only on your own Möbius, in this app’s private storage. It is not shared with other users or uploaded anywhere except to your AI provider when you press an AI button.', 'Samo na tvom Möbiusu, u privatnom spremištu ove aplikacije. Ne dijeli se s drugim korisnicima niti šalje igdje osim tvom AI provideru kad klikneš AI dugme.')],
    [L('Is the visa check reliable?', 'Je li provjera vize pouzdana?'), L('It is a quick AI read of the posting and can be wrong. Always confirm work authorisation and sponsorship on the employer’s page.', 'To je brzo AI čitanje oglasa i može pogriješiti. Uvijek potvrdi radnu dozvolu i sponzorstvo na stranici poslodavca.')],
    [L('Why LinkedIn and Indeed are missing?', 'Zašto nema LinkedIna i Indeeda?'), L('Their terms forbid automated collection and they block it, so the app uses public sources instead. Paste a posting from any site into New position.', 'Njihovi uvjeti zabranjuju automatsko prikupljanje i blokiraju ga, pa app koristi javne izvore. Oglas s bilo kojeg sajta zalijepi u Novu poziciju.')],
    [L('Tips for a strong result', 'Savjeti za bolji rezultat'), L('Include numbers (users, accuracy, speed-ups), technologies, your role and the outcome. Keep the profile up to date after every project, competition or paper.', 'Dodaj brojke (korisnici, tačnost, ubrzanja), tehnologije, svoju ulogu i ishod. Ažuriraj profil nakon svakog projekta, takmičenja ili rada.')],
  ]
  return (
    <div>
      <div className="cvb-card">
        <h3 style={{ fontSize: 17 }}>{L('What is CV Builder?', 'Šta je CV Builder?')}</h3>
        <div className="sub" style={{ margin: 0 }}>{L('Write everything about yourself once. For every internship, job or research position the app builds a CV tailored to it, tells you how well you fit, what is missing and how to improve it, and tracks deadlines and application status.', 'Jednom upiši sve o sebi. Za svaku praksu, posao ili istraživačku poziciju aplikacija složi CV prilagođen njoj, kaže koliko ti odgovara, šta fali i kako to popraviti, te prati rokove i status prijave.')}</div>
      </div>
      {steps.map(([t, d]) => <div className="cvb-card" key={t}><h3>{t}</h3><div className="sub" style={{ margin: 0 }}>{d}</div></div>)}
      <h3 style={{ margin: '18px 0 8px' }}>{L('Good to know', 'Dobro je znati')}</h3>
      {faq.map(([q, d]) => <div className="cvb-card" key={q}><h3>{q}</h3><div className="sub" style={{ margin: 0 }}>{d}</div></div>)}
    </div>
  )
}

export default function App({ appId, token }) {
  const store = window.mobius?.storage
  const [tab, setTab] = useState('jobs')
  const [profile, setProfileState] = useState(EMPTY)
  const [jobs, setJobs] = useState([])
  const [results, setResults] = useState({})
  const [openId, setOpenId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [lang, setLangState] = useState('en')
  const [visa, setVisa] = useState(null)
  LANG = lang // set before children render so every L() call sees the current language
  const saveTimer = useRef(null)
  const jobsRef = useRef([])
  jobsRef.current = jobs

  const loadAll = useCallback(async () => {
    try {
      const p = await store.get('profile.json')
      if (p) setProfileState({ ...EMPTY, ...p, basics: { ...EMPTY.basics, ...p.basics } })
      const cfg = await store.get('settings.json')
      if (cfg?.lang === 'bs' || cfg?.lang === 'en') setLangState(cfg.lang)
      const j = await store.get('jobs.json')
      setJobs(j || [])
      const r = {}
      for (const job of j || []) {
        const res = await store.get(`results/${job.id}.json`)
        if (res) r[job.id] = res
      }
      setResults(r)
    } catch (e) { setError(L('Could not load: ', 'Učitavanje nije uspjelo: ') + e.message) }
    setLoaded(true)
  }, [store])

  useEffect(() => { loadAll() }, [loadAll])
  // Visa checks are written by an agent chat turn, so watch the file for live updates.
  useEffect(() => (store ? store.subscribe('visa.json', setVisa) : undefined), [store])

  // While any job is waiting on the AI, poll for its result file.
  const pending = jobs.filter((j) => j.pendingSince && !(results[j.id] && results[j.id].at >= j.pendingSince))
  useEffect(() => {
    if (!pending.length) return
    const t = setInterval(async () => {
      for (const job of pending) {
        const res = await store.get(`results/${job.id}.json`).catch(() => null)
        if (res && res.at >= job.pendingSince) {
          setResults((r) => ({ ...r, [job.id]: res }))
          saveJobs(jobs.map((x) => (x.id === job.id ? { ...x, pendingSince: null } : x)))
        }
      }
    }, 4000)
    return () => clearInterval(t)
  }, [pending.map((j) => j.id).join(','), jobs])

  const setProfile = (p) => {
    setProfileState(p)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => store.set('profile.json', p).catch((e) => setError(L('Could not save profile: ', 'Spremanje profila nije uspjelo: ') + e.message)), 600)
  }
  const saveJobs = async (next) => {
    setJobs(next)
    try { await store.set('jobs.json', next) } catch (e) { setError(L('Could not save: ', 'Spremanje nije uspjelo: ') + e.message) }
  }
  const setLang = (v) => {
    setLangState(v)
    store.set('settings.json', { lang: v }).catch((e) => setError('Could not save language: ' + e.message))
  }
  const checkVisa = async (item, key) => {
    setError('')
    try {
      const { chatId } = await window.mobius.chat.start({ draft: visaPrompt(appId, item, key), title: `${L('Visa check', 'Provjera vize')}: ${item.company || item.title}`.slice(0, 80) })
      if (chatId) openChat(chatId)
    } catch (e) { setError(L('Could not start the visa check: ', 'Pokretanje provjere vize nije uspjelo: ') + e.message) }
  }
  const openChat = (chatId) => window.parent.postMessage({ type: 'moebius:open-chat', chatId }, '*')

  const addJob = async (j, open = true) => {
    const job = { ...j, id: uid(), status: 'Zanima me', createdAt: new Date().toISOString() }
    await saveJobs([job, ...jobsRef.current])
    if (open) { setAdding(false); setOpenId(job.id) }
  }

  const tailor = async (job) => {
    setError('')
    const at = Date.now()
    const bs = LANG === 'bs'
    const fileBase = `$MOBIUS_GENERATED_DIR/CV - ${(job.company || job.title).replace(/[^\w ]/g, '')}`
    const prompt = bs ? `Prilagodi CV za poziciju u aplikaciji CV Builder (app id ${appId}).

1. Pročitaj profil: /data/apps/${appId}/profile.json (mega profil korisnika: osnovno, obrazovanje, iskustvo, projekti, istraživanje, nagrade, vještine, ostalo).
2. Oglas:
Pozicija: ${job.title}
Kompanija: ${job.company}
Rok: ${job.deadline || 'nepoznat'}  Objavljeno: ${job.posted || 'nepoznato'}
Link: ${job.url || '-'}
${job.text && job.text.length > 200 ? `Tekst:\n"""\n${job.text}\n"""` : `Tekst oglasa nije spremljen${job.text ? ' (samo djelomično: ' + job.text + ')' : ''}. Otvori link i pročitaj oglas (WebFetch ili curl). Ako ga ne možeš pročitati, reci to jasno i složi CV samo prema nazivu pozicije i kompaniji, uz napomenu.`}
3. Odredi tip uloge (npr. software engineering, data science, quant finance, istraživanje/akademska) i složi CV samo iz činjenica iz profila. NIKAD ne izmišljaj iskustvo, brojke ni vještine. Izaberi i poredaj ono najrelevantnije, preformuliši u jeziku oglasa, naglasi tražene ključne riječi koje korisnik stvarno ima. Ako profil ima premalo podataka, to navedi među prazninama. Ako oglas ograničava državljanstvo, radnu dozvolu ili sponzorisanje vize, to također navedi među prazninama.
4. Zapiši rezultat kao JSON u /data/apps/${appId}/results/${job.id}.json (napravi folder ako ne postoji), tačno ovog oblika:
{"at": ${at}, "role_type": "...", "fit": <0-100 cijeli broj>, "summary": "<2 rečenice zašto je to ocjena>", "strengths": ["..."], "gaps": ["<šta fali i konkretno kako to popraviti prije roka>"], "cv_markdown": "<cijeli CV u markdownu, spreman za kopiranje>"}
Polje "at" mora biti baš ta brojka. Zatim napravi PDF, Word (uređivljiv) i LaTeX (.tex, za Overleaf) fajl: node /data/apps/cv-builder/cv-cli.mjs /data/apps/${appId}/results/${job.id}.json "${fileBase}" (sva tri se pojave u ovom chatu kao preuzimanje). Nemoj mijenjati druge fajlove. Na kraju u chatu kratko (2-3 rečenice) reci šta si našao.` : `Tailor a CV for a position in the CV Builder app (app id ${appId}). Write everything (summary, strengths, gaps and the CV) in English.

1. Read the profile: /data/apps/${appId}/profile.json (the user's mega profile: basics, education, experience, projects, research, awards, skills, other).
2. Job posting:
Position: ${job.title}
Company: ${job.company}
Deadline: ${job.deadline || 'unknown'}  Posted: ${job.posted || 'unknown'}
Link: ${job.url || '-'}
${job.text && job.text.length > 200 ? `Text:\n"""\n${job.text}\n"""` : `The posting text was not saved${job.text ? ' (only partially: ' + job.text + ')' : ''}. Open the link and read the posting (WebFetch or curl). If you cannot read it, say so clearly and build the CV from the position title and company only, with a note.`}
3. Decide the role type (e.g. software engineering, data science, quant finance, research/academic) and build the CV only from facts in the profile. NEVER invent experience, numbers or skills. Choose and order the most relevant material, rephrase it in the language of the posting, and emphasize the requested keywords the user actually has. If the profile has too little data, list that among the gaps. If the posting restricts citizenship, work authorisation or visa sponsorship, list that among the gaps too.
4. Write the result as JSON to /data/apps/${appId}/results/${job.id}.json (create the folder if needed), in exactly this shape:
{"at": ${at}, "role_type": "...", "fit": <integer 0-100>, "summary": "<2 sentences on why that score>", "strengths": ["..."], "gaps": ["<what is missing and concretely how to fix it before the deadline>"], "cv_markdown": "<the whole CV in markdown, ready to copy>"}
The "at" field must be exactly that number. Then create a PDF, an editable Word file and a LaTeX (.tex, for Overleaf) file: node /data/apps/cv-builder/cv-cli.mjs /data/apps/${appId}/results/${job.id}.json "${fileBase}" (all three appear in this chat as downloads). Do not change other files. At the end, reply in chat in 2-3 short sentences saying what you found.`
    try {
      const { chatId } = await window.mobius.chat.start({ draft: prompt, title: `CV: ${job.title}`.slice(0, 80) })
      await saveJobs(jobs.map((x) => (x.id === job.id ? { ...x, pendingSince: at, chatId } : x)))
    } catch (e) { setError(L('Could not start the AI: ', 'Pokretanje AI-ja nije uspjelo: ') + e.message) }
  }

  const job = jobs.find((j) => j.id === openId)
  const sortedJobs = [...jobs].sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'))
  const soon = jobs.filter((j) => { const n = daysLeft(j.deadline); return n != null && n >= 0 && n <= 7 && j.status !== 'Odbijeno' && j.status !== 'Ponuda' })
  const overdue = jobs.filter((j) => { const n = daysLeft(j.deadline); return n != null && n < 0 && j.status === 'Zanima me' })

  return (
    <div className="cvb">
      <style>{CSS}</style>
      <div className="cvb-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <div>
          <h1>CV Builder</h1>
          <div className="sub">{L('One mega profile, a tailored CV for every position.', 'Jedan mega profil, a CV za svaku poziciju posebno.')}</div>
        </div>
        <div className="cvb-chips" role="group" aria-label={L('Language', 'Jezik')}>
          {[['en', 'EN'], ['bs', 'BS']].map(([k, l]) => <button key={k} className="cvb-chip" aria-pressed={lang === k} onClick={() => setLang(k)}>{l}</button>)}
        </div>
      </div>
      <div className="cvb-tabs" role="tablist">
        <button className="cvb-tab" role="tab" aria-selected={tab === 'jobs'} onClick={() => setTab('jobs')}>{L('Positions', 'Pozicije')}</button>
        <button className="cvb-tab" role="tab" aria-selected={tab === 'discover'} onClick={() => setTab('discover')}>{L('Discover', 'Otkrij')}</button>
        <button className="cvb-tab" role="tab" aria-selected={tab === 'profile'} onClick={() => setTab('profile')}>{L('Profile', 'Profil')}</button>
        <button className="cvb-tab" role="tab" aria-selected={tab === 'guide'} onClick={() => setTab('guide')}>{L('Guide', 'Uputstvo')}</button>
      </div>
      {error && <div className="cvb-card" role="alert" style={{ borderColor: '#ef4444' }}>{error}</div>}
      {!loaded ? <div className="cvb-empty">{L('Loading…', 'Učitavam…')}</div> : tab === 'guide' ? (
        <GuideTab />
      ) : tab === 'profile' ? (
        <ProfileTab profile={profile} setProfile={setProfile} appId={appId} openChat={openChat} setError={setError} />
      ) : tab === 'discover' ? (
        <DiscoverTab appId={appId} token={token} jobs={jobs} setError={setError} openChat={openChat} profile={profile} visa={visa} onCheckVisa={checkVisa} onAdd={async (j) => { await addJob(j, false) }} />
      ) : job ? (
        <JobDetail
          job={job} result={results[job.id]} chatId={job.chatId} openChat={openChat}
          busy={pending.some((j) => j.id === job.id)} visa={visa} onCheckVisa={() => checkVisa({ title: job.title, company: job.company, url: job.url, location: '' }, job.fromDiscover || job.id)}
          onBack={() => setOpenId(null)} onTailor={() => tailor(job)}
          onUpdate={(patch) => saveJobs(jobs.map((x) => (x.id === job.id ? { ...x, ...patch } : x)))}
          onDelete={async () => { await saveJobs(jobs.filter((x) => x.id !== job.id)); setOpenId(null) }}
        />
      ) : adding ? (
        <JobForm onSave={addJob} onCancel={() => setAdding(false)} />
      ) : (
        <div>
          <button className="cvb-btn pri" onClick={() => setAdding(true)}><Plus width={16} height={16} /> {L('New position', 'Nova pozicija')}</button>
          {(soon.length > 0 || overdue.length > 0) && (
            <div className="cvb-card" style={{ marginTop: 12, borderColor: '#f59e0b' }}>
              <h3 style={{ margin: '0 0 6px' }}>{L('Deadlines', 'Rokovi')}</h3>
              {overdue.map((j) => (
                <button className="cvb-job" style={{ marginBottom: 6 }} key={j.id} onClick={() => setOpenId(j.id)}>
                  <span className="cvb-pill bad">{L('Deadline passed', 'Istekao rok')}</span> <b style={{ fontSize: 14 }}>{j.title}</b> <span className="sub">· {j.company}</span>
                </button>
              ))}
              {soon.map((j) => (
                <button className="cvb-job" style={{ marginBottom: 6 }} key={j.id} onClick={() => setOpenId(j.id)}>
                  <DeadlinePill d={j.deadline} /> <b style={{ fontSize: 14 }}>{j.title}</b> <span className="sub">· {j.company}</span>
                </button>
              ))}
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            {sortedJobs.length === 0 && <div className="cvb-empty">{L(<>No positions yet. First fill in your <b>Profile</b>, then paste a posting or track one from <b>Discover</b>.</>, <>Još nema pozicija. Prvo popuni <b>Profil</b>, pa zalijepi oglas za praksu ili posao.</>)}</div>}
            {sortedJobs.map((j) => (
              <button className="cvb-job" key={j.id} onClick={() => setOpenId(j.id)}>
                <b>{j.title}</b> <span className="sub">· {j.company}</span>
                <div className="cvb-meta">
                  <span className="cvb-pill">{statusLabel(j.status)}</span>
                  <DeadlinePill d={j.deadline} />
                  {j.deadline && <span>{L('Deadline', 'Rok')} {j.deadline}</span>}
                  {results[j.id] && <span className="cvb-pill ok">{L('Fit', 'Podudarnost')} {results[j.id].fit}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
