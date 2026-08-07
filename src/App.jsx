import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { Authenticator } from '@aws-amplify/ui-react';
import {
  Plus,
  Send,
  Save,
  Download,
  History,
  LogOut,
  Stethoscope,
  X,
  ChevronRight,
  Clock,
  FileText,
  Trash2,
  User,
  Globe,
  Lock,
  ShieldCheck,
  Search,
  Mic,
  MicOff,
  AlertCircle,
  LayoutGrid
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { fetchUserAttributes, updateUserAttributes, updatePassword, fetchAuthSession, signIn, getCurrentUser } from 'aws-amplify/auth';
import { startLiveTranscription } from './lib/liveTranscribe';
import '@aws-amplify/ui-react/styles.css';
import outputs from '../amplify_outputs.json';
import { translations } from './translations';
import taxonomy from '../amplify/functions/generate-report/taxonomy.json';
import jpcCases from '../amplify/functions/generate-report/jpc_cases.json';
import './index.css';

Amplify.configure(outputs);
const client = generateClient();

// ─── Embedded (iframe) mode ───
// When this app runs inside the VetDB exam app's popup, there is no separate
// login: it auto-signs-in a dedicated embed account and posts the finished
// report to the parent, which inserts it into the VetDB database. Standalone
// (non-iframe) use keeps the normal Authenticator.
const IN_IFRAME = (() => {
  try { return window.self !== window.top; } catch { return true; }
})();
const EMBED_EMAIL = 'embed@vetdb.local';
const EMBED_PASSWORD = 'EmbedVet1234!';

// ─── Constants ───
// Transcribe streama izravno iz preglednika, pa mu region moramo dati rucno.
// Vuce se iz amplify_outputs.json da ne odluta od backenda — hardkodirani
// us-east-1 je znacio da svaki audio chunk ide preko Atlantika bez potrebe.
// Override postoji za slucaj da regija backenda ne podrzava trazeni jezik:
// custom vocabulary je vezan uz regiju, pa VITE_TRANSCRIBE_REGION mora
// odgovarati onome s kojim je pokrenut scripts/create_transcribe_vocabulary.py.
const TRANSCRIBE_REGION = import.meta.env.VITE_TRANSCRIBE_REGION || outputs.auth.aws_region;
// Ime Transcribe custom vocabulary-ja (vidi scripts/create_transcribe_vocabulary.py).
// Namjerno prazno po defaultu: nepostojeci vocabulary rusi cijelu streaming sesiju,
// pa se ukljucuje tek kad je stvarno kreiran i u stanju READY.
const TRANSCRIBE_VOCABULARY_HR = import.meta.env.VITE_TRANSCRIBE_VOCABULARY_HR || '';
// Koliko cekati nakon zadnjeg finaliziranog segmenta prije ekstrakcije polja.
const EXTRACT_DEBOUNCE_MS = 1500;

// ─── Structured report helpers (novi izlazni format: zaglavlje / sekcije / komentar) ───

// ─── Klasifikacija (JPC VSPO šifrarnik) ───
const TAX = taxonomy;
const EMPTY_KLAS = { animal_group: null, system: null, etiology: [] };

function taxLabel(kind, code, lang) {
  if (!code) return '';
  const item = (TAX[kind] || []).find((x) => x.code === code);
  return item ? (item[lang] || item.en || code) : code;
}

// ─── JPC klasifikacijski kod (System–Etiology + broj) ───
function jpcLetter(kind, code) {
  if (!code) return '';
  const item = (TAX[kind] || []).find((x) => x.code === code);
  return item?.jpc || '';
}
// Prefiks iz klasifikacije, npr. INTEGUMENT + [NEOPLASTIC] → "I-N".
function jpcPrefix(klas) {
  if (!klas) return '';
  const s = jpcLetter('system', klas.system);
  const e = (klas.etiology && klas.etiology.length) ? jpcLetter('etiology', klas.etiology[0]) : '';
  return s && e ? `${s}-${e}` : '';
}
function jpcTokens(s) {
  return (String(s || '').toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length > 3);
}
// Engleske riječi za vrstu kako se pojavljuju u JPC dijagnozama (za bolje poklapanje slučaja).
const JPC_SPECIES = {
  AVIAN: ['chicken', 'turkey', 'quail', 'pigeon', 'owl', 'cockatoo', 'duck', 'goose', 'bird', 'psittacine'],
  BOVINE: ['ox', 'cow', 'calf', 'bull', 'steer', 'bovine', 'cattle'],
  CANINE: ['dog', 'canine', 'puppy'],
  EQUINE: ['horse', 'foal', 'equine', 'pony', 'mare', 'stallion'],
  FELINE: ['cat', 'feline', 'kitten'],
  PORCINE: ['pig', 'swine', 'piglet', 'boar', 'porcine'],
  PRIMATE: ['monkey', 'macaque', 'baboon', 'chimpanzee', 'tamarin', 'primate', 'rhesus', 'cynomolgus'],
  RABBIT: ['rabbit'],
  RODENT: ['mouse', 'rat', 'guinea', 'hamster', 'gerbil', 'rodent'],
  SMALL_RUMINANT: ['sheep', 'goat', 'ewe', 'lamb', 'ram'],
  OTHER: [],
};
// Najbliži konkretni JPC slučaj unutar prefiksa — prema preklapanju riječi s dijagnozom
// i podudaranju vrste životinje (species). Species poklapanje nosi bonus da se kod
// razriješi na stvarni case code i kad je proza kratka.
function jpcClosest(klas, dgText) {
  const prefix = jpcPrefix(klas);
  if (!prefix) return null;
  const cand = (jpcCases.cases || []).filter((c) => c.code.startsWith(prefix));
  if (!cand.length) return null;
  const qt = new Set(jpcTokens(dgText || ''));
  const species = JPC_SPECIES[klas && klas.animal_group] || [];
  let best = null, bestScore = 0;
  for (const c of cand) {
    const dl = c.diagnosis.toLowerCase();
    let sc = 0;
    for (const tkn of jpcTokens(c.diagnosis)) if (qt.has(tkn)) sc++;
    if (species.some((sp) => dl.includes(sp))) sc += 2;
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  return bestScore >= 2 ? best : null;
}
// Prikaz: puni kod + engleski opis ako je pouzdan pogodak, inače samo prefiks.
function jpcCodeLabel(klas, dgText) {
  const prefix = jpcPrefix(klas);
  if (!prefix) return '';
  const close = jpcClosest(klas, dgText);
  return close ? `${close.code} — ${close.diagnosis}` : prefix;
}

function normalizeKlas(k) {
  k = k || {};
  let et = k.etiology;
  if (typeof et === 'string') et = et.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    animal_group: k.animal_group || null,
    system: k.system || null,
    etiology: Array.isArray(et) ? et.filter(Boolean) : [],
  };
}

// Pogodi tip uzorka (vrsta_uzorka) iz ključnih riječi / teksta — samo kao fallback
// ako ga model nije popunio. NE određuje urudžbeni broj (to nije izvedivo iz sadržaja).
const SAMPLE_TYPE_RULES = [
  { re: /punktat|razmas|aspirat|citolog|fna/i, hr: 'citološki punktat', en: 'cytology aspirate' },
  { re: /limf(ni|ni čvor|no)?/i, hr: 'punktat limfnog čvora', en: 'lymph node aspirate' },
  { re: /subkut|potkož|dermis|kož[aei]|kožn/i, hr: 'bioptat kože', en: 'skin biopsy' },
  { re: /mliječn|mamm|dojk/i, hr: 'bioptat mliječne žlijezde', en: 'mammary biopsy' },
  { re: /testis|sjemenik/i, hr: 'bioptat testisa', en: 'testicular biopsy' },
  { re: /slezen|splen/i, hr: 'bioptat slezene', en: 'splenic biopsy' },
  { re: /želudac|želučan|crijev|duoden|gastro|intestin/i, hr: 'bioptat probavnog trakta', en: 'GI biopsy' },
  { re: /štitnjač|thyro/i, hr: 'bioptat štitnjače', en: 'thyroid biopsy' },
  { re: /jetr|hepat/i, hr: 'bioptat jetre', en: 'liver biopsy' },
  { re: /bubreg|renal|nefr/i, hr: 'bioptat bubrega', en: 'renal biopsy' },
];
function guessSampleType(text, lang) {
  const en = lang === 'en';
  for (const r of SAMPLE_TYPE_RULES) if (r.re.test(text)) return en ? r.en : r.hr;
  return '';
}

// Izvuci keyword-like pojmove iz slobodnog teksta Case detailsa.
// Uzima kratke, zarezom / točka-zarezom / novim redom odvojene termine (do 4 riječi),
// pa prozne rečenice (duge klauzule) preskače da ne stvara smeće.
function parseKeywordsFromDetails(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/^[-•*\d.]+\s*/, '').trim())
    .filter((s) => s.length > 0 && s.length <= 40 && s.split(/\s+/).length <= 4);
}

// Spoji eksplicitne keyworde iz polja s onima izvučenim iz Case detailsa (bez duplikata).
function buildEffectiveKeywords(keywordInputs, details) {
  const explicit = (keywordInputs || []).map((k) => (k || '').trim()).filter(Boolean);
  const fromDetails = parseKeywordsFromDetails(details);
  const seen = new Set();
  const out = [];
  for (const k of [...explicit, ...fromDetails]) {
    const key = k.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(k); }
  }
  return out;
}

// Normaliziraj bilo koji odgovor (novi rich ili stari plosnati {opis,dg}) u jedinstveni oblik.
function normalizeReport(r) {
  if (!r || typeof r !== 'object') return null;
  if (!Array.isArray(r.sekcije)) {
    if (r.opis !== undefined || r.dg !== undefined) {
      return {
        vrsta_nalaza: r.vrsta_nalaza || null,
        zaglavlje: r.zaglavlje || {},
        klasifikacija: normalizeKlas(r.klasifikacija),
        sekcije: [{ naslov: '', opis: r.opis || '', dg: r.dg ?? '' }],
        komentar: r.komentar || '',
      };
    }
    return null;
  }
  const sekcije = (r.sekcije.length ? r.sekcije : [{}]).map((s) => ({
    naslov: s.naslov ?? '',
    opis: s.opis || '',
    dg: Array.isArray(s.dg) ? [...s.dg] : (s.dg ?? ''),
  }));
  return {
    vrsta_nalaza: r.vrsta_nalaza || null,
    zaglavlje: r.zaglavlje || {},
    klasifikacija: normalizeKlas(r.klasifikacija),
    sekcije,
    komentar: r.komentar || '',
  };
}

// Duboka kopija za uređivanje.
function cloneReport(r) {
  return normalizeReport(JSON.parse(JSON.stringify(r)));
}

const ZAGLAVLJE_FIELDS = ['oznaka_uzorka', 'vrsta_uzorka', 'datum', 'doktor'];

// Serijaliziraj strukturirani nalaz u čitljiv tekst (za spremanje i kao izvor za PDF).
function formatReportText(report, lang) {
  if (!report) return '';
  const en = lang === 'en';
  const lines = [];
  const langKey = en ? 'en' : 'hr';
  const z = report.zaglavlje || {};
  const zLine = ZAGLAVLJE_FIELDS.map((f) => (z[f] || '').trim()).filter(Boolean).join(' · ');
  if (zLine) { lines.push(zLine); }
  const k = report.klasifikacija || {};
  const kParts = [];
  if (k.animal_group) kParts.push(taxLabel('animal_group', k.animal_group, langKey));
  if (k.system) kParts.push(taxLabel('system', k.system, langKey));
  if (k.etiology && k.etiology.length) kParts.push(k.etiology.map((c) => taxLabel('etiology', c, langKey)).join(', '));
  if (kParts.length) lines.push(kParts.join(' · '));
  const jpc = jpcCodeLabel(k, reportDgSummary(report));
  if (jpc) lines.push(`${en ? 'JPC code' : 'JPC kôd'}: ${jpc}`);
  if (zLine || kParts.length || jpc) lines.push('');
  (report.sekcije || []).forEach((s) => {
    if (s.naslov && s.naslov.trim()) lines.push(`${s.naslov.trim()}:`);
    if (s.opis && s.opis.trim()) lines.push(s.opis.trim());
    const dgLabel = en ? 'Dx:' : 'Dg.:';
    if (Array.isArray(s.dg)) {
      const items = s.dg.map((d) => (d || '').trim()).filter(Boolean);
      if (items.length) {
        lines.push(dgLabel);
        items.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
      }
    } else if (s.dg && s.dg.trim()) {
      lines.push(`${dgLabel} ${s.dg.trim()}`);
    }
    lines.push('');
  });
  if (report.komentar && report.komentar.trim()) {
    lines.push(`${en ? 'Comment:' : 'Komentar:'} ${report.komentar.trim()}`);
  }
  return lines.join('\n').trim();
}

// Kratki sažetak dijagnoze za pregled neselektiranih rezultata.
function reportDgSummary(report) {
  const parts = [];
  (report.sekcije || []).forEach((s) => {
    if (Array.isArray(s.dg)) parts.push(...s.dg);
    else if (s.dg) parts.push(s.dg);
  });
  return parts.filter(Boolean).join('; ');
}

const FIELD_INPUT = { width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border)', fontFamily: 'inherit', fontSize: '0.95rem', boxSizing: 'border-box' };
const FIELD_LABEL = { fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.3rem', display: 'block' };
const SECTION_LABEL = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' };

// Sklopivi blok s naslovom, opcionalnim sažetkom i strelicom.
function Collapsible({ title, subtitle, open, onToggle, children }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 0.9rem', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <ChevronRight size={16} style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }} />
        <span style={{ ...SECTION_LABEL, marginBottom: 0 }}>{title}</span>
        {subtitle && !open && (
          <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '60%' }}>{subtitle}</span>
        )}
      </button>
      {open && <div style={{ padding: '0 0.9rem 0.9rem' }}>{children}</div>}
    </div>
  );
}

// Read-only prikaz nalaza (za neselektirane rezultate pretrage).
function ReportPreview({ report, lang, t }) {
  const langKey = lang === 'en' ? 'en' : 'hr';
  const z = report.zaglavlje || {};
  const zLine = ZAGLAVLJE_FIELDS.map((f) => (z[f] || '').trim()).filter(Boolean).join(' · ');
  const dgLabel = lang === 'en' ? 'Dx:' : 'Dg.:';
  const k = report.klasifikacija || {};
  const kChips = [];
  if (k.animal_group) kChips.push(taxLabel('animal_group', k.animal_group, langKey));
  if (k.system) kChips.push(taxLabel('system', k.system, langKey));
  (k.etiology || []).forEach((c) => kChips.push(taxLabel('etiology', c, langKey)));
  return (
    <div>
      {zLine && (
        <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>{zLine}</p>
      )}
      {kChips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem' }}>
          {kChips.map((c, i) => (
            <span key={i} style={{ fontSize: '0.72rem', fontWeight: 600, background: 'var(--bg-subtle, #f1f5f9)', color: 'var(--text-muted)', padding: '0.15rem 0.5rem', borderRadius: '999px' }}>{c}</span>
          ))}
        </div>
      )}
      {jpcCodeLabel(k, reportDgSummary(report)) && (
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          <strong>{t('jpc_code')}:</strong> {jpcCodeLabel(k, reportDgSummary(report))}
        </p>
      )}
      {(report.sekcije || []).map((s, i) => (
        <div key={i} style={{ marginBottom: '1rem' }}>
          {s.naslov && s.naslov.trim() && (
            <div style={{ fontWeight: 700, marginBottom: '0.35rem' }}>{s.naslov.trim()}</div>
          )}
          {s.opis && <p style={{ margin: '0 0 0.5rem', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{s.opis}</p>}
          {Array.isArray(s.dg) ? (
            <>
              <div style={{ ...SECTION_LABEL, marginBottom: '0.2rem' }}>{dgLabel}</div>
              <ol style={{ margin: 0, paddingLeft: '1.2rem', fontWeight: 600 }}>
                {s.dg.filter(Boolean).map((d, j) => <li key={j}>{d}</li>)}
              </ol>
            </>
          ) : (
            s.dg && <p style={{ margin: 0, fontWeight: 600 }}>{dgLabel} {s.dg}</p>
          )}
        </div>
      ))}
      {report.komentar && report.komentar.trim() && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem', marginTop: '0.6rem' }}>
          <div style={SECTION_LABEL}>{t('comment_label')}</div>
          <p style={{ margin: 0, lineHeight: 1.6, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{report.komentar}</p>
        </div>
      )}
    </div>
  );
}

// Kontrole klasifikacije (JPC VSPO) — koriste se i za override unos i za uređivanje nalaza.
function KlasControls({ value, lang, t, onSelect, onToggleEtiology }) {
  const langKey = lang === 'en' ? 'en' : 'hr';
  const v = value || EMPTY_KLAS;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div>
          <label style={FIELD_LABEL}>{t('cls_animal_group')}</label>
          <select value={v.animal_group || ''} onChange={(e) => onSelect('animal_group', e.target.value || null)} style={FIELD_INPUT}>
            <option value="">{t('cls_auto')}</option>
            {TAX.animal_group.map((o) => <option key={o.code} value={o.code}>{o[langKey] || o.en}</option>)}
          </select>
        </div>
        <div>
          <label style={FIELD_LABEL}>{t('cls_system')}</label>
          <select value={v.system || ''} onChange={(e) => onSelect('system', e.target.value || null)} style={FIELD_INPUT}>
            <option value="">{t('cls_auto')}</option>
            {TAX.system.map((o) => <option key={o.code} value={o.code}>{o[langKey] || o.en}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label style={FIELD_LABEL}>{t('cls_etiology')}</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {TAX.etiology.map((o) => {
            const active = (v.etiology || []).includes(o.code);
            return (
              <button
                type="button"
                key={o.code}
                onClick={() => onToggleEtiology(o.code)}
                style={{
                  fontSize: '0.78rem', fontWeight: 600, padding: '0.3rem 0.6rem', borderRadius: '999px',
                  border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                  background: active ? 'var(--primary)' : 'transparent',
                  color: active ? '#fff' : 'var(--text-muted)', cursor: 'pointer',
                }}
              >
                {o[langKey] || o.en}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Strukturirani editor nalaza (metapodaci, sekcije, numerirana dg, komentar).
function ReportEditor({ report, lang, t, updateZaglavlje, updateKlas, toggleEtiology, updateSection, addSection, removeSection, dgToList, dgToString, updateDgItem, addDgItem, removeDgItem, updateKomentar }) {
  const [metaOpen, setMetaOpen] = useState(false);
  const [openSection, setOpenSection] = useState(0);
  const langKey = lang === 'en' ? 'en' : 'hr';

  const z = report.zaglavlje || {};
  const k = report.klasifikacija || {};
  const metaSummary = [
    ...ZAGLAVLJE_FIELDS.map((f) => (z[f] || '').trim()).filter(Boolean),
    k.animal_group && taxLabel('animal_group', k.animal_group, langKey),
    k.system && taxLabel('system', k.system, langKey),
    ...(k.etiology || []).map((c) => taxLabel('etiology', c, langKey)),
  ].filter(Boolean).join(' · ');

  const renderSectionBody = (s, i, dgIsList) => (
    <>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={FIELD_LABEL}>{t('section_title')}</label>
        <input
          value={s.naslov || ''}
          onChange={(e) => updateSection(i, 'naslov', e.target.value)}
          placeholder={t('section_title_ph')}
          style={FIELD_INPUT}
        />
      </div>
      <div style={{ marginBottom: '0.75rem' }}>
        <label style={FIELD_LABEL}>{t('opis_label')}</label>
        <textarea
          value={s.opis || ''}
          onChange={(e) => updateSection(i, 'opis', e.target.value)}
          style={{ ...FIELD_INPUT, minHeight: '140px', resize: 'vertical', lineHeight: 1.7 }}
        />
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
          <label style={{ ...FIELD_LABEL, marginBottom: 0 }}>{t('dg_label')}</label>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => (dgIsList ? dgToString(i) : dgToList(i))}
            style={{ fontSize: '0.72rem' }}
          >
            {dgIsList ? t('dg_to_single') : t('dg_to_list')}
          </button>
        </div>
        {dgIsList ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {s.dg.map((d, j) => (
              <div key={j} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: 'var(--text-muted)', minWidth: '1.2rem' }}>{j + 1}.</span>
                <input
                  value={d}
                  onChange={(e) => updateDgItem(i, j, e.target.value)}
                  style={{ ...FIELD_INPUT, fontWeight: 600 }}
                />
                <button className="btn btn-ghost btn-sm" onClick={() => removeDgItem(i, j)} title={t('remove_section')}>
                  <X size={15} />
                </button>
              </div>
            ))}
            <div>
              <button className="btn btn-secondary btn-sm" onClick={() => addDgItem(i)}>
                <Plus size={15} /> {t('add_dg')}
              </button>
            </div>
          </div>
        ) : (
          <input
            value={s.dg || ''}
            onChange={(e) => updateSection(i, 'dg', e.target.value)}
            style={{ ...FIELD_INPUT, fontWeight: 600 }}
          />
        )}
      </div>
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Metapodaci: zaglavlje + klasifikacija (sklopivo) */}
      <Collapsible title={t('meta_section')} subtitle={metaSummary} open={metaOpen} onToggle={() => setMetaOpen((o) => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', paddingTop: '0.25rem' }}>
          <div>
            <div style={SECTION_LABEL}>{t('header_section')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {ZAGLAVLJE_FIELDS.map((f) => (
                <div key={f}>
                  <label style={FIELD_LABEL}>{t('z_' + f)}</label>
                  <input
                    value={(report.zaglavlje && report.zaglavlje[f]) || ''}
                    onChange={(e) => updateZaglavlje(f, e.target.value)}
                    style={FIELD_INPUT}
                  />
                </div>
              ))}
            </div>
          </div>
          <div>
            <div style={SECTION_LABEL}>{t('cls_section')}</div>
            <KlasControls value={report.klasifikacija} lang={lang} t={t} onSelect={updateKlas} onToggleEtiology={toggleEtiology} />
            {jpcCodeLabel(report.klasifikacija, reportDgSummary(report)) && (
              <p style={{ margin: '0.6rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <strong>{t('jpc_code')}:</strong> {jpcCodeLabel(report.klasifikacija, reportDgSummary(report))}
              </p>
            )}
          </div>
        </div>
      </Collapsible>

      {/* Sekcije */}
      {(report.sekcije || []).map((s, i) => {
        const dgIsList = Array.isArray(s.dg);
        const multi = report.sekcije.length > 1;

        // Jedna sekcija → uvijek otvorena, bez accordiona.
        if (!multi) {
          return (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem' }}>
              {renderSectionBody(s, i, dgIsList)}
            </div>
          );
        }

        const isOpen = openSection === i;
        const dgSummary = dgIsList ? s.dg.filter(Boolean).join('; ') : (s.dg || '');
        const secSubtitle = (s.naslov && s.naslov.trim()) || dgSummary || '';
        return (
          <div key={i} style={{ border: `1px solid ${isOpen ? 'var(--primary)' : 'var(--border)'}`, borderRadius: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 0.9rem' }}>
              <button
                type="button"
                onClick={() => setOpenSection(isOpen ? -1 : i)}
                style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
              >
                <ChevronRight size={16} style={{ transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'none', flexShrink: 0 }} />
                <span style={{ ...SECTION_LABEL, marginBottom: 0, flexShrink: 0 }}>{t('section_label')} {i + 1}</span>
                {secSubtitle && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{secSubtitle}</span>
                )}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => removeSection(i)} title={t('remove_section')}>
                <Trash2 size={15} />
              </button>
            </div>
            {isOpen && <div style={{ padding: '0 0.9rem 0.9rem' }}>{renderSectionBody(s, i, dgIsList)}</div>}
          </div>
        );
      })}

      <div>
        <button className="btn btn-secondary btn-sm" onClick={addSection}>
          <Plus size={15} /> {t('add_section')}
        </button>
      </div>

      {/* Komentar */}
      <div>
        <label style={FIELD_LABEL}>{t('comment_label')}</label>
        <textarea
          value={report.komentar || ''}
          onChange={(e) => updateKomentar(e.target.value)}
          placeholder={t('comment_ph')}
          style={{ ...FIELD_INPUT, minHeight: '80px', resize: 'vertical', lineHeight: 1.6 }}
        />
      </div>
    </div>
  );
}

// ─── Glasovni diktat: kontinuirani Transcribe streaming + inkrementalna ekstrakcija ───
//
// Tok: mikrofon → Transcribe (uživo) → finalizirani segmenti se nižu u transkript
// → debounced poziv extractFields mutacije (Lambda/Bedrock) → popunjena polja obrasca.
// Bedrock se namjerno više NE zove iz preglednika — ide kroz Lambdu.
// Prevodi AWS/preglednik gresku u poruku koja doktoru kaze sto dalje.
// Vraca kljuc prijevoda + tehnicki detalj (detalj je za nas, ne za korisnika).
function describeDictationError(err) {
  const name = err?.name || '';
  const detail = err?.message || String(err);

  // Najcesci uzrok: backend nije deployan pa authenticated role nema
  // transcribe:StartStreamTranscription (vidi amplify/backend.ts).
  if (name === 'AccessDeniedException' || name === 'NotAuthorizedException') {
    return { key: 'dictation_error_denied', detail };
  }
  // getUserMedia: korisnik je odbio mikrofon ili ga je preglednik blokirao.
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { key: 'dictation_error_mic', detail };
  }
  if (name === 'NotFoundError' || name === 'NotReadableError') {
    return { key: 'dictation_error_no_mic', detail };
  }
  // navigator.mediaDevices ne postoji izvan secure contexta (http na ne-localhost).
  if (err instanceof TypeError && /mediaDevices|getUserMedia/.test(detail)) {
    return { key: 'dictation_error_insecure', detail };
  }
  if (name === 'BadRequestException') {
    return { key: 'dictation_error_config', detail };
  }
  return { key: 'dictation_error_generic', detail };
}

function useLiveDictation({ lang, onExtract }) {
  const [isListening, setIsListening] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [partial, setPartial] = useState('');
  // Streaming puca asinkrono, nakon sto je start() vec vratio. Bez ovoga takav
  // pad zavrsi samo u konzoli, a doktor gleda u "Slusam..." koje nikad nista ne da.
  const [error, setError] = useState(null);

  const sessionRef = useRef(null);
  const transcriptRef = useRef('');
  const timerRef = useRef(null);
  const inFlightRef = useRef(false);

  // Refovi da callbackovi unutar žive sesije uvijek vide aktualne vrijednosti.
  const langRef = useRef(lang);
  langRef.current = lang;
  const onExtractRef = useRef(onExtract);
  onExtractRef.current = onExtract;

  const runExtraction = useCallback(async () => {
    const transcript = transcriptRef.current.trim();
    if (!transcript) return;
    // Ako prethodni poziv još traje, ne preskačemo update — samo ga odgodimo.
    if (inFlightRef.current) {
      timerRef.current = setTimeout(runExtraction, EXTRACT_DEBOUNCE_MS);
      return;
    }
    inFlightRef.current = true;
    setIsExtracting(true);
    try {
      const { data, errors } = await client.mutations.extractFields({
        transcript,
        lang: langRef.current,
      });
      if (errors) {
        console.error('extractFields GraphQL errors:', errors);
        return;
      }
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      if (parsed?.error) {
        console.error('extractFields error:', parsed.error);
        return;
      }
      if (parsed) onExtractRef.current?.(parsed);
    } catch (err) {
      // Ekstrakcija je pomoćni korak — neuspjeh ne smije prekinuti diktat.
      console.error('extractFields failed:', err);
    } finally {
      inFlightRef.current = false;
      setIsExtracting(false);
    }
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runExtraction, EXTRACT_DEBOUNCE_MS);
  }, [runExtraction]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const session = await fetchAuthSession();
      const credentials = session.credentials;
      if (!credentials) throw new Error('No credentials');

      transcriptRef.current = '';
      sessionRef.current = await startLiveTranscription({
        credentials,
        region: TRANSCRIBE_REGION,
        languageCode: langRef.current === 'hr' ? 'hr-HR' : 'en-US',
        vocabularyName: langRef.current === 'hr' ? TRANSCRIBE_VOCABULARY_HR : '',
        onPartial: (text) => setPartial(text),
        onFinal: (text) => {
          setPartial('');
          transcriptRef.current = `${transcriptRef.current} ${text}`.trim();
          schedule();
        },
        // Stize tek nakon sto je start() vratio true, pa sesiju gasimo odavde.
        onError: (err) => {
          console.error('Transcribe stream error:', err);
          sessionRef.current = null;
          setIsListening(false);
          setPartial('');
          setError(describeDictationError(err));
        },
      });
      setIsListening(true);
      return true;
    } catch (err) {
      console.error('Live dictation start failed:', err);
      setIsListening(false);
      setError(describeDictationError(err));
      return false;
    }
  }, [schedule]);

  const stop = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) await session.stop();
    setIsListening(false);
    setPartial('');
    // Završni prolaz nad cijelim transkriptom — hvata i zadnji segment.
    await runExtraction();
  }, [runExtraction]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (sessionRef.current) sessionRef.current.stop();
  }, []);

  return { isListening, isExtracting, partial, error, start, stop };
}

function GeneratorContent({ signOut, user }) {
  const [lang, setLang] = useState(localStorage.getItem('vet_lang') || 'en');
  const [details, setDetails] = useState('');
  const [keywords, setKeywords] = useState([]);
  const [kwDraft, setKwDraft] = useState('');
  const [uiMode, setUiMode] = useState(localStorage.getItem('vet_ui_mode') || 'voice');
  const [keywordMode, setKeywordMode] = useState(localStorage.getItem('vet_kw_mode') || 'list');
  const [keywordsText, setKeywordsText] = useState('');
  const [cls, setCls] = useState({ animal_group: null, system: null, etiology: [] });
  const [showClsInput, setShowClsInput] = useState(false);
  const [report, setReport] = useState('');
  const [results, setResults] = useState([]);
  const [resultSource, setResultSource] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [editedReport, setEditedReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [noDbResults, setNoDbResults] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [userProfile, setUserProfile] = useState({ firstName: '', lastName: '' });

  // Zaglavlje izvučeno iz diktata; ima prednost pred automatskim defaultima.
  const [voiceZaglavlje, setVoiceZaglavlje] = useState(null);

  const toggleUiMode = () => setUiMode((m) => {
    const next = m === 'voice' ? 'classic' : 'voice';
    localStorage.setItem('vet_ui_mode', next);
    return next;
  });

  const t = (key) => translations[lang][key] || key;

  useEffect(() => {
    localStorage.setItem('vet_lang', lang);
  }, [lang]);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const attrs = await fetchUserAttributes();
      setUserProfile({
        firstName: attrs.given_name || '',
        lastName: attrs.family_name || ''
      });
    } catch (e) {
      console.error('Error fetching user attributes:', e);
    }
  };

  useEffect(() => {
    if (showHistory) {
      fetchHistory();
    }
  }, [showHistory]);

  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const { data } = await client.models.Diagnosis.list();
      setHistory(data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (error) {
      console.error('Error fetching history:', error);
    } finally {
      setLoadingHistory(false);
    }
  };

  // ─── Ključne riječi ───
  const classicSingle = uiMode === 'classic' && keywordMode === 'single';

  const getKeywordInputs = () => classicSingle
    ? keywordsText.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
    : keywords.filter((k) => k.trim());

  const hasKeywordInput = classicSingle
    ? keywordsText.trim() !== ''
    : keywords.some((k) => k.trim());

  // Dodaj (dedupe, bez praznih). U klasičnom single modu dopisuje u tekst, inače u čipove.
  const applyVoiceKeywords = (items) => {
    if (classicSingle) {
      setKeywordsText((prev) => {
        const base = prev.trim();
        const joined = items.map((k) => k.trim()).filter(Boolean).join(', ');
        if (!joined) return prev;
        return base ? `${base}, ${joined}` : joined;
      });
      return;
    }
    setKeywords((prev) => {
      const out = [...prev];
      const seen = new Set(out.map((k) => k.trim().toLowerCase()));
      for (const it of items) {
        const v = (it || '').trim();
        if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
      }
      return out;
    });
  };

  // Rezultat ekstrakcije → polja obrasca. Poziva se dok doktor još diktira.
  const applyExtraction = (fields) => {
    if (fields.details) setDetails(fields.details);
    if (Array.isArray(fields.keywords) && fields.keywords.length) applyVoiceKeywords(fields.keywords);

    const k = fields.klasifikacija || {};
    setCls((prev) => ({
      animal_group: k.animal_group || prev.animal_group,
      system: k.system || prev.system,
      etiology: (k.etiology && k.etiology.length) ? k.etiology : prev.etiology,
    }));

    const z = fields.zaglavlje || {};
    if (z.oznaka_uzorka || z.vrsta_uzorka || z.datum) {
      setVoiceZaglavlje((prev) => ({ ...(prev || {}), ...Object.fromEntries(Object.entries(z).filter(([, v]) => v)) }));
    }
  };

  const dictation = useLiveDictation({ lang, onExtract: applyExtraction });

  const removeKeyword = (index) => setKeywords((prev) => prev.filter((_, i) => i !== index));

  const commitKwDraft = () => {
    const parts = kwDraft.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) applyVoiceKeywords(parts);
    setKwDraft('');
  };

  // ─── Klasični layout: pojedinačna keyword polja + list/single toggle ───
  const handleKeywordChange = (index, value) => setKeywords((prev) => {
    const next = [...prev];
    while (next.length <= index) next.push('');
    next[index] = value;
    return next;
  });
  const addKeywordField = () => setKeywords((prev) => [...prev, '']);

  const toggleKeywordMode = () => {
    if (keywordMode === 'list') {
      setKeywordsText(keywords.map((k) => k.trim()).filter(Boolean).join(', '));
      setKeywordMode('single');
      localStorage.setItem('vet_kw_mode', 'single');
    } else {
      const arr = keywordsText.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
      setKeywords(arr);
      setKeywordMode('list');
      localStorage.setItem('vet_kw_mode', 'list');
    }
  };

  // ─── Diktafon: start/stop žive sesije ───
  const handleDictate = async () => {
    if (dictation.isListening) {
      await dictation.stop();
      return;
    }
    // Neuspjeh se prikazuje inline (dictation.error) — alert je i prekidao rad
    // i uvijek krivio mikrofon, cak i kad je uzrok bio IAM ili region.
    await dictation.start();
  };

  const generateReport = async () => {
    setLoading(true);
    setReport('');
    setNoDbResults(false);
    try {
      const { data, errors } = await client.mutations.generateReport({
        keywords: buildEffectiveKeywords(getKeywordInputs(), details),
        details: details,
        lang: lang,
        animalGroup: cls.animal_group || '',
        system: cls.system || '',
        etiology: (cls.etiology || []).join(',')
      });

      if (errors) {
        console.error('GraphQL errors:', errors);
        setReport("Error generating report: " + errors[0].message);
        setResults([]);
        setSelectedIdx(null);
        setEditedReport(null);
      } else {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          const list = (parsed?.results || [parsed]).map(normalizeReport).filter(Boolean);
          if (list.length) {
            setResults(list);
            setResultSource(parsed.source || 'sonnet');
            setReport('');
            if (list.length === 1) {
              setSelectedIdx(0);
              setEditedReport(cloneReport(applyHeaderDefaults(list[0])));
            } else {
              setSelectedIdx(null);
              setEditedReport(null);
            }
          } else {
            setReport((typeof data === 'string' ? data : '') || "No report generated.");
            setResults([]);
            setSelectedIdx(null);
            setEditedReport(null);
          }
        } catch (e) {
          setReport((typeof data === 'string' ? data : '') || "No report generated.");
          setResults([]);
          setSelectedIdx(null);
          setEditedReport(null);
        }
      }
    } catch (error) {
      console.error('Error calling generateReport:', error);
      setReport("Error: " + (error.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const searchDatabase = async () => {
    setSearchLoading(true);
    setReport('');
    setResults([]);
    setResultSource('');
    setNoDbResults(false);
    setSelectedIdx(null);
    setEditedReport(null);
    try {
      const { data, errors } = await client.graphql({
        query: `mutation SearchDatabase($keywords: [String], $action: String) { searchDatabase(keywords: $keywords, action: $action) }`,
        variables: { keywords: buildEffectiveKeywords(getKeywordInputs(), details), action: 'search' }
      });
      if (errors) {
        console.error('GraphQL errors:', errors);
        setReport("Error: " + errors[0].message);
      } else {
        const raw = data?.searchDatabase ?? data;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const list = (parsed.results || []).map(normalizeReport).filter(Boolean);
        if (parsed.source === 'none' || list.length === 0) {
          setNoDbResults(true);
        } else {
          setResults(list);
          setResultSource(parsed.source || 'router');
          if (list.length === 1) {
            setSelectedIdx(0);
            setEditedReport(cloneReport(list[0]));
          }
        }
      }
    } catch (error) {
      console.error('Error calling searchDatabase:', error);
      setReport("Error: " + (error.message || "Unknown error"));
    } finally {
      setSearchLoading(false);
    }
  };

  const selectResult = (idx) => {
    setSelectedIdx(idx);
    setEditedReport(cloneReport(results[idx]));
  };

  const deselectResult = () => {
    setSelectedIdx(null);
    setEditedReport(null);
  };

  // ─── Immutable patch helpers za editedReport ───
  const patchReport = (fn) => setEditedReport((prev) => {
    if (!prev) return prev;
    const next = cloneReport(prev);
    fn(next);
    return next;
  });

  const updateZaglavlje = (field, value) => patchReport((r) => {
    r.zaglavlje = { ...(r.zaglavlje || {}), [field]: value };
  });
  const updateSection = (i, field, value) => patchReport((r) => { r.sekcije[i][field] = value; });
  const addSection = () => patchReport((r) => { r.sekcije.push({ naslov: '', opis: '', dg: '' }); });
  const removeSection = (i) => patchReport((r) => {
    r.sekcije.splice(i, 1);
    if (r.sekcije.length === 0) r.sekcije.push({ naslov: '', opis: '', dg: '' });
  });
  const dgToList = (i) => patchReport((r) => {
    const cur = r.sekcije[i].dg;
    r.sekcije[i].dg = Array.isArray(cur) ? cur : [cur || ''];
  });
  const dgToString = (i) => patchReport((r) => {
    const cur = r.sekcije[i].dg;
    r.sekcije[i].dg = Array.isArray(cur) ? (cur[0] || '') : (cur || '');
  });
  const updateDgItem = (i, j, value) => patchReport((r) => { r.sekcije[i].dg[j] = value; });
  const addDgItem = (i) => patchReport((r) => { r.sekcije[i].dg.push(''); });
  const removeDgItem = (i, j) => patchReport((r) => {
    r.sekcije[i].dg.splice(j, 1);
    if (r.sekcije[i].dg.length === 0) r.sekcije[i].dg = '';
  });
  const updateKomentar = (value) => patchReport((r) => { r.komentar = value; });
  const updateKlas = (field, value) => patchReport((r) => {
    r.klasifikacija = { ...(r.klasifikacija || EMPTY_KLAS), [field]: value };
  });
  const toggleEtiology = (code) => patchReport((r) => {
    const k = r.klasifikacija = { ...(r.klasifikacija || EMPTY_KLAS) };
    const set = new Set(k.etiology || []);
    set.has(code) ? set.delete(code) : set.add(code);
    k.etiology = [...set];
  });

  // Override handleri za klasifikaciju u formi unosa.
  const clsSelect = (field, value) => setCls((p) => ({ ...p, [field]: value }));
  const clsToggleEtiology = (code) => setCls((p) => {
    const set = new Set(p.etiology);
    set.has(code) ? set.delete(code) : set.add(code);
    return { ...p, etiology: [...set] };
  });

  const clsLangKey = lang === 'en' ? 'en' : 'hr';
  const clsInputSummary = [
    cls.animal_group && taxLabel('animal_group', cls.animal_group, clsLangKey),
    cls.system && taxLabel('system', cls.system, clsLangKey),
    ...cls.etiology.map((c) => taxLabel('etiology', c, clsLangKey)),
  ].filter(Boolean).join(' · ') || t('cls_auto');

  // Automatsko popunjavanje zaglavlja (samo prazna polja) pri generiranju.
  const applyHeaderDefaults = (rep) => {
    const doctor = userProfile.firstName && userProfile.lastName
      ? `${t('doctor_prefix')} ${userProfile.firstName} ${userProfile.lastName}`
      : (user?.signInDetails?.loginId || '');
    const yy = String(new Date().getFullYear()).slice(-2);
    const seq = parseInt(localStorage.getItem('vet_hp_seq') || '1', 10) || 1;
    const sampleText = `${getKeywordInputs().join(' ')} ${details}`;

    // Ono što je doktor izdiktirao ima prednost pred automatskim defaultima.
    const z = { ...(rep.zaglavlje || {}), ...(voiceZaglavlje || {}) };
    if (!z.oznaka_uzorka) z.oznaka_uzorka = `HP ${seq}/${yy}`;
    if (!z.datum) z.datum = new Date().toLocaleDateString(lang === 'hr' ? 'hr-HR' : 'en-GB');
    if (!z.doktor) z.doktor = doctor;
    if (!z.vrsta_uzorka) {
      const guess = guessSampleType(sampleText, lang);
      if (guess) z.vrsta_uzorka = guess;
    }
    return { ...rep, zaglavlje: z };
  };

  const activeReport = selectedIdx !== null && editedReport
    ? formatReportText(editedReport, lang)
    : report;

  const saveToStorage = async () => {
    if (!activeReport) {
      alert('Odaberi nalaz za spremanje.');
      return;
    }
    setSaving(true);
    try {
      await client.models.Diagnosis.create({
        details: details,
        keywords: keywords.filter(k => k.trim() !== ''),
        report: activeReport
      });
      // Nakon spremanja povećaj urudžbeni brojač (HP N/god) za sljedeći nalaz.
      const seq = parseInt(localStorage.getItem('vet_hp_seq') || '1', 10) || 1;
      localStorage.setItem('vet_hp_seq', String(seq + 1));
      alert('✅ Diagnosis successfully saved to your history!');
      fetchHistory(); // Refresh history if panel is open
    } catch (error) {
      console.error('Error saving diagnosis:', error);
      alert('❌ Failed to save diagnosis: ' + (error.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  const deleteFromHistory = async (e, item) => {
    e.stopPropagation();
    if (!item || !item.id) return;
    
    try {
      console.log('Deleting diagnosis ID:', item.id);
      await client.models.Diagnosis.delete({ id: item.id });
      fetchHistory(); 
    } catch (error) {
      console.error('Error deleting diagnosis:', error);
    }
  };

  const downloadPDF = async () => {
    if (!activeReport) {
      alert('Odaberi nalaz za PDF.');
      return;
    }
    try {
      const date = new Date().toLocaleDateString();
      const doctorDisplayName = userProfile.firstName && userProfile.lastName 
        ? `${t('doctor_prefix')} ${userProfile.firstName} ${userProfile.lastName}`
        : user?.signInDetails?.loginId || 'N/A';
      
      // Create a hidden but "visible to layout" container
      const tempDiv = document.createElement('div');
      tempDiv.id = 'pdf-render-container';
      tempDiv.style.position = 'fixed';
      tempDiv.style.top = '0';
      tempDiv.style.left = '-2000px'; // Far off-screen
      tempDiv.style.width = '700px'; 
      tempDiv.style.padding = '40px';
      tempDiv.style.backgroundColor = '#ffffff';
      tempDiv.style.fontFamily = "'Inter', sans-serif";
      tempDiv.style.color = '#0f172a';
      tempDiv.style.lineHeight = '1.6';
      
      let htmlContent = `
        <div style="border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px;">
          <h1 style="color: #2563eb; margin: 0; font-size: 28px;">dAIgnostics Studio</h1>
          <p style="color: #64748b; font-size: 14px; margin: 10px 0 0 0;">
            ${t('app_subtitle')}
          </p>
        </div>
        
        <div style="margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div>
            <p style="margin: 0; font-weight: 700; font-size: 12px; color: #64748b; text-transform: uppercase;">${lang === 'en' ? 'Generated On' : 'Generirano dana'}</p>
            <p style="margin: 5px 0 0 0; font-size: 16px;">${date}</p>
          </div>
          <div>
            <p style="margin: 0; font-weight: 700; font-size: 12px; color: #64748b; text-transform: uppercase;">${lang === 'en' ? 'Doctor' : 'Doktor'}</p>
            <p style="margin: 5px 0 0 0; font-size: 16px;">${doctorDisplayName}</p>
          </div>
        </div>
      `;
      
      if (details) {
        htmlContent += `
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">${t('case_details')}:</p>
            <p style="margin: 0; font-size: 14px; white-space: pre-wrap; color: #475569;">${details}</p>
          </div>
        `;
      }
      
      const activeKeywords = keywords.filter(k => k.trim() !== '').join(', ');
      if (activeKeywords) {
        htmlContent += `
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">${t('observations_label')}:</p>
            <p style="margin: 0; font-size: 14px; color: #475569;">${activeKeywords}</p>
          </div>
        `;
      }
      
      if (selectedIdx !== null && editedReport) {
        const en = lang === 'en';
        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const dgLabel = en ? 'Dx:' : 'Dg.:';

        const z = editedReport.zaglavlje || {};
        const zLine = ZAGLAVLJE_FIELDS.map((f) => (z[f] || '').trim()).filter(Boolean).join(' · ');
        const langKey = en ? 'en' : 'hr';
        const kl = editedReport.klasifikacija || {};
        const kParts = [];
        if (kl.animal_group) kParts.push(taxLabel('animal_group', kl.animal_group, langKey));
        if (kl.system) kParts.push(taxLabel('system', kl.system, langKey));
        if (kl.etiology && kl.etiology.length) kParts.push(kl.etiology.map((c) => taxLabel('etiology', c, langKey)).join(', '));
        const jpc = jpcCodeLabel(kl, reportDgSummary(editedReport));
        if (zLine || kParts.length || jpc) {
          htmlContent += `<div style="margin-bottom: 20px;">`;
          if (zLine) htmlContent += `<p style="margin: 0 0 4px 0; font-size: 13px; font-weight: 600; color: #475569;">${esc(zLine)}</p>`;
          if (kParts.length) htmlContent += `<p style="margin: 0 0 2px 0; font-size: 12px; color: #64748b;">${esc(kParts.join(' · '))}</p>`;
          if (jpc) htmlContent += `<p style="margin: 0; font-size: 12px; color: #64748b;"><strong>${en ? 'JPC code' : 'JPC kôd'}:</strong> ${esc(jpc)}</p>`;
          htmlContent += `</div>`;
        }

        (editedReport.sekcije || []).forEach((s) => {
          htmlContent += `<div style="margin-bottom: 22px;">`;
          if (s.naslov && s.naslov.trim()) {
            htmlContent += `<p style="margin: 0 0 8px 0; font-weight: 700; font-size: 15px; color: #0f172a;">${esc(s.naslov.trim())}</p>`;
          }
          if (s.opis && s.opis.trim()) {
            htmlContent += `<div style="margin: 0 0 10px 0; font-size: 14px; line-height: 1.8; color: #1e293b; white-space: pre-wrap;">${esc(s.opis.trim())}</div>`;
          }
          if (Array.isArray(s.dg)) {
            const items = s.dg.map((d) => (d || '').trim()).filter(Boolean);
            if (items.length) {
              htmlContent += `<p style="margin: 0 0 4px 0; font-weight: 700; font-size: 14px; color: #1e293b;">${dgLabel}</p>`;
              htmlContent += `<ol style="margin: 0; padding-left: 20px; font-size: 14px; font-weight: 600; color: #1e293b;">${items.map((d) => `<li style="margin-bottom: 3px;">${esc(d)}</li>`).join('')}</ol>`;
            }
          } else if (s.dg && s.dg.trim()) {
            htmlContent += `<p style="margin: 0; font-size: 14px; font-weight: 600; color: #1e293b;">${dgLabel} ${esc(s.dg.trim())}</p>`;
          }
          htmlContent += `</div>`;
        });

        if (editedReport.komentar && editedReport.komentar.trim()) {
          htmlContent += `
            <div style="margin-bottom: 25px; border-top: 1px solid #e2e8f0; padding-top: 12px;">
              <p style="margin: 0 0 6px 0; font-weight: 700; font-size: 14px; color: #64748b;">${en ? 'Comment' : 'Komentar'}:</p>
              <div style="margin: 0; font-size: 14px; line-height: 1.7; color: #475569; white-space: pre-wrap;">${esc(editedReport.komentar.trim())}</div>
            </div>`;
        }
      } else {
        htmlContent += `
          <div style="margin-bottom: 25px;">
            <p style="margin: 0 0 10px 0; font-weight: 700; font-size: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">${t('narrative_report')}:</p>
            <div style="margin: 0; font-size: 14px; line-height: 1.8; color: #1e293b; white-space: pre-wrap;">${report}</div>
          </div>`;
      }
      htmlContent += `
        
        <div style="margin-top: 50px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 10px;">
          ${t('footer_text')}
        </div>
      `;
      
      tempDiv.innerHTML = htmlContent;
      document.body.appendChild(tempDiv);
      
      // Wait for font/rendering
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const canvas = await html2canvas(tempDiv, {
        scale: 2, // Retina quality
        useCORS: true,
        backgroundColor: '#ffffff'
      });
      
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'px',
        format: [canvas.width / 2, canvas.height / 2] // Scale to actual dimensions
      });
      
      pdf.addImage(imgData, 'JPEG', 0, 0, canvas.width / 2, canvas.height / 2);
      
      const fileName = `veterinary_report_${new Date().getTime()}.pdf`;
      
      const pdfBlob = pdf.output('blob');
      const blobUrl = URL.createObjectURL(pdfBlob);
      
      // Open in a new tab to bypass the /tmp/ download interceptor issues.
      // The user can then see the report and use the browser's "Save" or "Download" icon.
      const newTab = window.open(blobUrl, '_blank');
      
      // Cleanup the DOM element
      document.body.removeChild(tempDiv);
      
      // If the tab opened successfully, we can't reliably set the title for a Blob URL in all browsers,
      // but the data is there for viewing. 
      if (!newTab) {
        // Fallback to download if popup is blocked
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
      
      // Revoke after a delay to ensure the new tab has loaded it
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (error) {
      console.error('Error in PDF generation flow:', error);
      alert('❌ Failed to generate PDF: ' + (error.message || 'Unknown error'));
    }
  };

  const resetForm = () => {
    setDetails('');
    setKeywords([]);
    setKwDraft('');
    setKeywordsText('');
    setCls({ animal_group: null, system: null, etiology: [] });
    setReport('');
    setResults([]);
    setResultSource('');
    setSelectedIdx(null);
    setEditedReport(null);
    setNoDbResults(false);
    setShowHistory(false);
    setShowProfile(false);
  };

  const loadFromHistory = (item) => {
    setDetails(item.details || '');
    setKeywords((item.keywords || []).filter((k) => k && k.trim()));
    setKwDraft('');
    setKeywordsText((item.keywords || []).filter((k) => k && k.trim()).join(', '));
    setResults([]);
    setResultSource('');
    setSelectedIdx(null);
    setEditedReport(null);
    setReport(item.report || '');
    setShowHistory(false);
  };

  const ProfileModal = () => {
    const [editingProfile, setEditingProfile] = useState({ ...userProfile });
    const [passwords, setPasswords] = useState({ old: '', new: '', confirm: '' });
    const [savingProfile, setSavingProfile] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);

    const handleUpdateProfile = async (e) => {
      e.preventDefault();
      setSavingProfile(true);
      try {
        await updateUserAttributes({
          userAttributes: {
            given_name: editingProfile.firstName,
            family_name: editingProfile.lastName
          }
        });
        await loadProfile();
        alert(t('profile_update_success'));
      } catch (err) {
        console.error(err);
        alert('Error: ' + err.message);
      } finally {
        setSavingProfile(false);
      }
    };

    const handleChangePassword = async (e) => {
      e.preventDefault();
      if (passwords.new !== passwords.confirm) {
        alert(t('password_match_error'));
        return;
      }
      setChangingPassword(true);
      try {
        await updatePassword({
          oldPassword: passwords.old,
          newPassword: passwords.new
        });
        alert(t('password_change_success'));
        setPasswords({ old: '', new: '', confirm: '' });
      } catch (err) {
        console.error(err);
        alert('Error: ' + err.message);
      } finally {
        setChangingPassword(false);
      }
    };

    return (
      <div className="profile-overlay" onClick={() => setShowProfile(false)}>
        <div className="profile-panel" onClick={e => e.stopPropagation()}>
          <div className="profile-header">
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <User size={20} /> {t('profile_title')}
            </h3>
            <button className="btn btn-ghost" onClick={() => setShowProfile(false)}>
              <X size={20} />
            </button>
          </div>
          <div className="profile-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>{t('profile_instructions')}</p>
            
            <form className="profile-section" onSubmit={handleUpdateProfile}>
              <h4><ShieldCheck size={18} /> {t('profile_title')}</h4>
              <div className="profile-row">
                <div>
                  <label className="input-label">{t('first_name')}</label>
                  <input 
                    type="text" 
                    value={editingProfile.firstName} 
                    onChange={e => setEditingProfile({...editingProfile, firstName: e.target.value})}
                    required
                  />
                </div>
                <div>
                  <label className="input-label">{t('last_name')}</label>
                  <input 
                    type="text" 
                    value={editingProfile.lastName} 
                    onChange={e => setEditingProfile({...editingProfile, lastName: e.target.value})}
                    required
                  />
                </div>
              </div>
              <button className="btn btn-primary" style={{ width: '100%' }} disabled={savingProfile}>
                {savingProfile ? <div className="loading-spinner"></div> : t('update_profile')}
              </button>
            </form>

            <hr style={{ margin: '2rem 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            <form className="profile-section" onSubmit={handleChangePassword}>
              <h4><Lock size={18} /> {t('change_password')}</h4>
              <div style={{ marginBottom: '1rem' }}>
                <label className="input-label">{t('old_password')}</label>
                <input 
                  type="password" 
                  value={passwords.old} 
                  onChange={e => setPasswords({...passwords, old: e.target.value})}
                  required
                />
              </div>
              <div className="profile-row">
                <div>
                  <label className="input-label">{t('new_password')}</label>
                  <input 
                    type="password" 
                    value={passwords.new} 
                    onChange={e => setPasswords({...passwords, new: e.target.value})}
                    required
                  />
                </div>
                <div>
                  <label className="input-label">{t('confirm_password')}</label>
                  <input 
                    type="password" 
                    value={passwords.confirm} 
                    onChange={e => setPasswords({...passwords, confirm: e.target.value})}
                    required
                  />
                </div>
              </div>
              <button className="btn btn-secondary" style={{ width: '100%' }} disabled={changingPassword}>
                {changingPassword ? <div className="loading-spinner"></div> : t('change_password')}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="app-container">
      <header>
        <div 
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
          onClick={resetForm}
          title={lang === 'en' ? 'New Diagnosis' : 'Novi nalaz'}
        >
          <Stethoscope size={32} color="var(--brand-red)" />
          <h1 className="hide-mobile" style={{ fontSize: '1.25rem' }}>dAIgnostics Studio</h1>
        </div>
        
        <div style={{ flex: 1 }}></div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div className="user-pill" onClick={() => setShowProfile(true)}>
            <User size={18} />
            <span className="hide-mobile" style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userProfile.firstName && userProfile.lastName 
                ? `${userProfile.firstName} ${userProfile.lastName}` 
                : user?.signInDetails?.loginId}
            </span>
          </div>

          <button
            onClick={toggleUiMode}
            className="btn btn-ghost"
            title={uiMode === 'voice' ? t('ui_switch_to_classic') : t('ui_switch_to_voice')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
          >
            <LayoutGrid size={20} />
            <span className="hide-mobile" style={{ fontSize: '0.8rem', fontWeight: 600 }}>
              {uiMode === 'voice' ? t('ui_classic') : t('ui_voice')}
            </span>
          </button>

          <button onClick={() => setShowHistory(true)} className="btn btn-ghost" title={t('history')}>
            <History size={20} />
          </button>

          <div className="lang-toggle" style={{ margin: 0 }}>
            <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>EN</button>
            <button className={`lang-btn ${lang === 'hr' ? 'active' : ''}`} onClick={() => setLang('hr')}>HR</button>
          </div>

          <button onClick={signOut} className="btn btn-ghost" title={t('sign_out')}>
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className={`main-content ${(results.length > 0 || report) ? 'with-report' : ''}`}>
        <section className="card keyword-section">
          <h2>{t('clinical_input')}</h2>
          <p style={{ marginBottom: '1.5rem', color: 'var(--text-muted)' }}>
            {t('clinical_input_subtitle')}
          </p>

          {uiMode === 'voice' ? (
          <>
          {/* Diktafon: veterinar ispriča što vidi pod mikroskopom */}
          <div style={{ marginBottom: '1.25rem' }}>
            <div className="label-with-mic" style={{ justifyContent: 'space-between' }}>
              <label className="input-label" style={{ marginBottom: 0 }}>{t('dictation_label')}</label>
              {dictation.isExtracting && (
                <span style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 500 }}>{t('dictation_extracting')}</span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDictate}
              style={{
                width: '100%', margin: '0.5rem 0 0.75rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                ...(dictation.isListening ? { background: '#dc2626', borderColor: '#dc2626', color: '#fff' } : {}),
              }}
            >
              {dictation.isListening
                ? <><MicOff size={18} /> {t('dictation_stop')}</>
                : <><Mic size={18} /> {t('dictation_start')}</>}
            </button>
            {/* Pad streaminga stiže asinkrono — bez ovoga ostane samo u konzoli. */}
            {dictation.error && !dictation.isListening && (
              <div style={{
                margin: '0 0 0.75rem', padding: '0.6rem 0.75rem',
                borderRadius: '6px', border: '1px solid #fecaca', background: '#fef2f2',
                fontSize: '0.85rem', color: '#991b1b',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem' }}>
                  <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                  <span style={{ fontWeight: 500 }}>{t(dictation.error.key)}</span>
                </div>
                {dictation.error.detail && (
                  <div style={{ marginTop: '0.35rem', paddingLeft: '2.05rem', fontSize: '0.75rem', opacity: 0.75, wordBreak: 'break-word' }}>
                    {dictation.error.detail}
                  </div>
                )}
              </div>
            )}
            {/* Živi transkript: hipoteza koja se još mijenja dok doktor govori. */}
            {dictation.isListening && (
              <div style={{
                margin: '0 0 0.75rem', padding: '0.5rem 0.65rem', minHeight: '2.2rem',
                borderRadius: '6px', border: '1px dashed var(--border)',
                fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic',
              }}>
                {dictation.partial || t('dictation_listening')}
              </div>
            )}
            <textarea
              className="details-textarea"
              placeholder={t('dictation_placeholder')}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>

          {/* Izvučene ključne riječi (čipovi) */}
          <div>
            <label className="input-label">{t('keywords_label')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.5rem', minHeight: '1.5rem' }}>
              {keywords.length === 0 && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('keywords_empty')}</span>
              )}
              {keywords.map((kw, index) => (
                <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', fontWeight: 600, background: 'var(--bg-subtle, #f1f5f9)', color: 'var(--text, #0f172a)', padding: '0.28rem 0.35rem 0.28rem 0.65rem', borderRadius: '999px' }}>
                  {kw}
                  <button
                    type="button"
                    onClick={() => removeKeyword(index)}
                    title={t('remove_section')}
                    style={{ display: 'inline-flex', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }}
                  >
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
            <input
              type="text"
              value={kwDraft}
              onChange={(e) => setKwDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitKwDraft(); } }}
              onBlur={commitKwDraft}
              placeholder={t('keywords_add_placeholder')}
              style={{ marginTop: '0.6rem', width: '100%' }}
            />
          </div>
          </>
          ) : (
          <>
          {/* Klasični layout: Case details */}
          <div style={{ marginBottom: '1.5rem' }}>
            <div className="label-with-mic">
              <label className="input-label" style={{ marginBottom: 0 }}>{t('case_details')}</label>
            </div>
            <textarea
              className="details-textarea"
              placeholder={t('case_details_placeholder')}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              style={{ marginTop: '0.5rem' }}
            />
          </div>

          {/* Klasični layout: Observations */}
          <div>
            <div className="label-with-mic">
              <label className="input-label" style={{ marginBottom: 0 }}>{t('observations_label')}</label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={toggleKeywordMode}
                style={{ marginLeft: 'auto', fontSize: '0.78rem' }}
              >
                {keywordMode === 'list' ? t('kw_switch_to_single') : t('kw_switch_to_list')}
              </button>
            </div>

            {keywordMode === 'single' ? (
              <div style={{ marginTop: '0.5rem' }}>
                <textarea
                  className="details-textarea"
                  placeholder={t('keywords_single_placeholder')}
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  style={{ minHeight: '80px' }}
                />
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('keywords_single_hint')}</p>
              </div>
            ) : (
              <>
                <div className="keyword-inputs" style={{ marginTop: '0.5rem' }}>
                  {(keywords.length ? keywords : ['', '', '']).map((kw, index) => (
                    <input
                      key={index}
                      type="text"
                      placeholder={`${t('observation_placeholder')} ${index + 1}...`}
                      value={kw}
                      onChange={(e) => handleKeywordChange(index, e.target.value)}
                    />
                  ))}
                </div>
                <div style={{ marginTop: '0.75rem' }}>
                  <button className="btn btn-secondary btn-sm" onClick={addKeywordField} title={t('add_observation')}>
                    <Plus size={16} /> {t('add_observation')}
                  </button>
                </div>
              </>
            )}
          </div>
          </>
          )}

          <div style={{ marginTop: '1.5rem' }}>
            <Collapsible
              title={`${t('cls_section')} ${t('cls_optional_hint')}`}
              subtitle={clsInputSummary}
              open={showClsInput}
              onToggle={() => setShowClsInput((o) => !o)}
            >
              <div style={{ paddingTop: '0.25rem' }}>
                <KlasControls value={cls} lang={lang} t={t} onSelect={clsSelect} onToggleEtiology={clsToggleEtiology} />
              </div>
            </Collapsible>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '2rem' }}>
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={generateReport}
              disabled={loading || searchLoading || (!hasKeywordInput && !details)}
            >
              {loading ? <div className="loading-spinner"></div> : <><Send size={18} /> {t('generate_btn')}</>}
            </button>
            <button
              className="btn btn-secondary"
              style={{ flex: 1 }}
              onClick={searchDatabase}
              disabled={searchLoading || loading || (!hasKeywordInput && !details)}
            >
              {searchLoading ? <div className="loading-spinner"></div> : <><Search size={18} /> {t('search_btn')}</>}
            </button>
          </div>
        </section>

        {results.length > 0 && (
          <section className="card report-output">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={20} />
                {resultSource === 'router' ? `📚 ${results.length} ${t('results_from_db')}` : `🤖 ${t('generated_label')}`}
              </h3>
              <div className="actions">
                <button className="btn btn-secondary" onClick={downloadPDF} disabled={selectedIdx === null} title={t('pdf_btn')}>
                  <Download size={18} /> {t('pdf_btn')}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={saveToStorage}
                  disabled={saving || selectedIdx === null}
                  title={t('save_btn')}
                >
                  {saving ? <div className="loading-spinner"></div> : <><Save size={18} /> {t('save_btn')}</>}
                </button>
              </div>
            </div>
            {results.length > 1 && selectedIdx === null && (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                {t('select_hint')}
              </p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {results.map((r, i) => {
                const isSelected = selectedIdx === i;
                return (
                  <div key={i} style={{
                    border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                    borderRadius: '8px',
                    padding: '1.25rem',
                    opacity: selectedIdx !== null && !isSelected ? 0.5 : 1,
                    transition: 'all 0.15s',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      {results.length > 1 && (
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isSelected ? 'var(--primary)' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {t('result_label')} {i + 1}{r.vrsta_nalaza ? ` · ${r.vrsta_nalaza}` : ''}
                        </div>
                      )}
                      <div style={{ marginLeft: 'auto' }}>
                        {isSelected ? (
                          <button className="btn btn-secondary btn-sm" onClick={deselectResult}>
                            {t('deselect_result')}
                          </button>
                        ) : (
                          <button className="btn btn-primary btn-sm" onClick={() => selectResult(i)}>
                            {t('select_result')}
                          </button>
                        )}
                      </div>
                    </div>

                    {isSelected && editedReport ? (
                      <ReportEditor
                        report={editedReport}
                        lang={lang}
                        t={t}
                        updateZaglavlje={updateZaglavlje}
                        updateKlas={updateKlas}
                        toggleEtiology={toggleEtiology}
                        updateSection={updateSection}
                        addSection={addSection}
                        removeSection={removeSection}
                        dgToList={dgToList}
                        dgToString={dgToString}
                        updateDgItem={updateDgItem}
                        addDgItem={addDgItem}
                        removeDgItem={removeDgItem}
                        updateKomentar={updateKomentar}
                      />
                    ) : (
                      <ReportPreview report={r} lang={lang} t={t} />
                    )}

                    {IN_IFRAME && isSelected && editedReport && (
                      <button
                        className="btn btn-primary"
                        style={{ marginTop: '1rem', width: '100%' }}
                        onClick={() =>
                          window.parent?.postMessage(
                            { type: 'vetdb:report', report: editedReport, text: formatReportText(editedReport, lang) },
                            '*'
                          )
                        }
                      >
                        ✓ Ubaci u VetDB
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {noDbResults && !results.length && (
          <section className="card report-output">
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem 0', fontSize: '1rem' }}>
              🔍 {t('no_db_results')}
            </p>
          </section>
        )}

        {report && !results.length && (
          <section className="card report-output">
            <h3 style={{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <FileText size={20} /> {t('narrative_report')}
            </h3>
            <textarea
              className="report-text"
              value={report}
              onChange={(e) => setReport(e.target.value)}
              style={{ width: '100%', minHeight: '400px', border: 'none', resize: 'vertical', display: 'block' }}
            />
          </section>
        )}
      </main>

      {showHistory && (
        <div className="history-overlay" onClick={() => setShowHistory(false)}>
          <div className="history-panel" onClick={e => e.stopPropagation()}>
            <div className="history-header">
              <h3 style={{ margin: 0 }}>{t('diagnosis_history')}</h3>
              <button className="btn btn-ghost" onClick={() => setShowHistory(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="history-list">
              {loadingHistory ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <div className="loading-spinner"></div>
                </div>
              ) : history.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t('no_history')}</p>
              ) : (
                history.map(item => (
                  <div key={item.id} className="history-item" onClick={() => loadFromHistory(item)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <h4 style={{ color: 'var(--primary)', flex: 1, margin: 0, paddingRight: '1rem' }}>
                        {item.details?.slice(0, 30) || item.keywords?.slice(0, 3).join(', ') || 'Diagnostic Report'}
                      </h4>
                      <button 
                        type="button"
                        className="btn btn-ghost" 
                        style={{ padding: '0.6rem', color: '#ef4444', zIndex: 10, position: 'relative' }} 
                        onClick={(e) => deleteFromHistory(e, item)}
                        title="Delete Diagnosis"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    {item.details && <p style={{ fontSize: '0.8rem', fontStyle: 'italic', marginBottom: '0.5rem', marginTop: '0.5rem' }}>{item.details.slice(0, 60)}...</p>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <Clock size={12} /> {new Date(item.createdAt).toLocaleDateString()} at {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showProfile && <ProfileModal />}

      <footer className="footer">
        {t('footer_text')}
      </footer>
    </div>
  );
}

export default function App() {
  const formFields = {
    signUp: {
      email: { order: 1 },
      given_name: { 
        label: 'First Name', 
        placeholder: 'Enter your first name', 
        required: true,
        order: 2 
      },
      family_name: { 
        label: 'Last Name', 
        placeholder: 'Enter your last name', 
        required: true,
        order: 3 
      },
      password: { order: 4 },
      confirm_password: { order: 5 }
    }
  };

  const components = {
    Header() {
      return (
        <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--brand-red)' }}>
          <Stethoscope size={56} style={{ marginBottom: '0.75rem' }} />
          <h2 style={{ margin: 0, fontWeight: 800, letterSpacing: '-0.025em', color: 'var(--primary)' }}>dAIgnostics Studio</h2>
        </div>
      );
    },
    Footer() {
      return (
        <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--brand-red)', fontSize: '0.75rem' }}>
          &copy; 2026 dAIgnostics Studio | Daignostics d.o.o
        </div>
      );
    },
  };

  // Embedded in the VetDB popup: auto-login, no Authenticator UI.
  if (IN_IFRAME) return <EmbeddedApp />;

  return (
    <div className="auth-wrapper">
      <Authenticator hideSignUp components={components} formFields={formFields}>
        {({ signOut, user }) => (
          <GeneratorContent signOut={signOut} user={user} />
        )}
      </Authenticator>
    </div>
  );
}

// Auto-signs-in the dedicated embed account (or reuses an existing session),
// then renders the generator with no visible login. Used only inside the iframe.
function EmbeddedApp() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        try {
          await getCurrentUser();
        } catch {
          await signIn({ username: EMBED_EMAIL, password: EMBED_PASSWORD });
        }
        if (alive) setReady(true);
      } catch (e) {
        if (alive) setError(e?.message || String(e));
      }
    })();
    return () => { alive = false; };
  }, []);
  const box = { padding: '2rem', fontFamily: 'system-ui, sans-serif', color: '#475569', textAlign: 'center' };
  if (error) return <div style={box}>Prijava nije uspjela: {error}</div>;
  if (!ready) return <div style={box}>Učitavanje…</div>;
  return <GeneratorContent signOut={() => {}} user={{ signInDetails: { loginId: EMBED_EMAIL } }} />;
}
