(() => {
  'use strict';
  const config = window.APP_CONFIG || {};
  const $ = (selector) => document.querySelector(selector);
  const state = { client: null, terminal: null, rooms: [], notices: [], acknowledgements: new Set(), channel: null, sound: false, audio: null, refreshTimer: null };
  const el = {
    shell: $('#app-shell'), activation: $('#activation-modal'), activationForm: $('#activation-form'), activationCode: $('#activation-code'), activationError: $('#activation-error'), activationSubmit: $('#activation-submit'),
    room: $('#terminal-room'), terminalLabel: $('#terminal-label'), description: $('#room-description'), destination: $('#notice-destination'), message: $('#notice-message'), priority: $('#notice-priority'), form: $('#notice-form'), send: $('#send-button'), list: $('#notice-list'),
    dot: $('#connection-dot'), connection: $('#connection-status'), refresh: $('#refresh-button'), sound: $('#sound-button'), headerSound: $('#header-sound-button'), theme: $('#theme-toggle'), sidebarTheme: $('#sidebar-theme-toggle'), themeIcon: $('#theme-icon'), themeLabel: $('#theme-label'), toast: $('#toast')
  };

  const priorityName = { immediate: 'Inmediato', urgent: 'Urgente', routine: 'No urgente' };
  const setConnection = (text, kind = '') => { el.connection.textContent = text; el.dot.className = `dot ${kind}`; };
  function setTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('intercom-theme', dark ? 'dark' : 'light'); } catch { /* El aspecto sigue funcionando aunque el navegador no permita guardar preferencias. */ }
    if (el.themeIcon) el.themeIcon.textContent = dark ? '☀️' : '🌙';
    if (el.themeLabel) el.themeLabel.textContent = dark ? 'Modo claro' : 'Modo nocturno';
  }
  function toggleTheme() { setTheme(!document.documentElement.classList.contains('dark')); }
  const roomName = (id) => state.rooms.find((room) => room.id === id)?.name || 'Sala no disponible';
  const formatTime = (value) => new Intl.DateTimeFormat('es-CL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  function toast(message, kind = '') { el.toast.textContent = message; el.toast.className = `toast ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => el.toast.classList.add('hidden'), 4800); }
  function activationError(message = '') { el.activationError.textContent = message; el.activationError.classList.toggle('hidden', !message); }
  function report(error) { console.error(error); toast(error?.message || 'No fue posible completar la operación. Comprueba la conexión e inténtalo nuevamente.', 'error'); }

  function renderNotices() {
    el.list.replaceChildren();
    if (!state.notices.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No hay avisos activos para este terminal.'; el.list.append(empty); return; }
    for (const notice of state.notices) {
      const article = document.createElement('article'); article.className = `notice ${notice.priority}`;
      const content = document.createElement('div'); const meta = document.createElement('div'); meta.className = 'notice-meta';
      const badge = document.createElement('span'); badge.className = `badge ${notice.priority}`; badge.textContent = priorityName[notice.priority] || 'Aviso';
      const origin = document.createElement('span'); origin.textContent = `Desde: ${roomName(notice.source_room_id)}`;
      const target = document.createElement('span'); target.textContent = notice.destination_room_id ? `Para: ${roomName(notice.destination_room_id)}` : 'Para: Todas las salas';
      const time = document.createElement('time'); time.dateTime = notice.created_at; time.textContent = formatTime(notice.created_at);
      const message = document.createElement('p'); message.textContent = String(notice.body ?? '');
      meta.append(badge, origin, target, time); content.append(meta, message);
      const actions = document.createElement('div'); actions.className = 'notice-actions'; const isOrigin = notice.source_terminal_id === state.terminal.terminal_id;
      if (notice.status === 'active' && !isOrigin) {
        const ack = document.createElement('button'); ack.type = 'button'; const received = state.acknowledgements.has(notice.id); ack.textContent = received ? 'Recibido ✓' : 'Confirmar recepción'; ack.disabled = received; ack.addEventListener('click', () => acknowledge(notice.id)); actions.append(ack);
      }
      if (notice.status === 'active' && isOrigin) { const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Cerrar aviso'; close.addEventListener('click', () => closeNotice(notice.id)); actions.append(close); }
      if (notice.status !== 'active') { const closed = document.createElement('button'); closed.className = 'closed'; closed.disabled = true; closed.textContent = 'Cerrado'; actions.append(closed); }
      article.append(content, actions); el.list.append(article);
    }
  }

  async function enableSound() {
    try { state.audio ??= new AudioContext(); await state.audio.resume(); state.sound = true; el.sound.textContent = 'Sonido habilitado ✓'; el.headerSound.textContent = '🔔 Sonido activo'; toast('Las alertas sonoras están habilitadas en este navegador.', 'success'); }
    catch { toast('El navegador bloqueó el audio. Intenta habilitarlo nuevamente.', 'error'); }
  }
  function alertSound(priority) {
    if (!state.sound || !state.audio) return;
    const tones = priority === 'immediate' ? [880, 880, 1046] : priority === 'urgent' ? [740, 740] : [620]; const start = state.audio.currentTime;
    tones.forEach((frequency, index) => { const o = state.audio.createOscillator(); const g = state.audio.createGain(); const at = start + index * .19; o.frequency.value = frequency; o.type = 'sine'; g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(.14, at + .02); g.gain.exponentialRampToValueAtTime(.0001, at + .16); o.connect(g).connect(state.audio.destination); o.start(at); o.stop(at + .17); });
  }

  async function session() {
    const { data: { session: existing }, error } = await state.client.auth.getSession(); if (error) throw error; if (existing) return existing;
    const { data, error: signInError } = await state.client.auth.signInAnonymously(); if (signInError) throw signInError; return data.session;
  }
  async function terminal() {
    const { data, error } = await state.client.rpc('my_terminal_context'); if (error) throw error; state.terminal = data?.[0] || null;
    if (!state.terminal) { el.activation.classList.remove('hidden'); el.shell.classList.add('hidden'); setConnection('Terminal pendiente de activación', 'offline'); return false; }
    el.activation.classList.add('hidden'); el.shell.classList.remove('hidden'); el.room.textContent = state.terminal.room_name; el.terminalLabel.textContent = state.terminal.terminal_label || `Terminal ${state.terminal.room_code}`; el.description.textContent = `Enviando como ${state.terminal.room_name}. Los avisos quedan registrados.`; return true;
  }
  async function rooms() {
    const { data, error } = await state.client.from('rooms').select('id, code, name').eq('active', true).order('name'); if (error) throw error; state.rooms = data || [];
    el.destination.replaceChildren(); if (state.terminal.room_code === 'THALAMUS') el.destination.add(new Option('⚠️ Todas las salas', 'ALL'));
    state.rooms.forEach((room) => el.destination.add(new Option(room.name, room.code)));
    const anotherRoom = state.rooms.find((room) => room.code !== state.terminal.room_code); if (anotherRoom) el.destination.value = anotherRoom.code;
  }
  async function notices() {
    const [noticeResponse, acknowledgementResponse] = await Promise.all([
      state.client.from('notices').select('id, source_terminal_id, source_room_id, destination_room_id, body, priority, status, created_at').order('created_at', { ascending: false }).limit(100),
      state.client.from('notice_acknowledgements').select('notice_id')
    ]);
    if (noticeResponse.error) throw noticeResponse.error; if (acknowledgementResponse.error) throw acknowledgementResponse.error;
    state.notices = noticeResponse.data || []; state.acknowledgements = new Set((acknowledgementResponse.data || []).map((row) => row.notice_id)); renderNotices();
  }
  function refreshSoon() { clearTimeout(state.refreshTimer); state.refreshTimer = setTimeout(() => notices().catch(report), 250); }
  function subscribe() {
    state.channel?.unsubscribe();
    state.channel = state.client.channel(`terminal:${state.terminal.terminal_id}`, { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notices' }, (payload) => { if (payload.eventType === 'INSERT') alertSound(payload.new.priority); refreshSoon(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notice_acknowledgements' }, refreshSoon)
      .subscribe((status) => { if (status === 'SUBSCRIBED') setConnection('Conectado y protegido', 'online'); else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnection('Conexión en recuperación', 'offline'); });
  }
  async function activate(event) {
    event.preventDefault(); activationError(); const code = el.activationCode.value.trim().toUpperCase(); if (!code) return; el.activationSubmit.disabled = true;
    try { const { error } = await state.client.rpc('activate_terminal', { p_code: code }); if (error) throw error; el.activationCode.value = ''; toast('Terminal activado correctamente.', 'success'); await boot(); }
    catch (error) { console.error(error); activationError('No fue posible activar este terminal. Revisa el código o solicita uno nuevo.'); }
    finally { el.activationSubmit.disabled = false; }
  }
  async function send(event) {
    event.preventDefault(); const body = el.message.value.trim(); if (!body) return; el.send.disabled = true;
    try { const { error } = await state.client.rpc('create_notice', { p_destination_code: el.destination.value, p_body: body, p_priority: el.priority.value }); if (error) throw error; el.message.value = ''; await notices(); toast('Aviso enviado y registrado.', 'success'); }
    catch (error) { report(error); } finally { el.send.disabled = false; }
  }
  async function acknowledge(id) { try { const { error } = await state.client.rpc('acknowledge_notice', { p_notice_id: id }); if (error) throw error; await notices(); toast('Recepción confirmada.', 'success'); } catch (error) { report(error); } }
  async function closeNotice(id) { try { const { error } = await state.client.rpc('close_notice', { p_notice_id: id }); if (error) throw error; await notices(); toast('Aviso cerrado.', 'success'); } catch (error) { report(error); } }
  async function boot() { if (!(await terminal())) return; await rooms(); await notices(); subscribe(); setConnection('Conectado y protegido', 'online'); }
  async function start() {
    if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase) { setConnection('Configuración incompleta', 'offline'); toast('Falta configurar Supabase o no se pudo cargar la biblioteca.', 'error'); return; }
    state.client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const storedTheme = (() => { try { return localStorage.getItem('intercom-theme'); } catch { return null; } })();
    setTheme(storedTheme ? storedTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
    el.activationForm.addEventListener('submit', activate); el.form.addEventListener('submit', send); el.refresh.addEventListener('click', () => notices().then(() => toast('Avisos actualizados.', 'success')).catch(report)); el.sound.addEventListener('click', enableSound); el.headerSound.addEventListener('click', enableSound); el.theme?.addEventListener('click', toggleTheme); el.sidebarTheme?.addEventListener('click', toggleTheme);
    document.querySelectorAll('[data-quick-message]').forEach((button) => button.addEventListener('click', () => { el.message.value = button.dataset.quickMessage || ''; el.priority.value = button.dataset.priority || 'urgent'; el.message.focus(); }));
    addEventListener('online', () => boot().catch(report)); addEventListener('offline', () => setConnection('Sin conexión', 'offline'));
    try { setConnection('Autenticando terminal…'); await session(); await boot(); } catch (error) { setConnection('No se pudo conectar', 'offline'); report(error); }
  }
  addEventListener('DOMContentLoaded', start);
})();
