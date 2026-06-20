const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// API credentials — set these in Render environment variables
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID     || 'rzp_live_E0g8FoSt8t63NJ';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'pziga30pgfZnciQL67iq2IAo';
const RAZORPAY_AUTH       = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');

const WISE_BASE        = 'https://api.wiseapp.live';
const WISE_INSTITUTE_ID = process.env.WISE_INSTITUTE_ID || '69c40768b8ae27f94c10e875';
const WISE_API_KEY     = process.env.WISE_API_KEY       || 'f69d87a337edbf95a9011d1c4be5fd44';
const WISE_USER_ID     = process.env.WISE_USER_ID       || '69c4076859c459d1a12c63ac';
// Basic auth = base64(WISE_USER_ID:WISE_API_KEY) — confirmed from live API credentials
const WISE_AUTH        = process.env.WISE_AUTH_BASIC
  || 'Basic ' + Buffer.from(`${WISE_USER_ID}:${WISE_API_KEY}`).toString('base64');

const INST = WISE_INSTITUTE_ID; // shorthand used throughout

const WISE_HEADERS = {
  'user-agent':          'VendorIntegrations/brightside-english',
  'x-api-key':           WISE_API_KEY,
  'x-wise-namespace':    'brightside-english',
  'x-wise-institute-id': INST,
  'Authorization':       WISE_AUTH,
};

app.use(express.static(path.join(__dirname, 'public')));

function todayRange() {
  const s = new Date(); s.setHours(0, 0, 0, 0);
  return { from: Math.floor(s / 1000), to: Math.floor(s / 1000) + 86400 };
}

async function wiseGet(urlPath) {
  try {
    const r = await axios.get(`${WISE_BASE}${urlPath}`, { headers: WISE_HEADERS });
    return { ok: true, raw: r.data };
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.message, raw: null };
  }
}

// Run async tasks in parallel batches of `size`
async function batchAll(tasks, size = 10) {
  const results = [];
  for (let i = 0; i < tasks.length; i += size) {
    const chunk = await Promise.all(tasks.slice(i, i + size).map(fn => fn()));
    results.push(...chunk);
  }
  return results;
}

async function getTeacherAvailability(teachers) {
  const now = new Date();
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0);
  const weekEnd   = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7); weekEnd.setHours(23, 59, 59, 999);
  const startTime = weekStart.toISOString();
  const endTime   = weekEnd.toISOString();

  const tasks = teachers.map(t => async () => {
    // teachers.items are already flattened: { name, email, userId (string id), ... }
    const userId = t.userId;
    const name   = t.name || '—';
    if (!userId) return { name, timezone: null, slots: [], sessionCount: 0, error: 'no userId' };

    const res = await wiseGet(
      `/institutes/${INST}/teachers/${userId}/availability?startTime=${startTime}&endTime=${endTime}`
    );

    if (!res.ok) return { name, timezone: null, slots: [], sessionCount: 0, error: res.error };

    const d = res.raw?.data ?? {};
    const slots        = d.workingHours?.slots ?? [];
    const timezone     = d.workingHours?.timezone ?? d.timezone ?? null;
    const sessionCount = Array.isArray(d.sessions) ? d.sessions.length : 0;
    return { name, timezone, slots, sessionCount, error: null };
  });

  return batchAll(tasks, 10);
}

async function getWiseData() {
  // Fetch all core data in parallel (page_size=100 for table display; counts come from response fields)
  const [stuRes, tchRes, sesFutureRes, sesPastRes, clsRes, txnRes] = await Promise.all([
    wiseGet(`/institutes/${INST}/students?status=ACCEPTED&paginateBy=COUNT&page_size=100&page_number=1`),
    wiseGet(`/institutes/${INST}/teachers?paginateBy=COUNT&page_size=100&page_number=1`),
    // status=FUTURE → upcoming sessions (totalRecords = true upcoming count)
    wiseGet(`/institutes/${INST}/sessions?paginateBy=COUNT&status=FUTURE&page_size=100&page_number=1`),
    // status=PAST → past sessions for the Past tab
    wiseGet(`/institutes/${INST}/sessions?paginateBy=COUNT&status=PAST&page_size=100&page_number=1`),
    wiseGet(`/institutes/${INST}/classes?paginateBy=COUNT&page_size=50&page_number=1`),
    wiseGet(`/institutes/${INST}/transactions?paginateBy=COUNT&page_number=1&page_size=100`),
  ]);

  // Confirmed count field names per endpoint (from live API inspection):
  //   sessions  → data.totalRecords
  //   classes   → data.classesCount
  //   students  → array.length (API returns all; no count field)
  //   teachers  → array.length (API returns all; no count field)
  function parse(res, arrayKey, countKey) {
    if (!res.ok) return { count: null, items: [], error: res.error };
    const inner = res.raw?.data ?? {};
    const arr   = Array.isArray(inner[arrayKey]) ? inner[arrayKey]
                : Array.isArray(inner) ? inner : [];
    const count = countKey
      ? (inner[countKey] ?? arr.length)
      : (inner.totalRecords ?? inner.totalCount ?? inner.total ?? inner.count ?? arr.length);
    return { count, items: arr, error: null };
  }

  const stuRaw  = parse(stuRes, 'students');                          // count = arr.length
  const tchRaw  = parse(tchRes, 'teachers');                          // count = arr.length
  const courses = parse(clsRes, 'classes', 'classesCount');           // count = data.classesCount
  const transactions = parse(txnRes, 'transactions');

  // Sessions: FUTURE (upcoming) + PAST fetched separately for accurate counts
  const sesFuture = parse(sesFutureRes, 'sessions', 'totalRecords'); // upcomingCount = totalRecords
  const sesPast   = parse(sesPastRes,   'sessions', 'totalRecords');

  function mapSession(s) {
    const instructor = s.userId?.name
      || s.participants?.find(p => p.isTeacher)?.name
      || '—';
    const students = (s.participants || [])
      .filter(p => !p.isTeacher && p.name)
      .map(p => p.name);
    const classTypeLbl = { ONE_TO_ONE: '1:1', GROUP: 'Group', WEBINAR: 'Webinar' }[s.classId?.classType] || s.classId?.classType || '';
    return {
      _id:                s._id,
      course:             s.classId?.name    || s.title || 'Session',
      subject:            s.classId?.subject || '',
      classType:          classTypeLbl,
      instructor,
      students,
      scheduledStartTime: s.scheduledStartTime || s.start_time || null,
      scheduledEndTime:   s.scheduledEndTime   || s.end_time   || null,
      meetingStatus:      s.meetingStatus      || '—',
    };
  }

  const sessions = {
    totalCount:    (sesFuture.count || 0) + (sesPast.count || 0),
    upcomingCount: sesFuture.count || 0,
    pastCount:     sesPast.count   || 0,
    upcomingItems: sesFuture.items.map(mapSession),
    pastItems:     sesPast.items.map(mapSession),
    error:         sesFuture.error || sesPast.error || null,
  };

  // Teachers — userId is nested object: { _id, name, email, phoneNumber }
  const teachers = {
    ...tchRaw,
    items: tchRaw.items.map(t => ({
      name:     t.userId?.name      || '—',
      email:    t.userId?.email     || '—',
      contact:  t.userId?.phoneNumber || '—',
      status:   t.status            || '—',
      joinedOn: t.joinedOn          || null,
      userId:   t.userId?._id,
    })),
  };

  // Students — same userId nesting
  const students = {
    ...stuRaw,
    items: stuRaw.items.map(s => ({
      name:     s.userId?.name        || '—',
      email:    s.userId?.email       || '—',
      contact:  s.userId?.phoneNumber || '—',
      status:   s.status              || '—',
    })),
  };

  // Teacher availability — runs after teachers are loaded
  const availability = teachers.error
    ? []
    : await getTeacherAvailability(teachers.items);

  return { students, teachers, sessions, courses, transactions, availability };
}

async function getRazorpayLinks(from, to) {
  try {
    // Razorpay payment_links doesn't support from/to server-side, so fetch latest 100 and filter client-side
    const r = await axios.get('https://api.razorpay.com/v1/payment_links', {
      headers: { Authorization: `Basic ${RAZORPAY_AUTH}` }, params: { count: 100 }
    });
    const all      = r.data.items || [];
    const filtered = all.filter(l => l.created_at >= from && l.created_at < to);
    const paid     = filtered.filter(l => l.status === 'paid');
    return {
      total:     filtered.length,
      paid:      paid.length,
      pending:   filtered.filter(l => l.status === 'created').length,
      collected: paid.reduce((s, l) => s + (l.amount_paid || 0), 0) / 100,
      links: filtered.slice(0, 100).map(l => ({
        id:              l.id,
        description:     l.description || '—',
        amount:          (l.amount || 0) / 100,
        status:          l.status,
        createdAt:       l.created_at,
        customerName:    l.customer?.name    || '—',
        customerContact: l.customer?.contact || '—',
      }))
    };
  } catch (e) {
    return { error: e.response?.data?.error?.description || e.message, total:0, paid:0, pending:0, collected:0, links:[] };
  }
}

async function getRazorpayPayments() {
  try {
    const { from, to } = todayRange();
    const r = await axios.get('https://api.razorpay.com/v1/payments', {
      headers: { Authorization: `Basic ${RAZORPAY_AUTH}` }, params: { count: 20, from, to }
    });
    const items = r.data.items || [];
    return {
      payments: items.map(p => ({
        id: p.id, amount: p.amount / 100, currency: p.currency,
        status: p.status, method: p.method,
        email: p.email || '—', contact: p.contact || '—', createdAt: p.created_at
      }))
    };
  } catch (e) {
    return { error: e.response?.data?.error?.description || e.message, payments:[] };
  }
}

function rangeFor(preset) {
  const now = Math.floor(Date.now() / 1000);
  const sod = (() => { const d = new Date(); d.setHours(0,0,0,0); return Math.floor(d/1000); })();
  if (preset === 'today')   return { from: sod,           to: sod + 86400 };
  if (preset === '7days')   return { from: sod - 6*86400, to: sod + 86400 };
  if (preset === '30days')  return { from: sod - 29*86400,to: sod + 86400 };
  return { from: sod - 6*86400, to: sod + 86400 }; // default: 7 days
}

app.get('/api/links', async (req, res) => {
  const from   = req.query.from   ? parseInt(req.query.from)  : null;
  const to     = req.query.to     ? parseInt(req.query.to)    : null;
  const preset = req.query.preset || '7days';
  const range  = (from && to) ? { from, to } : rangeFor(preset);
  const links  = await getRazorpayLinks(range.from, range.to);
  res.json({ links, from: range.from, to: range.to, timestamp: Date.now() });
});

app.get('/api/all', async (req, res) => {
  const range = rangeFor('7days');
  const [links, payments, wise] = await Promise.all([
    getRazorpayLinks(range.from, range.to), getRazorpayPayments(), getWiseData()
  ]);
  res.json({ razorpay: { links, payments }, wise, timestamp: Date.now() });
});

app.listen(PORT, () => console.log(`BSE Dashboard → http://localhost:${PORT}`));
