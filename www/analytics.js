/**
 * analytics.js — First-party analytics for House Helper
 *
 * GRACEFUL DEGRADATION GUARANTEE:
 * - If analytics tables don't exist → analytics silently disabled, app works normally
 * - If Supabase is unreachable      → events queued in localStorage, flushed later
 * - If any analytics call throws    → error is caught, never propagates to app
 * - App startup is NEVER blocked by analytics
 */

const Analytics = (() => {
  const QUEUE_KEY      = 'hh_analytics_queue';
  const SESS_KEY       = 'hh_session';
  const MAX_QUEUE      = 200;
  const FLUSH_INTERVAL = 30_000;

  let _sb            = null;
  let _userId        = null;
  let _sessionId     = null;
  let _sessionStart  = Date.now();
  let _lastActive    = Date.now();
  let _flushTimer    = null;
  let _tablesExist   = false;  // stays false until confirmed by probe
  let _profilesExist = false;
  let _enabled       = true;   // set false if analytics are permanently unavailable

  // ── SESSION ──────────────────────────────────────────────
  function _newSession() {
    try {
      _sessionId   = (crypto.randomUUID?.()) || (Date.now().toString(36) + Math.random().toString(36).slice(2));
      _sessionStart = Date.now();
      _lastActive   = Date.now();
      sessionStorage.setItem(SESS_KEY, JSON.stringify({ id: _sessionId, start: _sessionStart }));
    } catch(e) {}
    return _sessionId;
  }

  function _getOrCreateSession() {
    try {
      const saved  = JSON.parse(sessionStorage.getItem(SESS_KEY) || 'null');
      const tenMin = 10 * 60 * 1000;
      if (!saved || (Date.now() - (saved.lastActive || saved.start)) > tenMin) return _newSession();
      _sessionId    = saved.id;
      _sessionStart = saved.start;
      _lastActive   = saved.lastActive || saved.start;
    } catch { _newSession(); }
  }

  function _touchSession() {
    try {
      _lastActive = Date.now();
      const saved = JSON.parse(sessionStorage.getItem(SESS_KEY) || '{}');
      sessionStorage.setItem(SESS_KEY, JSON.stringify({ ...saved, lastActive: _lastActive }));
    } catch {}
  }

  // ── QUEUE ────────────────────────────────────────────────
  function _readQueue()  { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
  function _writeQueue(q){ try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))); } catch {} }

  function _enqueue(event) {
    try {
      const q = _readQueue();
      q.push(event);
      _writeQueue(q);
      if (q.length >= MAX_QUEUE) _flush();
    } catch {}
  }

  // ── TABLE PROBE ──────────────────────────────────────────
  // Checks once whether the analytics tables actually exist.
  // Never throws. Returns true/false.
  async function _probeTable(tableName) {
    if (!_sb) return false;
    try {
      const { error } = await _sb.from(tableName).select('event_name').limit(1);
      // 404 / PGRST116 = table not found; anything else = table exists (may be empty)
      if (error) {
        const code = error.code || '';
        const msg  = (error.message || '').toLowerCase();
        if (code === '42P01' || msg.includes('does not exist') || msg.includes('not found') || error.status === 404) {
          return false;
        }
        // Other errors (RLS, network) — assume table exists but we can't read it
        return true;
      }
      return true;
    } catch { return false; }
  }

  // ── FLUSH ────────────────────────────────────────────────
  async function _flush() {
    // Don't attempt flush if tables don't exist — avoids console spam
    if (!_sb || !_tablesExist) return;
    const q = _readQueue();
    if (!q.length) return;
    _writeQueue([]); // optimistic clear
    try {
      const { error } = await _sb.from('analytics_events').insert(q);
      if (error) {
        // Table vanished or RLS blocked — re-queue but stop trying if it's a 404
        const is404 = (error.code === '42P01') || ((error.message||'').includes('not found')) || error.status === 404;
        if (is404) {
          _tablesExist = false; // disable further flushes
          _writeQueue([]); // drop queue rather than infinite retry
          console.warn('[Analytics] analytics_events table not found — analytics disabled');
        } else {
          _writeQueue([...q, ..._readQueue()]); // re-queue for retry
        }
      }
    } catch(e) {
      // Network error — put events back for retry later
      _writeQueue([...q, ..._readQueue()]);
    }
  }

  // ── CORE TRACK ───────────────────────────────────────────
  function track(eventName, properties = {}) {
    if (!_enabled) return;
    try {
      _touchSession();
      const event = {
        event_name:        eventName,
        user_id:           _userId || null,
        session_id:        _sessionId,
        properties:        JSON.stringify(properties),
        platform:          (window.IS_NATIVE ? (window.IS_ANDROID ? 'android' : 'native') : 'web'),
        created_at:        new Date().toISOString(),
        session_duration_s: Math.round((Date.now() - (_sessionStart || Date.now())) / 1000),
      };
      _enqueue(event);

      // Also update customer profile for key events (best-effort, never throws)
      if (_userId && _sb && _profilesExist &&
          ['page_view','service_viewed','booking_completed','search'].includes(eventName)) {
        _updateUserProfile(eventName, properties).catch(() => {});
      }

      if (localStorage.getItem('hh_debug_analytics') === '1') {
        console.log(`[Analytics] ${eventName}`, properties);
      }
    } catch(e) {
      // Analytics must never throw into the app
    }
  }

  // ── PROFILE UPDATE ───────────────────────────────────────
  async function _updateUserProfile(eventName, props) {
    if (!_sb || !_userId || !_profilesExist) return;
    try {
      const now     = new Date().toISOString();
      const updates = { last_active: now };
      if (eventName === 'service_viewed' && props.service_id) {
        const { data: p } = await _sb.from('customer_profiles')
          .select('recently_viewed').eq('user_id', _userId).single()
          .catch(() => ({ data: null }));
        const recent  = p?.recently_viewed || [];
        const updated = [props.service_id, ...recent.filter(id => id !== props.service_id)].slice(0, 20);
        updates.recently_viewed = updated;
      }
      await _sb.from('customer_profiles')
        .upsert({ user_id: _userId, ...updates }, { onConflict: 'user_id' })
        .catch(() => {});
    } catch {}
  }

  // ── LEAD SCORING ─────────────────────────────────────────
  function _computeLeadScore(events) {
    let score = 0;
    const types = events.map(e => e.event_name);
    if (types.includes('booking_completed')) return { score: 0, label: 'Customer', color: '#16A34A' };
    if (types.includes('booking_started'))   score += 40;
    if (types.filter(t => t === 'service_viewed').length >= 3) score += 25;
    if (types.includes('whatsapp_click'))    score += 20;
    if (types.includes('book_now_click'))    score += 15;
    if (types.filter(t => t === 'search').length >= 2) score += 10;
    if (types.includes('banner_click'))      score += 5;
    if (types.includes('category_viewed'))   score += 5;
    const lastEvent   = events[events.length - 1];
    const hoursSince  = lastEvent ? (Date.now() - new Date(lastEvent.created_at).getTime()) / 3_600_000 : 999;
    if (hoursSince < 1)    score += 20;
    else if (hoursSince < 24)  score += 10;
    else if (hoursSince < 72)  score += 5;
    if (score >= 60) return { score, label: 'Hot Lead',  color: '#EF4444' };
    if (score >= 30) return { score, label: 'Warm Lead', color: '#F59E0B' };
    return             { score, label: 'Cold Lead', color: '#94A3B8' };
  }

  // ── PUBLIC API ───────────────────────────────────────────
  return {
    /**
     * Call once on app start.
     * NEVER throws. NEVER blocks startup.
     * Probes for table existence in the background.
     */
    init(supabaseClient, userId) {
      try {
        _sb     = supabaseClient;
        _userId = userId || null;
        _getOrCreateSession();
        // Probe tables in background — does NOT block init() return
        Promise.all([
          _probeTable('analytics_events'),
          _probeTable('customer_profiles'),
        ]).then(([eventsOk, profilesOk]) => {
          _tablesExist   = eventsOk;
          _profilesExist = profilesOk;
          if (eventsOk) {
            // Tables exist — now safe to flush any queued events
            _flush();
            if (_flushTimer) clearInterval(_flushTimer);
            _flushTimer = setInterval(_flush, FLUSH_INTERVAL);
            document.addEventListener('visibilitychange', () => {
              if (document.visibilityState === 'hidden') _flush();
            });
          } else {
            // Tables don't exist — clear queue silently, don't retry
            _writeQueue([]);
            console.info('[Analytics] analytics_events table not found. ' +
              'Run analytics-schema.sql in Supabase to enable analytics. App continues normally.');
          }
        }).catch(() => {
          // Probe itself failed (network down etc.) — analytics disabled for this session
          _writeQueue([]);
        });
      } catch(e) {
        // Absolute safety net — analytics init must never crash the app
        console.warn('[Analytics] init failed silently', e);
      }
    },

    setUser(userId) { try { _userId = userId; track('session_start', { user_id: userId }); } catch {} },
    clearUser()     { try { _userId = null; } catch {} },

    // Predefined events — all wrapped in try/catch, all silent on failure
    appOpened()                    { try { track('app_opened'); } catch {} },
    login(method)                  { try { track('login', { method }); } catch {} },
    logout()                       { try { track('logout'); } catch {} },
    register()                     { try { track('register'); } catch {} },
    pageView(screen, prev)         { try { track('page_view', { screen, prev_screen: prev }); } catch {} },
    serviceViewed(id, name, cat)   { try { track('service_viewed', { service_id: id, service_name: name, category: cat }); } catch {} },
    categoryViewed(id, name)       { try { track('category_viewed', { category_id: id, category_name: name }); } catch {} },
    search(query, results)         { try { track('search', { query, results_count: results }); } catch {} },
    bannerClick(id, url)           { try { track('banner_click', { banner_id: id, url }); } catch {} },
    bookNowClick(serviceId, name)  { try { track('book_now_click', { service_id: serviceId, service_name: name }); } catch {} },
    bookingStarted(serviceId)      { try { track('booking_started', { service_id: serviceId }); } catch {} },
    bookingCompleted(bookingId, serviceId, amount) { try { track('booking_completed', { booking_id: bookingId, service_id: serviceId, amount }); } catch {} },
    bookingCancelled(bookingId)    { try { track('booking_cancelled', { booking_id: bookingId }); } catch {} },
    whatsappClick(purpose)         { try { track('whatsapp_click', { purpose }); } catch {} },
    phoneClick(purpose)            { try { track('phone_click', { purpose }); } catch {} },
    profileUpdated()               { try { track('profile_updated'); } catch {} },

    // Admin queries — graceful empty returns if tables don't exist
    async getLeads(sb) {
      try {
        if (!sb) return [];
        const { data: events, error } = await sb
          .from('analytics_events')
          .select('user_id, event_name, created_at, session_id, properties')
          .not('user_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(2000);
        if (error || !events) return [];
        const byUser = {};
        events.forEach(e => { if (!byUser[e.user_id]) byUser[e.user_id] = []; byUser[e.user_id].push(e); });
        return Object.entries(byUser).map(([userId, userEvents]) => {
          const lead     = _computeLeadScore(userEvents);
          const lastEvent = userEvents[0];
          const services = [...new Set(userEvents.filter(e => e.event_name === 'service_viewed').map(e => { try { return JSON.parse(e.properties)?.service_name; } catch { return null; } }).filter(Boolean))];
          const searches = userEvents.filter(e => e.event_name === 'search').map(e => { try { return JSON.parse(e.properties)?.query; } catch { return null; } }).filter(Boolean);
          return { user_id: userId, ...lead, last_active: lastEvent?.created_at, event_count: userEvents.length, services_viewed: services, searches, sessions: [...new Set(userEvents.map(e => e.session_id))].length };
        }).filter(u => u.label !== 'Customer').sort((a, b) => b.score - a.score);
      } catch { return []; }
    },

    async getUserTimeline(sb, userId) {
      try {
        if (!sb || !userId) return [];
        const { data } = await sb.from('analytics_events').select('*').eq('user_id', userId).order('created_at', { ascending: true }).limit(500);
        return data || [];
      } catch { return []; }
    },

    async getTopSearches(sb, days = 30) {
      try {
        if (!sb) return [];
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { data } = await sb.from('analytics_events').select('properties').eq('event_name', 'search').gte('created_at', since);
        if (!data) return [];
        const counts = {};
        data.forEach(e => { try { const q = JSON.parse(e.properties)?.query; if (q) counts[q] = (counts[q] || 0) + 1; } catch {} });
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([query, count]) => ({ query, count }));
      } catch { return []; }
    },

    async getTopServices(sb, days = 30) {
      try {
        if (!sb) return [];
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { data } = await sb.from('analytics_events').select('properties').eq('event_name', 'service_viewed').gte('created_at', since);
        if (!data) return [];
        const counts = {};
        data.forEach(e => { try { const n = JSON.parse(e.properties)?.service_name; if (n) counts[n] = (counts[n] || 0) + 1; } catch {} });
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, views]) => ({ name, views }));
      } catch { return []; }
    },

    async getPeakHours(sb, days = 30) {
      try {
        if (!sb) return Array(24).fill(0);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { data } = await sb.from('analytics_events').select('created_at').gte('created_at', since);
        if (!data) return Array(24).fill(0);
        const hours = Array(24).fill(0);
        data.forEach(e => { try { hours[new Date(e.created_at).getHours()]++; } catch {} });
        return hours;
      } catch { return Array(24).fill(0); }
    },

    computeLeadScore: _computeLeadScore,
    isEnabled() { return _enabled && _tablesExist; },
    flush: _flush,
  };
})();

window.Analytics = Analytics;
