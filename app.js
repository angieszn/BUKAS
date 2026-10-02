/* ============================================================
   Bukas
   Entries are sealed and returned at a time the user does not choose.

   Credentials go in config.js — nowhere else.
   With no credentials set, everything below runs against
   localStorage so the app is fully usable offline.
   ============================================================ */

const DAY = 86400000;
const HOLD_MS = 1100;          // press-and-hold duration to seal
const MIN_DAYS = 14;           // log-uniform floor
const MAX_DAYS = 1826;         // 5 years
const FIRST_ENTRY_FLOOR = 3;   // first entry only
const METER_DAYS = 5;          // never more than one return per 5 days
const PAIR_CHANCE = 0.2;       // about 1 in 5 returns arrive as two
const PROMPT_CHANCE = 0.6;     // raised by half from 40%

/* ---------- the return draw ---------- */

// Log-uniform: a random exponent, not a random number of days.
// Equal weight to every timescale, with a genuine long tail.
function logUniformDays(minDays, maxDays) {
  return minDays * Math.pow(maxDays / minDays, Math.random());
}

function sameMonthDay(a, b) {
  return a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Drawn ONCE, at seal time. Never recalculated, never revisited.
function drawReturnAt(writtenAt, isFirstEntry) {
  const min = isFirstEntry ? FIRST_ENTRY_FLOOR : MIN_DAYS;
  const days = logUniformDays(min, MAX_DAYS);
  let at = new Date(writtenAt.getTime() + days * DAY);
  // Never on the anniversary of the day it was written.
  if (sameMonthDay(at, writtenAt)) at = new Date(at.getTime() + DAY);
  return at;
}

function isAnniversary(writtenAt, when) {
  return sameMonthDay(new Date(writtenAt), when);
}

function structurallyPaired(a, b) {
  const x = new Date(a.written_at), y = new Date(b.written_at);
  if (x.getDay() === y.getDay()) return true;                    // same weekday
  const mins = d => d.getHours() * 60 + d.getMinutes();
  let gap = Math.abs(mins(x) - mins(y));
  if (gap > 720) gap = 1440 - gap;
  return gap <= 75;                                              // similar clock time
}

/* ---------- dates ---------- */

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function plainDate(iso) {
  const d = new Date(iso);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ============================================================
   STORE — one interface, two implementations
   ============================================================ */

// Credentials come from config.js if filled in, otherwise from the Vercel
// function at /api/config (which reads your Vercel environment variables).
// With neither, Bukas runs on this browser's storage.
let cfg = {};
let HAS_SUPABASE = false;

function validConfig(c) {
  return !!(c && c.SUPABASE_URL && c.SUPABASE_ANON_KEY &&
    String(c.SUPABASE_URL).startsWith('http') && !String(c.SUPABASE_ANON_KEY).startsWith('PASTE'));
}

// Keep only https://xxxx.supabase.co — a pasted /rest/v1/ or trailing slash
// otherwise produces "Invalid path specified in request URL".
function cleanConfig(c) {
  let url = String(c.SUPABASE_URL).trim();
  try { url = new URL(url).origin; } catch (e) {}
  return { SUPABASE_URL: url, SUPABASE_ANON_KEY: String(c.SUPABASE_ANON_KEY).trim() };
}

async function loadConfig() {
  if (validConfig(window.BUKAS_CONFIG)) return cleanConfig(window.BUKAS_CONFIG);
  if (location.protocol === 'file:') return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('/api/config', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    const c = await res.json();
    return validConfig(c) ? cleanConfig(c) : null;
  } catch (e) { return null; }
}

class SupabaseStore {
  constructor() {
    this.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }
  async session() {
    const { data } = await this.db.auth.getSession();
    return data.session || null;
  }
  async signUp(email, password) {
    const { data, error } = await this.db.auth.signUp({ email, password });
    if (error) {
      if (/already (registered|exists)/i.test(error.message || '')) { const e = new Error('exists'); e.code = 'EXISTS'; throw e; }
      throw error;
    }
    // With email confirmation on, Supabase answers an existing email with a
    // user that has no identities instead of an error.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      const e = new Error('exists'); e.code = 'EXISTS'; throw e;
    }
    return !!data.session; // false when email confirmation is required
  }
  async signIn(email, password) {
    const { error } = await this.db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return true;
  }
  async signOut() { await this.db.auth.signOut(); }
  get recovering() { return /type=recovery/.test(location.hash); }
  onRecovery(fn) {
    this.db.auth.onAuthStateChange(evt => { if (evt === 'PASSWORD_RECOVERY') fn(); });
  }
  async requestReset(email) {
    const { error } = await this.db.auth.resetPasswordForEmail(email, {
      redirectTo: location.href.split('#')[0]
    });
    if (error) throw error;
    return 'email';
  }
  // Make sure there's a live session before an auth change. A stored session
  // can go stale (long idle, token revoked, storage cleared); refresh it, and
  // if that fails, report it plainly instead of "Auth session missing!".
  async ensureSession() {
    let { data } = await this.db.auth.getSession();
    if (!data.session) {
      const r = await this.db.auth.refreshSession();
      data = { session: r.data && r.data.session };
    }
    if (!data.session) {
      const err = new Error('You\u2019ve been signed out. Sign in again, then change your password.');
      err.code = 'SESSION_EXPIRED';
      throw err;
    }
    return data.session;
  }
  async updatePassword(password, current) {
    await this.ensureSession();
    if (current) {
      // Signing in again makes the session "recent", which Supabase's
      // secure password change setting requires before a password update.
      const { data: u } = await this.db.auth.getUser();
      const email = u && u.user ? u.user.email : '';
      const { error: authErr } = await this.db.auth.signInWithPassword({ email, password: current });
      if (authErr) {
        const err = new Error('That current password isn\u2019t right.');
        err.code = 'BAD_CURRENT';
        throw err;
      }
    }
    const { error } = await this.db.auth.updateUser({ password });
    if (error) {
      if (/session/i.test(error.message || '')) {
        const err = new Error('You\u2019ve been signed out. Sign in again, then change your password.');
        err.code = 'SESSION_EXPIRED';
        throw err;
      }
      throw error;
    }
  }
  async accountInfo() {
    const { data, error } = await this.db.auth.getUser();
    if (error) throw error;
    const u = data.user || {};
    return { email: u.email || '', joined: u.created_at || null, pendingEmail: u.new_email || null };
  }
  async changeEmail(email) {
    const { error } = await this.db.auth.updateUser(
      { email },
      { emailRedirectTo: location.href.split('#')[0] }
    );
    if (error) throw error;
    return 'email';
  }
  async deleteAccount() {
    const { error } = await this.db.rpc('delete_my_account');
    if (error) throw error;
    await this.db.auth.signOut();
  }

  get uid() { return this._uid; }
  async bind(session) { this._uid = session.user.id; }

  async rows(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
  byState(states) {
    return this.rows(this.db.from('entries').select('*')
      .eq('user_id', this._uid).in('state', states).order('written_at', { ascending: true }));
  }
  async eligible(now) {
    return this.rows(this.db.from('entries').select('*')
      .eq('user_id', this._uid).eq('state', 'sealed')
      .lte('return_at', now.toISOString()).order('return_at', { ascending: true }));
  }
  async lastDeliveredAt() {
    const r = await this.rows(this.db.from('entries').select('delivered_at')
      .eq('user_id', this._uid).not('delivered_at', 'is', null)
      .order('delivered_at', { ascending: false }).limit(1));
    return r.length ? new Date(r[0].delivered_at) : null;
  }
  async sealedOrReturnedCount() {
    const { count, error } = await this.db.from('entries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', this._uid).in('state', ['sealed', 'returned']);
    if (error) throw error;
    return count || 0;
  }
  async getDraft() {
    const r = await this.byStateDraft();
    return r[0] || null;
  }
  byStateDraft() {
    return this.rows(this.db.from('entries').select('*')
      .eq('user_id', this._uid).eq('state', 'draft')
      .order('written_at', { ascending: false }).limit(1));
  }
  async saveDraft(id, body, promptText) {
    const patch = { body, prompt_text: promptText || null };
    if (id) {
      await this.rows(this.db.from('entries').update(patch).eq('id', id).select());
      return id;
    }
    const r = await this.rows(this.db.from('entries')
      .insert({ user_id: this._uid, state: 'draft', ...patch }).select());
    return r[0].id;
  }
  async update(id, patch) {
    await this.rows(this.db.from('entries').update(patch).eq('id', id).select());
  }
  async remove(id) {
    await this.rows(this.db.from('entries').delete().eq('id', id).select());
  }
  async all() {
    return this.rows(this.db.from('entries').select('*')
      .eq('user_id', this._uid).order('written_at', { ascending: true }));
  }
}

class LocalStore {
  constructor() {
    this.key = 'bukas.local.v1';
    this.data = JSON.parse(localStorage.getItem(this.key) || 'null') ||
      { users: {}, session: null, entries: [] };
  }
  persist() { localStorage.setItem(this.key, JSON.stringify(this.data)); }
  async session() {
    return this.data.session ? { user: { id: this.data.session } } : null;
  }
  async signUp(email, password) {
    const e = email.toLowerCase();
    if (this.data.users[e]) { const x = new Error('exists'); x.code = 'EXISTS'; throw x; }
    this.data.users[e] = { id: 'u_' + Math.random().toString(36).slice(2), password, created_at: new Date().toISOString() };
    this.data.session = this.data.users[e].id;
    this.persist();
    return true;
  }
  async signIn(email, password) {
    const u = this.data.users[email.toLowerCase()];
    if (!u || u.password !== password) throw new Error('That email and password don\u2019t match an account.');
    this.data.session = u.id;
    this.persist();
    return true;
  }
  async signOut() { this.data.session = null; this.persist(); }
  get recovering() { return false; }
  onRecovery() {}
  async requestReset(email) {
    // No mail server locally — go straight to choosing a new password.
    if (!this.data.users[email.toLowerCase()]) throw new Error('There is no account for that email.');
    this.resetEmail = email.toLowerCase();
    return 'local';
  }
  async updatePassword(password) {
    const u = this.resetEmail ? this.data.users[this.resetEmail]
      : Object.values(this.data.users).find(x => x.id === this.data.session);
    if (!u) throw new Error('That reset has expired. Start again from sign in.');
    u.password = password;
    this.data.session = u.id;
    this.resetEmail = null;
    this.persist();
  }
  mineUser() {
    const hit = Object.entries(this.data.users).find(([, u]) => u.id === this.data.session);
    return hit ? { email: hit[0], user: hit[1] } : null;
  }
  async accountInfo() {
    const m = this.mineUser();
    return m ? { email: m.email, joined: m.user.created_at || null, pendingEmail: null } : { email: '', joined: null, pendingEmail: null };
  }
  async changeEmail(email) {
    const e = email.toLowerCase();
    const m = this.mineUser();
    if (!m) throw new Error('Sign in again to change your email.');
    if (e === m.email) throw new Error('That\u2019s already your email.');
    if (this.data.users[e]) throw new Error('An account already exists for that email.');
    this.data.users[e] = m.user;
    delete this.data.users[m.email];
    this.persist();
    return 'local';
  }
  async deleteAccount() {
    const uid = this.data.session;
    this.data.entries = this.data.entries.filter(e => e.user_id !== uid);
    for (const [k, u] of Object.entries(this.data.users)) if (u.id === uid) delete this.data.users[k];
    this.data.session = null;
    this.persist();
  }
  async bind(session) { this._uid = session.user.id; }
  get uid() { return this._uid; }

  mine() { return this.data.entries.filter(e => e.user_id === this._uid); }
  async byState(states) {
    return this.mine().filter(e => states.includes(e.state))
      .sort((a, b) => new Date(a.written_at) - new Date(b.written_at));
  }
  async eligible(now) {
    return this.mine().filter(e => e.state === 'sealed' && e.return_at && new Date(e.return_at) <= now)
      .sort((a, b) => new Date(a.return_at) - new Date(b.return_at));
  }
  async lastDeliveredAt() {
    const d = this.mine().filter(e => e.delivered_at).map(e => new Date(e.delivered_at));
    return d.length ? new Date(Math.max(...d)) : null;
  }
  async sealedOrReturnedCount() {
    return this.mine().filter(e => e.state === 'sealed' || e.state === 'returned').length;
  }
  async getDraft() {
    return this.mine().filter(e => e.state === 'draft')
      .sort((a, b) => new Date(b.written_at) - new Date(a.written_at))[0] || null;
  }
  async saveDraft(id, body, promptText) {
    let row = id ? this.data.entries.find(e => e.id === id) : null;
    if (!row) {
      row = { id: 'e_' + Math.random().toString(36).slice(2), user_id: this._uid,
              body, prompt_text: promptText || null, written_at: new Date().toISOString(),
              return_at: null, delivered_at: null, state: 'draft' };
      this.data.entries.push(row);
    } else { row.body = body; row.prompt_text = promptText || null; }
    this.persist();
    return row.id;
  }
  async update(id, patch) {
    const row = this.data.entries.find(e => e.id === id);
    if (row) Object.assign(row, patch);
    this.persist();
  }
  async remove(id) {
    this.data.entries = this.data.entries.filter(e => e.id !== id);
    this.persist();
  }
  async all() {
    return this.mine().sort((a, b) => new Date(a.written_at) - new Date(b.written_at));
  }
}

/* ============================================================
   PROMPTS
   A question that turns up or doesn't. Nothing follows from it.
   Groups exist only to weight the ordinary ones — they are internal,
   never shown, never stored, never counted.
   ============================================================ */

const PROMPT_POOL = {
  freedom: [
    'Is the life you\u2019re living one you chose?',
    'What have you decided without deciding?',
    'What are you doing because it matters, and what because it\u2019s expected?',
    'When did you last change your mind about something that mattered?',
    'What would you do differently if no one you knew would find out?',
    'What are you waiting for permission to do?',
    'What did you want, before you wanted this?',
    'What would you have to give up to get what you say you want?'
  ],
  obligation: [
    'What are you carrying that isn\u2019t yours?',
    'What did you owe someone today?',
    'Who are you grateful to, and have you said so?',
    'What do you do when nobody needs anything from you?',
    'Who would notice if you stopped?',
    'What have you never been able to explain to your family?',
    'Whose approval are you still working for?',
    'What would you do with a year that nobody was counting on you for?'
  ],
  repetition: [
    'What does today have in common with yesterday?',
    'What are you tired of explaining?',
    'If nothing changed for a year, would that be alright?',
    'What keeps happening that you have stopped noticing?',
    'What do you do on the days that don\u2019t count?',
    'What would be lost if you stopped?',
    'Does this feel like a beginning, a middle, or something else?'
  ],
  enough: [
    'What would enough look like?',
    'What are you good at that you don\u2019t give yourself credit for?',
    'What\u2019s the smallest thing that went well?',
    'What are you hoping someone will notice?',
    'What would you like to still be true in ten years?',
    'What are you working towards that you have never said out loud?',
    'What mattered to you a year ago that doesn\u2019t now?'
  ],
  performance: [
    'Who were you being today?',
    'What version of yourself did other people get?',
    'What are you pretending to have under control?',
    'What would you write here if you knew nobody would ever read it?',
    'What do you say when people ask how you are, and what is the real answer?',
    'What are you performing that you used to mean?'
  ],
  time: [
    'Where do you think you\u2019ll be when this comes back to you?',
    'What would you want the person reading this later to know?',
    'What\u2019s still true from a year ago?',
    'What are you going to have forgotten about this by the time it returns?',
    'What would you tell someone else in your position?',
    'What do you hope will have changed?'
  ],
  uncertainty: [
    'What are you not sure about?',
    'What have you not had time to think about?',
    'What would you like to stop deciding?',
    'What are you hoping will resolve itself?',
    'Is there something you\u2019ve been meaning to say?'
  ],
  ordinary: [
    'What did you notice today?',
    'What did you eat, and who with?',
    'What would you do with an ordinary day that asked nothing of you?'
  ]
};

const ORDINARY_CHANCE = 1 / 6;      // the ordinary group comes up about 1 in 6
const QUEUE_KEY = 'bukas.prompts.v2';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One shuffled queue per group. Nothing repeats until the whole pool is spent.
function loadQueues() {
  let q = null;
  try { q = JSON.parse(localStorage.getItem(QUEUE_KEY)); } catch (e) { q = null; }
  const keys = Object.keys(PROMPT_POOL);
  const valid = q && typeof q === 'object' && keys.every(k => Array.isArray(q[k]));
  if (!valid) {
    q = {};
    for (const k of keys) q[k] = shuffle(PROMPT_POOL[k].slice());
  }
  return q;
}

function nextPrompt() {
  const q = loadQueues();
  const others = Object.keys(PROMPT_POOL).filter(k => k !== 'ordinary');
  // Weight the group first, then draw from it. Each group reshuffles when it
  // individually empties, so the weighting holds and no prompt repeats until
  // its own group has cycled.
  const group = Math.random() < ORDINARY_CHANCE
    ? 'ordinary'
    : others[Math.floor(Math.random() * others.length)];
  if (!q[group].length) q[group] = shuffle(PROMPT_POOL[group].slice());
  const prompt = q[group].shift();
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  return prompt;
}

/* ============================================================
   APP
   ============================================================ */

const $ = s => document.querySelector(s);
let store = null;   // chosen in boot(), once the config is known
let returnedNow = [];   // entries currently on screen as a return
let draftId = null;
let saveTimer = null;
let currentPrompt = null;   // the prompt on screen right now, if any
let signedIn = false;

function openAbout() {
  $('#about-back').querySelector('span').textContent = signedIn ? 'Back to home' : 'Back to sign in';
  show('about');
}

function closeAcctForms() {
  for (const [t, f] of [['#acct-pw-toggle', '#acct-pw-form']]) {
    $(f).hidden = true; $(f).reset(); $(t).setAttribute('aria-expanded', 'false');
  }
}

async function openAccount() {
  closeAcctForms();
  $('#acct-notice').textContent = '';
  $('#acct-email').textContent = '';
  $('#acct-joined-row').hidden = true;
  show('account');
  try {
    const info = await store.accountInfo();
    $('#acct-email').textContent = info.email;
    if (info.joined) {
      const d = new Date(info.joined);
      $('#acct-joined').textContent = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      $('#acct-joined-row').hidden = false;
    }
  } catch (err) {
    console.warn(err);
    $('#acct-notice').textContent = 'Your account details didn\u2019t load. Check your connection and try again.';
  }
}

function toggleAcctForm(toggleSel, formSel, focusSel) {
  const f = $(formSel), open = f.hidden;
  closeAcctForms();
  $('#acct-notice').textContent = '';
  f.hidden = !open;
  $(toggleSel).setAttribute('aria-expanded', String(open));
  if (open) $(focusSel).focus();
}

async function handleChangePassword(e) {
  e.preventDefault();
  const pw = $('#acct-new-pw').value;
  const current = $('#acct-current-pw').value;
  const note = $('#acct-notice');
  if (!current) { note.textContent = 'Enter your current password first.'; return; }
  if (pw.length < 6) { note.textContent = 'At least six characters.'; return; }
  try {
    await store.updatePassword(pw, current);
    $('#acct-pw-form').reset();
    closeAcctForms();
    note.textContent = 'Password changed.';
  } catch (err) {
    note.textContent = friendlyError(err) || 'Something went wrong. Try again.';
    if (err.code === 'SESSION_EXPIRED') {
      // Send them to sign in with their email filled in.
      const email = $('#acct-email').textContent;
      setTimeout(async () => {
        try { await store.signOut(); } catch (e) {}
        signedIn = false;
        setMode('signin');
        $('#auth-form').reset();
        $('#email').value = email;
        show('landing');
      }, 2200);
    }
  }
}

let introTimers = [];

function runIntro() {
  introTimers.forEach(clearTimeout);
  introTimers = [];
  const paras = [...document.querySelectorAll('#intro .intro-body p')];
  const foot = document.querySelector('#intro .foot');
  paras.forEach(p => p.classList.remove('is-in'));
  foot.classList.remove('is-in');
  document.querySelector('.intro-skip').classList.remove('is-gone');
  paras.forEach((p, i) => {
    introTimers.push(setTimeout(() => p.classList.add('is-in'), 300 + i * 2600));
  });
  introTimers.push(setTimeout(() => {
    foot.classList.add('is-in');
    document.querySelector('.intro-skip').classList.add('is-gone');
    // If the column is taller than the viewport, bring the control to the eye
    // as it arrives rather than leaving it below the fold.
    if (document.documentElement.scrollHeight > window.innerHeight + 4) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    }
  }, 300 + paras.length * 2600));
}

async function fadeTo(go) { await go(); }

// Every screen change fades: out 180ms, in 320ms — about half a second.
// Instant during first load (so a signed-in visit doesn't flash the landing)
// and for anyone who has asked their device to reduce motion.
const FADE_OUT = 180, FADE_IN = 320;
let showToken = 0;
let instantShow = true;

function show(id) {
  const next = document.getElementById(id);
  const cur = document.querySelector('.screen.is-active');
  const token = ++showToken;
  const swap = () => {
    document.querySelectorAll('.screen').forEach(el => {
      el.classList.toggle('is-active', el === next);
      el.style.transition = '';
      el.style.opacity = '';
    });
    window.scrollTo(0, 0);
  };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (instantShow || reduce || !cur || cur === next) { swap(); return Promise.resolve(); }

  return new Promise(resolve => {
    cur.style.transition = `opacity ${FADE_OUT}ms ease`;
    cur.style.opacity = '0';
    setTimeout(() => {
      if (token !== showToken) return resolve();
      swap();
      next.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (token !== showToken) return resolve();
        next.style.transition = `opacity ${FADE_IN}ms ease`;
        next.style.opacity = '1';
        setTimeout(() => {
          if (token === showToken) { next.style.transition = ''; next.style.opacity = ''; }
          resolve();
        }, FADE_IN + 10);
      }));
    }, FADE_OUT);
  });
}

/* ---------- auth ---------- */

// Supabase's password errors list every allowed character; say it plainly.
function friendlyError(err) {
  if (err && err.code === 'BAD_CURRENT') return err.message;
  if (/reauthenticat/i.test((err && err.message) || '')) return 'For safety, sign out and back in, then change your password.';
  const m = (err && err.message) || '';
  if (/at least one character of each/i.test(m)) {
    const need = [];
    if (m.includes('abcdefghijklmnopqrstuvwxyz')) need.push('a lowercase letter');
    if (m.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ')) need.push('an uppercase letter');
    if (m.includes('0123456789')) need.push('a number');
    if (/[!@#$%^&*()_+\-=\[\]{};':"|<>?,.\/`~]{4,}/.test(m)) need.push('a symbol');
    if (!need.length) return 'Your password needs a mix of letters and numbers.';
    const list = need.length > 1 ? need.slice(0, -1).join(', ') + ' and ' + need[need.length - 1] : need[0];
    return 'Your password needs at least ' + list + '.';
  }
  const len = m.match(/at least (\d+) characters/i);
  if (len && /password/i.test(m)) return 'Your password needs at least ' + len[1] + ' characters.';
  if (/weak|pwned|leaked|compromised/i.test(m) && /password/i.test(m)) return 'That password has shown up in a data breach. Try a different one.';
  if (/same.*password|different from the old/i.test(m)) return 'Your new password needs to be different from your current one.';
  return m;
}

function setMode(mode) {
  const labels = {
    signup: ['Sign up', 'I already have an account'],
    signin: ['Sign in', 'Create an account'],
    reset:  ['Send reset link', 'Back to sign in']
  }[mode];
  $('#auth-submit').textContent = labels[0];
  $('#auth-toggle').textContent = labels[1];
  $('#password-field').hidden = mode === 'reset';
  $('#password').required = mode !== 'reset';
  $('#auth-forgot').hidden = mode !== 'signin';
  $('#auth-form').dataset.mode = mode;
  $('#auth-notice').textContent = '';
}

async function handleAuth(e) {
  e.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const mode = $('#auth-form').dataset.mode;
  $('#auth-notice').textContent = '';
  if (mode === 'reset') {
    if (!email) { $('#auth-notice').textContent = 'The email you signed up with.'; return; }
    try {
      const how = await store.requestReset(email);
      if (how === 'local') { show('new-password'); return; }
      $('#auth-notice').textContent = 'If there\u2019s an account for that email, a link to reset your password is on its way.';
    } catch (err) {
      $('#auth-notice').textContent = friendlyError(err) || 'Something went wrong. Try again.';
    }
    return;
  }
  if (!email || password.length < 6) {
    $('#auth-notice').textContent = 'Enter your email and a password with at least six characters.';
    return;
  }
  try {
    const signedIn = mode === 'signup'
      ? await store.signUp(email, password)
      : await store.signIn(email, password);
    if (!signedIn) {
      $('#check-email-address').textContent = email;
      $('#password').value = '';
      await fadeTo(() => show('check-email'));
      return;
    }
    await enter(true);
  } catch (err) {
    if (err && err.code === 'EXISTS') {
      setMode('signin');
      $('#email').value = email;
      $('#password').value = '';
      $('#auth-notice').textContent = 'There\u2019s already an account with that email. Sign in instead, or use \u201cForgot your password?\u201d if you need to.';
      $('#password').focus();
      return;
    }
    $('#auth-notice').textContent = friendlyError(err) || 'Something went wrong. Try again.';
  }
}

/* ---------- home / delivery ---------- */

// Shown on every deliberate sign-in or sign-up, not when an existing
// session is simply reopened.
async function enter(showIntro) {
  const session = await store.session();
  if (!session) { signedIn = false; show('landing'); return; }
  await store.bind(session);
  signedIn = true;
  if (showIntro) { show('intro'); runIntro(); return; }
  await resolveHome();
}

async function resolveHome() {
  // Anything already delivered and not yet acted on stays on screen.
  let group = (await store.byState(['returned']));
  if (!group.length) group = await pickDelivery();
  if (group.length) { pendingGroup = group; show('waiting'); return; }
  show('home');
}

let pendingGroup = [];

async function handleNewPassword(e) {
  e.preventDefault();
  const pw = $('#new-password-input').value;
  const note = $('#new-password-notice');
  note.textContent = '';
  if (pw.length < 6) { note.textContent = 'At least six characters.'; return; }
  try {
    await store.updatePassword(pw);
    history.replaceState(null, '', location.pathname + location.search);
    $('#new-password-form').reset();
    await enter(false);
  } catch (err) {
    note.textContent = friendlyError(err) || 'Something went wrong. Try again.';
  }
}

async function pickDelivery() {
  const now = new Date();
  const eligible = await store.eligible(now);
  if (!eligible.length) return [];

  // Metered: never more than one return per five days.
  const last = await store.lastDeliveredAt();
  if (last && now - last < METER_DAYS * DAY) return [];

  // Never delivered on the anniversary of the day it was written.
  const ok = eligible.filter(e => !isAnniversary(e.written_at, now));
  if (!ok.length) return [];

  const group = [ok[0]];
  if (Math.random() < PAIR_CHANCE) {
    const partner = ok.slice(1).find(e => structurallyPaired(ok[0], e));
    if (partner) group.push(partner);
  }
  group.sort((a, b) => new Date(a.written_at) - new Date(b.written_at));
  const stamp = now.toISOString();
  for (const e of group) await store.update(e.id, { state: 'returned', delivered_at: stamp });
  return group;
}

function renderReturn(group) {
  returnedNow = group;
  const wrap = $('#return-entries');
  wrap.innerHTML = '';
  group.forEach((e, i) => {
    if (i > 0) {
      const hr = document.createElement('hr');
      hr.className = 'hairline';
      wrap.appendChild(hr);
    }
    const art = document.createElement('article');
    art.className = 'return-entry';
    const d = document.createElement('p');
    d.className = 'date';
    d.textContent = plainDate(e.written_at);
    art.append(d);
    if (e.prompt_text) {
      const q = document.createElement('p');
      q.className = 'return-prompt';
      q.textContent = e.prompt_text;
      art.append(q);
    }
    const b = document.createElement('p');
    b.className = 'body-text';
    b.textContent = e.body;
    art.append(b);
    wrap.appendChild(art);
  });
  const controls = $('#return-controls');
  controls.classList.remove('is-visible');
  show('return');
  setTimeout(() => controls.classList.add('is-visible'), 4000);
}

async function deferReturn(longDraw) {
  const now = new Date();
  for (const e of returnedNow) {
    const written = new Date(e.written_at);
    const days = longDraw
      ? logUniformDays(MIN_DAYS, MAX_DAYS)   // seal it again — the full rule
      : logUniformDays(5, 60);               // not now — out of the next weeks, not the year
    let at = new Date(now.getTime() + days * DAY);
    if (sameMonthDay(at, written)) at = new Date(at.getTime() + DAY);
    await store.update(e.id, { state: 'sealed', return_at: at.toISOString() });
  }
  returnedNow = [];
  show('home');
}

/* ---------- compose ---------- */

let stampTimer = null;

function paintStamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  $('#compose-stamp').textContent = `${plainDate(d)} \u00b7 ${hh}:${mm}`;
}

// A copy of the draft kept in this browser, written on every keystroke, so a
// dropped connection or a reload never costs anyone what they typed.
function backupKey() { return 'bukas.draft-backup.' + store.uid; }
function readBackup() {
  try { return JSON.parse(localStorage.getItem(backupKey())); } catch (e) { return null; }
}
function writeBackup(body) {
  try {
    if (body.trim()) localStorage.setItem(backupKey(), JSON.stringify({ body, prompt: currentPrompt || null, id: draftId }));
    else localStorage.removeItem(backupKey());
  } catch (e) {}
}
function clearBackup() { try { localStorage.removeItem(backupKey()); } catch (e) {} }

async function openCompose() {
  let draft = null;
  try { draft = await store.getDraft(); } catch (e) { console.warn('Draft not reachable, using local copy', e); }
  const backup = readBackup();
  if (backup && backup.body && (!draft || backup.body !== draft.body)) {
    draft = { id: (draft && draft.id) || backup.id || null, body: backup.body, prompt_text: backup.prompt };
  }
  draftId = draft ? draft.id : null;
  const ta = $('#composer');
  ta.value = draft ? draft.body : '';
  ta.classList.remove('is-fading');

  const wrap = $('#prompt-wrap');
  currentPrompt = draft && draft.prompt_text ? draft.prompt_text
    : (!ta.value && Math.random() < PROMPT_CHANCE ? nextPrompt() : null);
  if (currentPrompt) {
    $('#prompt-text').textContent = currentPrompt;
    wrap.hidden = false;
    wrap.style.opacity = '1';
  } else {
    wrap.hidden = true;
  }
  paintStamp();
  clearInterval(stampTimer);
  stampTimer = setInterval(paintStamp, 20000);

  updateSealState();
  show('compose').then(() => ta.focus());
}

function dismissPrompt() {
  const wrap = $('#prompt-wrap');
  currentPrompt = null;
  wrap.style.opacity = '0';
  setTimeout(() => { wrap.hidden = true; }, 400);
  writeBackup($('#composer').value);
  if (draftId) store.saveDraft(draftId, $('#composer').value, null).catch(() => {});
  $('#composer').focus();
}

function updateSealState() {
  $('#seal-hold').disabled = !$('#composer').value.trim();
}

function onType() {
  updateSealState();
  clearTimeout(saveTimer);
  const body = $('#composer').value;
  writeBackup(body);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      draftId = await store.saveDraft(draftId, body, currentPrompt);
      writeBackup($('#composer').value);
    } catch (e) { console.warn('Draft kept locally until the connection is back', e); }
  }, 600);
}

/* ---------- the seal ---------- */

let holdStart = 0, holdRaf = null, unwinding = false, sealing = false;

// The envelope. During the hold, the page descends into it — and rises
// back out if released. Only after a full hold does the flap close.
const ease = t => 1 - Math.pow(1 - t, 3);
const clamp01 = t => Math.max(0, Math.min(1, t));

function paintArt(p) {
  const paper = $('#art-paper');
  // Paper starts well above the envelope and settles fully inside.
  const k = ease(clamp01((p - 0.15) / 0.85));
  paper.setAttribute('transform', `translate(0 ${(-96 * (1 - k)).toFixed(2)})`);
  $('#art-flap-back').style.opacity = '1';
  $('#art-flap').style.opacity = '0';
  $('#art-seal').style.opacity = '0';
  $('#art-env').setAttribute('transform', '');
  $('#art-env').style.opacity = '1';
}

function paintHold(p) {
  $('#seal-hold').style.setProperty('--fill', p);
  $('#seal-veil').style.opacity = String(Math.pow(p, 1.35));
  paintArt(p);
}

function playClose() {
  return new Promise(resolve => {
    const flap = $('#art-flap'), back = $('#art-flap-back');
    const seal = $('#art-seal'), env = $('#art-env');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const D = reduce ? 600 : 1900;
    const t0 = performance.now();
    const frame = t => {
      const e = (t - t0) / D;
      // 0–.32 flap folds down, .32–.45 seal presses, .55–1 envelope leaves.
      const f = ease(clamp01(e / 0.32));
      back.style.opacity = '0';
      flap.style.opacity = '1';
      const sy = -1 + 2 * f;   // -1 = open (pointing up), 1 = closed
      flap.setAttribute('transform', `translate(0 90) scale(1 ${sy.toFixed(3)}) translate(0 -90)`);
      const sp = clamp01((e - 0.32) / 0.13);
      seal.style.opacity = String(sp);
      seal.setAttribute('r', (8 + 3 * (1 - ease(sp))).toFixed(2));
      const g = ease(clamp01((e - 0.55) / 0.45));
      env.setAttribute('transform', `translate(130 120) scale(${(1 - 0.35 * g).toFixed(3)}) translate(-130 ${(-120 - 70 * g).toFixed(2)})`);
      env.style.opacity = String(1 - g);
      if (e < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function holdDown(e) {
  if ($('#seal-hold').disabled || sealing) return;
  e.preventDefault();
  unwinding = false;
  holdStart = performance.now();
  cancelAnimationFrame(holdRaf);
  const step = t => {
    const p = Math.min(1, (t - holdStart) / HOLD_MS);
    paintHold(p);
    if (p >= 1) { completeSeal(); return; }
    holdRaf = requestAnimationFrame(step);
  };
  holdRaf = requestAnimationFrame(step);
}

function holdUp() {
  if (sealing || unwinding) return;
  cancelAnimationFrame(holdRaf);
  unwinding = true;
  const from = parseFloat($('#seal-hold').style.getPropertyValue('--fill') || '0');
  const t0 = performance.now();
  const back = t => {
    const p = Math.max(0, from * (1 - (t - t0) / 420));
    paintHold(p);
    if (p > 0) holdRaf = requestAnimationFrame(back);
    else unwinding = false;
  };
  holdRaf = requestAnimationFrame(back);
}

async function completeSeal() {
  sealing = true;
  // The only confirmation that isn't visual.
  if (navigator.vibrate) navigator.vibrate(18);
  cancelAnimationFrame(holdRaf);
  clearTimeout(saveTimer);
  saveTimer = null;

  const body = $('#composer').value.trim();
  const writtenAt = new Date();
  try {
    const isFirst = (await store.sealedOrReturnedCount()) === 0;
    const returnAt = drawReturnAt(writtenAt, isFirst);
    draftId = await store.saveDraft(draftId, body, currentPrompt);
    await store.update(draftId, {
      state: 'sealed',
      body,
      prompt_text: currentPrompt || null,
      written_at: writtenAt.toISOString(),
      return_at: returnAt.toISOString()
    });
  } catch (e) {
    // No connection: nothing is sealed, nothing is lost. The dark winds back
    // and the words are still there to seal again.
    console.warn('Seal did not reach the server', e);
    writeBackup($('#composer').value);
    sealing = false;
    holdUp();
    return;
  }
  draftId = null;
  clearBackup();
  await playClose();

  // The absence is the only confirmation: the text fades out, then the dark
  // lifts off an empty field. Nothing else happens, and nothing navigates.
  const ta = $('#composer');
  const veil = $('#seal-veil');
  ta.classList.add('is-fading');
  setTimeout(() => {
    ta.value = '';
    ta.classList.remove('is-fading');
    currentPrompt = null;
    $('#prompt-wrap').hidden = true;
    veil.style.transition = 'opacity 1200ms ease';
    veil.style.opacity = '0';
    setTimeout(() => {
      veil.style.transition = '';
      paintHold(0);
      updateSealState();
      sealing = false;
    }, 1200);
  }, 750);
}

/* ---------- a second hold, for the one destructive control ---------- */

function bindHold(el, ms, done, onPaint) {
  let raf = null, start = 0, busy = false;
  const paint = p => { el.style.setProperty('--fill', p); if (onPaint) onPaint(p); };
  const unwind = () => {
    if (busy) return;
    cancelAnimationFrame(raf);
    const from = parseFloat(el.style.getPropertyValue('--fill') || '0');
    const t0 = performance.now();
    const back = t => {
      const p = Math.max(0, from * (1 - (t - t0) / 320));
      paint(p);
      if (p > 0) raf = requestAnimationFrame(back);
    };
    raf = requestAnimationFrame(back);
  };
  el.addEventListener('pointerdown', e => {
    if (busy) return;
    e.preventDefault();
    start = performance.now();
    cancelAnimationFrame(raf);
    const step = t => {
      const p = Math.min(1, (t - start) / ms);
      paint(p);
      if (p >= 1) {
        busy = true;
        if (navigator.vibrate) navigator.vibrate(12);
        el.style.setProperty('--fill', 0);
        Promise.resolve(done()).then(() => { busy = false; });
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });
  el.addEventListener('pointerup', unwind);
  el.addEventListener('pointercancel', unwind);
  el.addEventListener('pointerleave', unwind);
  el.addEventListener('contextmenu', e => e.preventDefault());
}

/* ---------- export ---------- */

async function exportAll() {
  const rows = await store.all();
  const lines = ['BUKAS', 'Everything you\u2019ve written.', ''];
  for (const e of rows) {
    lines.push('----------------------------------------');
    lines.push(`Written   ${plainDate(e.written_at)}`);
    if (e.return_at) lines.push(`Returns   ${plainDate(e.return_at)}`);
    lines.push(`State     ${e.state}`);
    lines.push('');
    if (e.prompt_text) { lines.push(e.prompt_text); lines.push(''); }
    lines.push(e.body || '');
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bukas.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- wiring ---------- */

function wire() {
  $('#auth-form').addEventListener('submit', handleAuth);
  $('#auth-toggle').addEventListener('click', () => {
    const m = $('#auth-form').dataset.mode;
    setMode(m === 'signup' ? 'signin' : m === 'signin' ? 'signup' : 'signin');
  });
  $('#auth-forgot').addEventListener('click', () => setMode('reset'));
  $('#check-email-back').addEventListener('click', () => fadeTo(() => {
    setMode('signin');
    $('#email').value = $('#check-email-address').textContent;
    show('landing');
  }));
  $('#new-password-form').addEventListener('submit', handleNewPassword);

  $('#read-return').addEventListener('click', () => fadeTo(() => renderReturn(pendingGroup)));
  $('#waiting-write').addEventListener('click', openCompose);

  bindHold($('#delete-account'), 1600, async () => {
    try {
      await store.deleteAccount();
    } catch (err) { console.error(err); return; }
    signedIn = false;
    returnedNow = []; pendingGroup = []; draftId = null;
    setMode('signin');
    $('#auth-form').reset();
    await fadeTo(() => show('landing'));
  });

  $('#to-write').addEventListener('click', openCompose);
  $('#prompt-dismiss').addEventListener('click', dismissPrompt);
  $('#composer').addEventListener('input', onType);
  $('#compose-back').addEventListener('click', () => { clearInterval(stampTimer); resolveHome(); });;
  // While held, the words recede inside the box; release and they return.
  // A full hold lets them go, and the empty box stays, ready to start again.
  const composer = $('#composer');
  bindHold($('#compose-discard'), 900, async () => {
    clearTimeout(saveTimer); saveTimer = null;
    const id = draftId;
    draftId = null;
    composer.style.transition = 'opacity 600ms ease';
    composer.style.opacity = '0';
    const removing = id ? store.remove(id) : Promise.resolve();
    await new Promise(r => setTimeout(r, 620));
    await removing;
    composer.value = '';
    updateSealState();
    requestAnimationFrame(() => {
      composer.style.transition = 'opacity 400ms ease';
      composer.style.opacity = '1';
      setTimeout(() => { composer.style.transition = ''; composer.style.opacity = ''; composer.focus(); }, 420);
    });
  }, p => {
    composer.style.transition = '';
    composer.style.opacity = String(1 - 0.75 * p);
  });

  const hold = $('#seal-hold');
  hold.addEventListener('pointerdown', holdDown);
  hold.addEventListener('pointerup', holdUp);
  hold.addEventListener('pointercancel', holdUp);
  hold.addEventListener('pointerleave', holdUp);
  hold.addEventListener('contextmenu', e => e.preventDefault());

  $('#reseal').addEventListener('click', () => deferReturn(true));
  $('#not-now').addEventListener('click', () => deferReturn(false));
  // Let it go: the entry ends here. Deleted, not deferred. Same hold as discard.
  bindHold($('#let-go'), 1200, async () => {
    const group = returnedNow;
    returnedNow = [];
    try { for (const e of group) await store.remove(e.id); }
    catch (e) { console.warn(e); returnedNow = group; return; }
    await fadeTo(() => show('home'));
  });

  document.querySelectorAll('[data-to-about]').forEach(b =>
    b.addEventListener('click', openAbout));
  $('#about-back').addEventListener('click', () => {
    if (signedIn) resolveHome(); else show('landing');
  });
  $('#intro-skip').addEventListener('click', () => {
    introTimers.forEach(clearTimeout);
    introTimers = [];
    resolveHome();
  });
  $('#intro-continue').addEventListener('click', () => {
    introTimers.forEach(clearTimeout);
    introTimers = [];
    resolveHome();
  });
  $('#export').addEventListener('click', exportAll);
  document.querySelectorAll('[data-to-account]').forEach(b =>
    b.addEventListener('click', openAccount));
  $('#account-back').addEventListener('click', () => resolveHome());
  $('#acct-pw-toggle').addEventListener('click', () => toggleAcctForm('#acct-pw-toggle', '#acct-pw-form', '#acct-current-pw'));
  $('#acct-pw-form').addEventListener('submit', handleChangePassword);
  $('#acct-forgot').addEventListener('click', async () => {
    const note = $('#acct-notice');
    const email = $('#acct-email').textContent.trim();
    if (!email) { note.textContent = 'Something went wrong. Try again.'; return; }
    const btn = $('#acct-forgot'); btn.disabled = true;
    try {
      await store.requestReset(email);
      closeAcctForms();
      note.textContent = 'A reset link is on its way to ' + email + '.';
    } catch (err) {
      note.textContent = friendlyError(err) || 'Something went wrong. Try again.';
    } finally { setTimeout(() => { btn.disabled = false; }, 30000); }
  });

  document.querySelectorAll('[data-sign-out]').forEach(b =>
    b.addEventListener('click', async () => {
      introTimers.forEach(clearTimeout);
      introTimers = [];
      await store.signOut();
      signedIn = false;
      returnedNow = [];
      setMode('signin');
      $('#auth-form').reset();
      show('landing');
    }));

  window.addEventListener('beforeunload', () => {
    const body = $('#composer').value;
    if (body.trim()) writeBackup(body);
    if (saveTimer && body.trim()) { clearTimeout(saveTimer); store.saveDraft(draftId, body, currentPrompt).catch(() => {}); }
  });
}

/* ---------- boot ---------- */

(async function boot() {
  const c = await loadConfig();
  if (c) { cfg = c; HAS_SUPABASE = true; }
  store = HAS_SUPABASE ? new SupabaseStore() : new LocalStore();
  setMode('signin');
  wire();
  if (!HAS_SUPABASE) $('#demo-note').hidden = false;
  store.onRecovery(() => show('new-password'));
  if (store.recovering) { show('new-password'); instantShow = false; return; }
  try { await enter(); }
  catch (err) { console.error(err); show('landing'); }
  instantShow = false;
})();

/* Console-only helpers for testing the mechanic without waiting days.
   Deliberately not surfaced in the interface. */
window.__bukas = {
  async due() {  // make everything sealed eligible now, and clear the meter
    const rows = await store.all();
    for (const e of rows) {
      if (e.state === 'sealed') await store.update(e.id, {
        return_at: new Date(Date.now() - DAY).toISOString(), delivered_at: null
      });
    }
    await resolveHome();
  },
  async distribution(n = 10000) {
    const b = { '<3m': 0, '3m-1y': 0, '>1y': 0 };
    for (let i = 0; i < n; i++) {
      const d = logUniformDays(MIN_DAYS, MAX_DAYS);
      if (d < 91) b['<3m']++; else if (d < 365) b['3m-1y']++; else b['>1y']++;
    }
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, (v / n * 100).toFixed(1) + '%']));
  }
};
