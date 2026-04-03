#!/usr/bin/env node
// ── Chronicle Build Script ────────────────────────────────────────────────────
// Rebuilds EMBEDDED_DATA in admin/log-viewer.html and player/index.html
// from data/magers-campaign.json.
//
// Usage:
//   node scripts/build.js
//
// Run this after any change to data/magers-campaign.json.

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'magers-campaign.json');
const TARGETS   = [
  path.join(ROOT, 'admin', 'log-viewer.html'),
  path.join(ROOT, 'player', 'index.html'),
];

// ── Load campaign data ────────────────────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// ── JS serialisation helpers ─────────────────────────────────────────────────
function jsStr(s) {
  if (s == null) return 'null';
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '') + "'";
}
function jsList(arr) {
  if (!arr || !arr.length) return '[]';
  return '[' + arr.map(item => {
    if (typeof item === 'string') return jsStr(item);
    if (typeof item === 'object' && item !== null) return jsObj(item);
    if (typeof item === 'boolean') return String(item);
    if (item == null) return 'null';
    return String(item);
  }).join(',') + ']';
}
function jsObj(obj) {
  if (obj == null) return 'null';
  return '{' + Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'boolean')              return `${k}:${v}`;
    if (typeof v === 'number')               return `${k}:${v}`;
    if (v == null)                           return `${k}:null`;
    if (Array.isArray(v))                    return `${k}:${jsList(v)}`;
    if (typeof v === 'object')               return `${k}:${jsObj(v)}`;
    return `${k}:${jsStr(String(v))}`;
  }).join(',') + '}';
}

// ── Build normalised sections (mirrors normaliseCampaignJson in the viewer) ──
const sessions = (raw.session_logs || []).map(s => ({
  id: s.session_id, title: s.title, date: s.session_date,
  summary: s.summary || '', narrative_vibe: s.narrative_vibe || '',
  key_moments: s.key_moments || [], mechanical_notes: s.mechanical_notes || [],
}));

const party = (raw.party || []).map(p => ({
  id: p.id, name: p.name, nickname: p.nickname || '',
  player: p.player || '', cls: p.class || '',
  level: p.current_level || 1, notes: p.notes || '',
  milestones: p.milestones || [],
}));

const npcs = (raw.npc_directory || []).map(n => ({
  id: n.id, name: n.name,
  disposition: n.disposition || '',
  notes: n.notes || n.description_as_observed || '',
}));

const locations = (raw.locations || []).map(l => {
  const out = { id: l.id, name: l.name, visibility: l.visibility || '', description: l.description || '' };
  if (l.parent_location) out.parent_location = l.parent_location;
  return out;
});

const quests = (raw.quest_ledger || []).map(q => ({
  id: q.id, title: q.title, status: q.status || '',
  priority: q.priority || '', category: q.category || '',
  motivation: q.narrative_motivation || '',
  objectives: (q.objectives || []).map(o => ({
    id: o.id || '', desc: o.description || '', done: !!o.is_completed,
  })),
  progress: (q.progress_log || []).map(p => ({ s: p.session_id, e: p.entry })),
  origin: q.origin_session || '',
}));

const items = (raw.inventory_and_loot || []).map(i => ({
  id: i.id, name: i.name, type: i.type || '',
  session: i.session_found || i.origin_session || '',
  holder: i.current_holder_id || '',
  notes: ((i.notes || '') + (i.description ? ' ' + i.description : '')).trim(),
  quest: !!i.is_quest_item,
}));

const combats = (raw.combat_encounters || []).map(cbt => {
  const rounds = (cbt.rounds || []).map(r => {
    const slots = (r.slots || []).map(sl => {
      const s = { s: sl.s, a: sl.a || '', act: sl.act || '', res: sl.res || '' };
      if (sl.val != null) s.val = String(sl.val);
      if (sl.notes)       s.notes = sl.notes;
      return s;
    });
    const enemy = (r.enemy || []).map(en => {
      const e = { desc: en.desc || '' };
      if (en.impact) e.impact = en.impact;
      return e;
    });
    const rd = { n: r.n, sid: r.sid || '', slots, enemy };
    if (r.summary) rd.summary = r.summary;
    return rd;
  });
  const out = {
    id: cbt.id, name: cbt.name,
    location: cbt.location_id || cbt.location || '',
    sessions: cbt.sessions || [],
    outcome: cbt.outcome || '',
    totalRounds: cbt.totalRounds || 0,
    narrativeContext: cbt.narrativeContext || '',
    rounds,
  };
  if (cbt.notes)     out.notes     = cbt.notes;
  if (cbt.finale)    out.finale    = cbt.finale;
  if (cbt.aftermath) out.aftermath = cbt.aftermath;
  return out;
});

const lore     = (raw.world_lore   || []).map(l => ({ id: l.id, title: l.title || '', content: l.content || '', reliability: l.reliability || '' }));
const bestiary = (raw.bestiary     || []).map(b => {
  const out = { id: b.id, name: b.name, traits: b.traits || [], reliability: b.reliability || '' };
  if (b.first_encountered)  out.first_encountered  = b.first_encountered;
  if (b.combat_appearances) out.combat_appearances = b.combat_appearances;
  return out;
});
const moments  = (raw.character_moments || []).map(m => ({
  character_ids: m.character_ids || [], type: m.type || '',
  description: m.description || '',
  parent_event_id: m.parent_event_id || '',
  origin_session: m.origin_session || '',
}));

const meta = raw.meta || {};

// ── Serialise to JS ──────────────────────────────────────────────────────────
function buildEmbeddedData() {
  const lines = ['const EMBEDDED_DATA = {'];
  lines.push(`  meta:{campaign_name:${jsStr(meta.campaign_name||'Magers Campaign')},system:${jsStr(meta.system||'D&D 5e')},dm:${jsStr(meta.dm||'John Magers')},session_count:${sessions.length}},`);

  lines.push('  sessions:[');
  sessions.forEach(s => {
    const km = jsList(s.key_moments);
    const mn = '[' + (s.mechanical_notes||[]).filter(x=>x&&typeof x==='object').map(x=>`{type:${jsStr(x.type||'')},pc_id:${jsStr(x.pc_id||'')},note:${jsStr(x.note||'')}}`).join(',') + ']';
    lines.push(`    {id:${jsStr(s.id)},title:${jsStr(s.title)},date:${jsStr(s.date)},summary:${jsStr(s.summary)},narrative_vibe:${jsStr(s.narrative_vibe)},key_moments:${km},mechanical_notes:${mn}},`);
  });
  lines.push('  ],');

  lines.push('  party:[');
  party.forEach(p => {
    const ms = (p.milestones||[]).filter(m=>m&&typeof m==='object').map(m=>`{session_id:${jsStr(m.session_id||'')},event:${jsStr(m.event||'')},note:${jsStr(m.note||'')}}`).join(',');
    lines.push(`    {id:${jsStr(p.id)},name:${jsStr(p.name)},nickname:${jsStr(p.nickname)},cls:${jsStr(p.cls)},player:${jsStr(p.player)},level:${p.level},notes:${jsStr(p.notes)},milestones:[${ms}]},`);
  });
  lines.push('  ],');

  lines.push('  npcs:[');
  npcs.forEach(n => lines.push(`    {id:${jsStr(n.id)},name:${jsStr(n.name)},disposition:${jsStr(n.disposition)},notes:${jsStr(n.notes)}},`));
  lines.push('  ],');

  lines.push('  locations:[');
  locations.forEach(l => {
    const extra = l.parent_location ? `,parent_location:${jsStr(l.parent_location)}` : '';
    lines.push(`    {id:${jsStr(l.id)},name:${jsStr(l.name)},visibility:${jsStr(l.visibility)},description:${jsStr(l.description)}${extra}},`);
  });
  lines.push('  ],');

  lines.push('  quests:[');
  quests.forEach(q => {
    const objs = q.objectives.map(o=>`{id:${jsStr(o.id)},desc:${jsStr(o.desc)},done:${o.done}}`).join(',');
    const prog = q.progress.map(p=>`{s:${jsStr(p.s)},e:${jsStr(p.e)}}`).join(',');
    lines.push(`    {id:${jsStr(q.id)},title:${jsStr(q.title)},status:${jsStr(q.status)},priority:${jsStr(q.priority)},category:${jsStr(q.category)},motivation:${jsStr(q.motivation)},objectives:[${objs}],progress:[${prog}],origin:${jsStr(q.origin)}},`);
  });
  lines.push('  ],');

  lines.push('  items:[');
  items.forEach(i => lines.push(`    {id:${jsStr(i.id)},name:${jsStr(i.name)},type:${jsStr(i.type)},session:${jsStr(i.session)},holder:${jsStr(i.holder)},notes:${jsStr(i.notes)},quest:${i.quest}},`));
  lines.push('  ],');

  lines.push('  combats:[');
  combats.forEach(cbt => {
    const rounds = cbt.rounds.map(r => {
      const slots = r.slots.map(sl => {
        let s = `s:${sl.s},a:${jsStr(sl.a)},act:${jsStr(sl.act)},res:${jsStr(sl.res)}`;
        if (sl.val != null) s += `,val:${jsStr(sl.val)}`;
        if (sl.notes)       s += `,notes:${jsStr(sl.notes)}`;
        return '{' + s + '}';
      }).join(',');
      const enemy = r.enemy.map(en => {
        let e = `desc:${jsStr(en.desc)}`;
        if (en.impact) e += `,impact:${jsStr(en.impact)}`;
        return '{' + e + '}';
      }).join(',');
      let rd = `n:${r.n},sid:${jsStr(r.sid)},slots:[${slots}],enemy:[${enemy}]`;
      if (r.summary) rd += `,summary:${jsStr(r.summary)}`;
      return '{' + rd + '}';
    }).join(',');
    let cp = `id:${jsStr(cbt.id)},name:${jsStr(cbt.name)},location:${jsStr(cbt.location)},sessions:${jsList(cbt.sessions)},outcome:${jsStr(cbt.outcome)},totalRounds:${cbt.totalRounds},narrativeContext:${jsStr(cbt.narrativeContext)}`;
    if (cbt.notes)     cp += `,notes:${jsStr(cbt.notes)}`;
    if (cbt.finale)    cp += `,finale:${jsStr(cbt.finale)}`;
    if (cbt.aftermath) cp += `,aftermath:${jsStr(cbt.aftermath)}`;
    cp += `,rounds:[${rounds}]`;
    lines.push('    {' + cp + '},');
  });
  lines.push('  ],');

  lines.push('  lore:[');
  lore.forEach(l => lines.push(`    {id:${jsStr(l.id)},title:${jsStr(l.title)},content:${jsStr(l.content)},reliability:${jsStr(l.reliability)}},`));
  lines.push('  ],');

  lines.push('  bestiary:[');
  bestiary.forEach(b => {
    let bp = `id:${jsStr(b.id)},name:${jsStr(b.name)},traits:${jsList(b.traits)},reliability:${jsStr(b.reliability)}`;
    if (b.first_encountered)  bp += `,first_encountered:${jsStr(b.first_encountered)}`;
    if (b.combat_appearances) bp += `,combat_appearances:${jsList(b.combat_appearances)}`;
    lines.push('    {' + bp + '},');
  });
  lines.push('  ],');

  lines.push('  moments:[');
  moments.forEach(m => lines.push(`    {character_ids:${jsList(m.character_ids)},type:${jsStr(m.type)},description:${jsStr(m.description)},parent_event_id:${jsStr(m.parent_event_id)},origin_session:${jsStr(m.origin_session)}},`));
  lines.push('  ],');

  lines.push('}; // end EMBEDDED_DATA');
  return lines.join('\n');
}

// ── Inject into target HTML files ────────────────────────────────────────────
const newBlock = buildEmbeddedData();
let updated = 0;

TARGETS.forEach(filePath => {
  if (!fs.existsSync(filePath)) {
    console.warn(`  SKIP (not found): ${filePath}`);
    return;
  }
  let html = fs.readFileSync(filePath, 'utf8');

  const START_MARKER = 'const EMBEDDED_DATA = {';
  const END_MARKER   = '}; // end EMBEDDED_DATA';

  const startIdx = html.indexOf(START_MARKER);
  const endIdx   = html.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.warn(`  SKIP (markers not found): ${path.basename(filePath)}`);
    return;
  }

  html = html.slice(0, startIdx) + newBlock + html.slice(endIdx + END_MARKER.length);
  fs.writeFileSync(filePath, html, 'utf8');

  const locCount = (html.match(/id:'loc_\d+'/g) || []).length;
  const cbtCount = (html.match(/id:'cbt_\d+'/g) || []).length;
  const monCount = (html.match(/id:'mon_\d+'/g) || []).length;
  console.log(`  ✓ ${path.basename(filePath)} (locs:${locCount} cbts:${cbtCount} bestiary:${monCount})`);
  updated++;
});

// Also update embeddedDataDate in config.js if present
const configPath = path.join(path.dirname(TARGETS[0]), '..', 'shared', 'config.js');
if (fs.existsSync(configPath)) {
  const today = new Date().toISOString().slice(0, 10);
  let cfg = fs.readFileSync(configPath, 'utf8');
  cfg = cfg.replace(/embeddedDataDate:\s*'[^']+'/, `embeddedDataDate: '${today}'`);
  fs.writeFileSync(configPath, cfg, 'utf8');
  console.log(`  ✓ shared/config.js embeddedDataDate → ${today}`);
}

console.log(`\nDone. ${updated} file(s) updated.`);
