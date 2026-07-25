require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const ccsj = require('countrycitystatejson');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');
const { hashPassword, verifyPassword, encrypt, decrypt, requireAuth } = require('./auth');

const STATE_ABBR_TO_FULL = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',
  MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia'
};
const STATE_FULL_TO_ABBR = Object.fromEntries(
  Object.entries(STATE_ABBR_TO_FULL).map(([abbr, full]) => [full.toUpperCase(), abbr])
);

function normalizeState(s) {
  if (!s) return '';
  const upper = s.trim().toUpperCase();
  if (STATE_ABBR_TO_FULL[upper]) return upper;
  return STATE_FULL_TO_ABBR[upper] || upper;
}

const app = express();
const PORT = process.env.PORT || 3056;

// Fail-fast on the secrets the auth layer needs
if (!process.env.APP_SECRET || process.env.APP_SECRET.length !== 64) {
  console.error('FATAL: APP_SECRET must be a 64-char hex string (32 bytes). See .env.example.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set. See .env.example.');
  process.exit(1);
}

app.set('trust proxy', 1); // behind Nginx
app.use(express.json());

app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 900000 } // clear expired every 15 min
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
  }
}));

// ── Auth pages (public) ───────────────────────────────────────────────────────
// These specific files are reachable without a session; everything else in
// /public is gated below.
const PUBLIC_FILES = new Set(['/login', '/signup']);
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// ── Auth API ──────────────────────────────────────────────────────────────────
app.post('/auth/signup', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'An account with that email already exists' });

  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, hashPassword(password));
  req.session.userId = info.lastInsertRowid;
  res.json({ ok: true });
});

app.post('/auth/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Who am I + do I have a key set? (drives the UI)
app.get('/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, api_key_enc FROM users WHERE id = ?').get(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Not authenticated' }); }
  res.json({ email: user.email, hasKey: !!user.api_key_enc });
});

// Save / update the caller's own Outscraper key
app.post('/auth/api-key', requireAuth, (req, res) => {
  const key = (req.body.apiKey || '').trim();
  if (!key) return res.status(400).json({ error: 'API key required' });
  db.prepare('UPDATE users SET api_key_enc = ? WHERE id = ?').run(encrypt(key), req.session.userId);
  res.json({ ok: true });
});

// Helper: fetch + decrypt the current user's key, or null
function currentUserKey(req) {
  const row = db.prepare('SELECT api_key_enc FROM users WHERE id = ?').get(req.session.userId);
  return row && row.api_key_enc ? decrypt(row.api_key_enc) : null;
}

// ── Gate everything else behind auth ──────────────────────────────────────────
app.use((req, res, next) => {
  if (PUBLIC_FILES.has(req.path)) return next();
  return requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Location endpoints ────────────────────────────────────────────────────────

app.get('/locations/countries', (req, res) => {
  const countries = ccsj.getCountries()
    .map(c => ({ code: c.shortName, name: c.name, emoji: c.emoji || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(countries);
});

app.get('/locations/states', (req, res) => {
  const { country } = req.query;
  if (!country) return res.status(400).json({ error: 'country required' });
  const data = ccsj.getCountryByShort(country);
  if (!data || !data.states) return res.json([]);
  const keys = Object.keys(data.states).filter(k => data.states[k].length > 0).sort((a, b) => a.localeCompare(b));
  if (keys.length <= 1) return res.json([]);
  res.json(keys.map(k => ({ name: k })));
});

app.get('/locations/cities', (req, res) => {
  const { country, state } = req.query;
  if (!country) return res.status(400).json({ error: 'country required' });
  const data = ccsj.getCountryByShort(country);
  if (!data || !data.states) return res.json([]);
  let cities = [];
  if (state && data.states[state]) {
    cities = data.states[state].map(c => c.name);
  } else if (!state) {
    for (const key of Object.keys(data.states)) {
      data.states[key].forEach(c => cities.push(c.name));
    }
  }
  cities = [...new Set(cities)].sort((a, b) => a.localeCompare(b));
  res.json(cities);
});

// ── Categories ────────────────────────────────────────────────────────────────

const CATEGORY_QUERIES = {
  'Retail': [
    'retail store', 'boutique', 'clothing store', 'gift shop', 'furniture store',
    'sporting goods store', 'toy store', 'shoe store', 'jewelry store', 'book store',
    'electronics store', 'hardware store', 'grocery store', 'pharmacy', 'pet store'
  ],
  'Restaurant': [
    'restaurant', 'cafe', 'coffee shop', 'pizza', 'burger', 'mexican restaurant',
    'chinese restaurant', 'sushi', 'bar and grill', 'diner', 'bakery',
    'sandwich shop', 'steakhouse', 'food truck', 'bbq restaurant'
  ],
  'Service': [
    'hair salon', 'barber shop', 'nail salon', 'auto repair shop', 'plumber',
    'electrician', 'HVAC', 'landscaping', 'cleaning service', 'dog groomer',
    'personal trainer', 'massage therapy', 'tax preparer', 'accountant',
    'lawyer law firm', 'dentist', 'chiropractor', 'physical therapy',
    'tutoring', 'pest control', 'moving company'
  ],
  'Real Estate': [
    'real estate agency', 'property management', 'mortgage broker',
    'home inspector', 'real estate appraiser', 'title company'
  ],
  'Church': [
    'church', 'baptist church', 'catholic church', 'methodist church',
    'non-denominational church', 'evangelical church'
  ],
  'Contractor': [
    'general contractor', 'roofing contractor', 'flooring contractor',
    'painting contractor', 'concrete contractor', 'fence company',
    'deck builder', 'remodeling contractor', 'kitchen remodel', 'bathroom remodel'
  ],
  'Auto': [
    'auto repair', 'tire shop', 'oil change', 'body shop', 'car dealership',
    'used car dealer', 'towing company', 'auto detailing', 'transmission repair', 'glass repair'
  ],
  'Health & Wellness': [
    'gym', 'yoga studio', 'pilates studio', 'CrossFit', 'personal trainer',
    'nutritionist', 'acupuncture', 'counseling therapy', 'urgent care clinic', 'optometrist'
  ]
};

// ── Outscraper helpers ────────────────────────────────────────────────────────

async function pollJob(jobId, apiKey, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    const resp = await axios.get(
      `https://api.app.outscraper.com/requests/${jobId}`,
      { headers: { 'X-API-KEY': apiKey } }
    );
    const job = resp.data;
    if (job.status === 'Success') return job.data;
    if (job.status === 'ERROR' || job.status === 'Failed') {
      throw new Error(`Outscraper job failed: ${job.error_message || job.status}`);
    }
  }
  throw new Error('Outscraper job timed out');
}

async function runOutscraperQuery(searchQuery, limit, apiKey) {
  const resp = await axios.get(
    'https://api.app.outscraper.com/maps/search-v3',
    {
      headers: { 'X-API-KEY': apiKey },
      params: {
        query: searchQuery,
        limit: Math.min(limit, 100),
        language: 'en',
        region: 'us',
        // Request all the fields we need for a lead
        fields: 'name,website,phone,full_address,city,state,type,subtypes,place_id,google_id,rating,reviews',
        async: false
      }
    }
  );
  const data = resp.data;
  if (data && data.data) {
    return Array.isArray(data.data[0]) ? data.data[0] : data.data;
  } else if (data && data.id) {
    const polled = await pollJob(data.id, apiKey);
    return Array.isArray(polled[0]) ? polled[0] : polled;
  }
  return [];
}

// Build a Google Maps search URL from place_id or name+address
function buildMapsUrl(r) {
  if (r.place_id) return `https://www.google.com/maps/place/?q=place_id:${r.place_id}`;
  const q = encodeURIComponent(`${r.name} ${r.full_address || ''}`);
  return `https://www.google.com/maps/search/?q=${q}`;
}

// ── Search endpoint ────────────────────────────────────────────────────────────

app.post('/search', requireAuth, async (req, res) => {
  const { city, state, country, categories } = req.body;
  if (!city || !categories || !categories.length) {
    return res.status(400).json({ error: 'city and categories are required' });
  }

  const apiKey = currentUserKey(req);
  if (!apiKey) {
    return res.status(400).json({ error: 'No Outscraper API key on file. Add yours in Settings before searching.' });
  }

  const effectiveCountry = country || 'US';
  const locationParts = [city];
  if (state) locationParts.push(state);
  if (effectiveCountry !== 'US') {
    const countryData = ccsj.getCountryByShort(effectiveCountry);
    if (countryData) locationParts.push(countryData.name);
  }
  const location = locationParts.join(', ');

  const allLeads = [];
  const errors = [];
  const stats = { total_fetched: 0, no_website: 0, had_website: 0 };

  for (const cat of categories) {
    const subQueries = CATEGORY_QUERIES[cat.name] || [cat.name];
    const perQuery = Math.max(20, Math.ceil(cat.limit / subQueries.length));
    const seen = new Set();

    console.log(`\n[${cat.name}] Searching for no-website businesses in ${location}`);

    for (const q of subQueries) {
      const searchQuery = `${q} in ${location}`;
      console.log(`  Querying: "${searchQuery}"`);

      try {
        const raw = await runOutscraperQuery(searchQuery, perQuery, apiKey);
        stats.total_fetched += raw.length;

        for (const r of raw) {
          if (!r || !r.name) continue;

          // State filter
          const resultStateNorm = normalizeState(r.state || r.region || '');
          const searchStateNorm = normalizeState(state);
          if (resultStateNorm && searchStateNorm && resultStateNorm !== searchStateNorm) continue;

          const dedupKey = r.place_id || `${r.name}|${r.full_address || ''}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          const hasWebsite = !!(r.website || r.site || '').trim();

          if (hasWebsite) {
            stats.had_website++;
            continue; // this is the key filter — skip businesses that DO have a website
          }

          stats.no_website++;
          allLeads.push({
            name: r.name,
            phone: r.phone || r.phone_number || '',
            address: r.full_address || `${r.city || city}, ${r.state || state}`,
            city: r.city || r.district || city,
            state: r.state || r.region || state,
            category: cat.name,
            business_type: r.type || (Array.isArray(r.subtypes) ? r.subtypes[0] : r.subtypes) || '',
            rating: r.rating || '',
            reviews: r.reviews || r.reviews_count || '',
            maps_url: buildMapsUrl(r),
            place_id: r.place_id || ''
          });
        }

        console.log(`    → ${raw.length} raw | ${stats.no_website} leads so far`);
      } catch (err) {
        console.error(`  Error for "${searchQuery}": ${err.message}`);
        errors.push({ category: cat.name, query: searchQuery, error: err.message });
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\nDone. Fetched ${stats.total_fetched} total | ${stats.no_website} no website | ${stats.had_website} had website`);
  res.json({ leads: allLeads, errors, stats });
});

// ── CSV download ───────────────────────────────────────────────────────────────

app.post('/download', requireAuth, (req, res) => {
  const { leads, filename } = req.body;
  if (!leads || !leads.length) {
    return res.status(400).json({ error: 'No leads to download' });
  }

  const escape = val => {
    const s = (val || '').toString().replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };

  const header = 'name,phone,address,city,state,category,business_type,rating,reviews,maps_url';
  const rows = leads.map(r => [
    escape(r.name), escape(r.phone), escape(r.address),
    escape(r.city), escape(r.state), escape(r.category),
    escape(r.business_type), escape(r.rating), escape(r.reviews),
    escape(r.maps_url)
  ].join(','));

  const csv = [header, ...rows].join('\n');
  const fname = filename || `no-website-leads-${Date.now()}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

// ── Saved leads ────────────────────────────────────────────────────────────────

// Build a stable dedup key for a lead (matches the search-time logic)
function leadDedupKey(l) {
  return l.place_id || `${l.name}|${l.address || ''}`;
}

// Save one or more selected leads for the current user. Idempotent: saving the
// same business twice is ignored (unique index on user_id + dedup_key).
app.post('/leads', requireAuth, (req, res) => {
  const incoming = Array.isArray(req.body.leads) ? req.body.leads : [];
  if (!incoming.length) return res.status(400).json({ error: 'No leads to save' });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO leads
      (user_id, dedup_key, name, phone, address, city, state, category,
       business_type, rating, reviews, maps_url, place_id)
    VALUES
      (@user_id, @dedup_key, @name, @phone, @address, @city, @state, @category,
       @business_type, @rating, @reviews, @maps_url, @place_id)
  `);

  const saveMany = db.transaction((rows) => {
    let saved = 0;
    for (const l of rows) {
      if (!l || !l.name) continue;
      const info = insert.run({
        user_id: req.session.userId,
        dedup_key: leadDedupKey(l),
        name: l.name,
        phone: l.phone || '',
        address: l.address || '',
        city: l.city || '',
        state: l.state || '',
        category: l.category || '',
        business_type: l.business_type || '',
        rating: (l.rating || '').toString(),
        reviews: (l.reviews || '').toString(),
        maps_url: l.maps_url || '',
        place_id: l.place_id || ''
      });
      saved += info.changes;
    }
    return saved;
  });

  const saved = saveMany(incoming);
  const skipped = incoming.length - saved;
  res.json({ ok: true, saved, skipped });
});

// List the current user's saved leads (newest first)
app.get('/leads', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, phone, address, city, state, category,
           business_type, rating, reviews, maps_url, place_id, created_at
    FROM leads
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(req.session.userId);
  res.json({ leads: rows });
});

// Remove one saved lead (scoped to the owner)
app.delete('/leads/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid lead id' });
  const info = db.prepare('DELETE FROM leads WHERE id = ? AND user_id = ?')
    .run(id, req.session.userId);
  if (!info.changes) return res.status(404).json({ error: 'Lead not found' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`No-Website Finder running at http://localhost:${PORT}`);
});
