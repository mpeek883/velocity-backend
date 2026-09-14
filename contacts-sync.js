// Keep Contacts in step with Candidates and Leads.
// Every candidate becomes a Contact of type "Candidate" (with their key
// skills); every lead's recruiter becomes a Contact of type "Company".
// Matching is by the source record id first, then by email, so re-syncing
// updates rather than duplicates.

function skillsToText(skills) {
  if (Array.isArray(skills)) return skills.map((s) => String(s).trim()).filter(Boolean).join(', ');
  if (typeof skills !== 'string' || !skills.trim()) return '';
  return skills.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '').trim()).filter(Boolean).join(', ');
}

async function upsertContact(pool, match, fields) {
  let existing = { rows: [] };
  if (match.candidate_id) existing = await pool.query('SELECT * FROM contacts WHERE candidate_id=$1 LIMIT 1', [String(match.candidate_id)]);
  if (!existing.rows.length && match.lead_id) existing = await pool.query('SELECT * FROM contacts WHERE lead_id=$1 LIMIT 1', [String(match.lead_id)]);
  if (!existing.rows.length && fields.email) existing = await pool.query('SELECT * FROM contacts WHERE LOWER(email)=LOWER($1) LIMIT 1', [fields.email]);

  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (existing.rows.length) {
    const cur = existing.rows[0];
    // Keep existing values when the source has none; refresh type/skills/links.
    const merged = {};
    for (const [k, v] of Object.entries(clean)) merged[k] = (v === '' || v === null) ? cur[k] : v;
    const cols = Object.keys(merged);
    const q = await pool.query(`UPDATE contacts SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1} RETURNING *`, [...cols.map((c) => merged[c]), cur.id]);
    return { contact: q.rows[0], created: false };
  }
  const cols = Object.keys(clean);
  const q = await pool.query(`INSERT INTO contacts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, cols.map((c) => clean[c]));
  return { contact: q.rows[0], created: true };
}

async function syncContactFromCandidate(pool, candidate) {
  if (!candidate || !candidate.name) return null;
  return upsertContact(pool, { candidate_id: candidate.id }, {
    name: candidate.name,
    title: candidate.title || '',
    email: candidate.email || '',
    phone: candidate.phone || '',
    company: candidate.company || '',
    contact_type: 'Candidate',
    skills: skillsToText(candidate.skills),
    candidate_id: String(candidate.id),
    source: candidate.source || 'Candidate record',
    status: 'active',
  });
}

async function syncContactFromLead(pool, lead) {
  if (!lead || !lead.name) return null;
  return upsertContact(pool, { lead_id: lead.id }, {
    name: lead.name,
    title: lead.title || '',
    email: lead.email || '',
    phone: lead.phone || '',
    company: lead.company || '',
    contact_type: 'Company',
    lead_id: String(lead.id),
    account_id: lead.account_id ? String(lead.account_id) : undefined,
    source: lead.source || 'Lead record',
    status: 'active',
    notes: [lead.company_address ? `Address: ${lead.company_address}` : '', lead.company_website ? `Web: ${lead.company_website}` : '', lead.linkedin ? `LinkedIn: ${lead.linkedin}` : ''].filter(Boolean).join('\n') || undefined,
  });
}

/** One-time catch-up for records that predate the sync. */
async function backfillContacts(pool) {
  const out = { candidates: 0, leads: 0, errors: 0 };
  const cands = await pool.query("SELECT * FROM candidates WHERE id::text NOT IN (SELECT candidate_id FROM contacts WHERE candidate_id IS NOT NULL)");
  for (const c of cands.rows) { try { await syncContactFromCandidate(pool, c); out.candidates += 1; } catch { out.errors += 1; } }
  const leads = await pool.query("SELECT * FROM leads WHERE id::text NOT IN (SELECT lead_id FROM contacts WHERE lead_id IS NOT NULL)");
  for (const l of leads.rows) { try { await syncContactFromLead(pool, l); out.leads += 1; } catch { out.errors += 1; } }
  return out;
}

module.exports = { syncContactFromCandidate, syncContactFromLead, backfillContacts, skillsToText, upsertContact };
