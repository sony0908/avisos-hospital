(() => {
  'use strict';
  const config = window.APP_CONFIG || {};
  const $ = (selector) => document.querySelector(selector);
  const state = { client: null, terminal: null, rooms: [], notices: [], acknowledgements: new Set(), templates: [], channel: null, sound: false, audio: null, refreshTimer: null, pairingCode: null, pairingTimer: null, pairingRefreshTimer: null, terminalWatchTimer: null };
  const el = {
    shell: $('#app-shell'), activation: $('#activation-modal'), activationError: $('#activation-error'), pairingQr: $('#pairing-qr'), pairingExpiry: $('#pairing-expiry'), pairingRefresh: $('#pairing-refresh'),
    room: $('#terminal-room'), terminalLabel: $('#terminal-label'), title: $('#terminal-title'), description: $('#room-description'), destination: $('#notice-destination'), message: $('#notice-message'), priority: $('#notice-priority'), form: $('#notice-form'), send: $('#send-button'), list: $('#notice-list'),
    dot: $('#connection-dot'), connection: $('#connection-status'), refresh: $('#refresh-button'), sound: $('#sound-button'), headerSound: $('#header-sound-button'), theme: $('#theme-toggle'), sidebarTheme: $('#sidebar-theme-toggle'), themeIcon: $('#theme-icon'), themeLabel: $('#theme-label'), fourthCountdown: $('#fourth-countdown'), fourthLabel: $('#fourth-label'), diurnalCountdown: $('#diurnal-countdown'), diurnalLabel: $('#diurnal-label'), roomList: $('#room-list'), roomCount: $('#room-count'), destinationBanner: $('#destination-banner'), destinationName: $('#destination-name'), customTemplates: $('#custom-templates'), addTemplate: $('#add-template-button'), templateModal: $('#template-modal'), templateForm: $('#template-form'), templateEmoji: $('#template-emoji'), templateLabel: $('#template-label'), templateMessage: $('#template-message'), templatePriority: $('#template-priority'), templateCancel: $('#template-cancel'), toast: $('#toast')
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
  const dateKey = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const dateAt = (date, hour) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0);
  function easterSunday(year) {
    const a = year % 19; const b = Math.floor(year / 100); const c = year % 100; const d = Math.floor(b / 4); const e = b % 4;
    const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
    return new Date(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, (h + l - 7 * m + 114) % 31 + 1);
  }
  function chileHolidays(year) {
    const fixed = [[0, 1], [4, 1], [4, 21], [5, 21], [5, 29], [6, 16], [7, 15], [8, 18], [8, 19], [9, 12], [10, 1], [11, 8], [11, 25]];
    const holidays = new Set(fixed.map(([month, day]) => dateKey(new Date(year, month, day))));
    const easter = easterSunday(year); [-2, -1].forEach((offset) => { const day = new Date(easter); day.setDate(day.getDate() + offset); holidays.add(dateKey(day)); });
    const reformation = new Date(year, 9, 31);
    if (reformation.getDay() === 2) holidays.add(dateKey(new Date(year, 9, 27)));
    else if (reformation.getDay() === 3) holidays.add(dateKey(new Date(year, 10, 2)));
    else holidays.add(dateKey(reformation));
    return holidays;
  }
  const isHoliday = (date) => chileHolidays(date.getFullYear()).has(dateKey(date));
  const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;
  function fourthTurnTarget(now) {
    const dayStart = dateAt(now, isWeekend(now) || isHoliday(now) ? 9 : 8); const twenty = dateAt(now, 20);
    if (now < dayStart) return { label: 'Fin noche', target: dayStart };
    if (now < twenty) return { label: 'Fin largo', target: twenty };
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { label: 'Fin noche', target: dateAt(tomorrow, isWeekend(tomorrow) || isHoliday(tomorrow) ? 9 : 8) };
  }
  function nextDiurnalStart(now) {
    for (let offset = 0; offset <= 14; offset += 1) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      if (isWeekend(day) || isHoliday(day)) continue;
      const start = dateAt(day, 8);
      if (start > now) return start;
    }
    return dateAt(now, 8);
  }
  function diurnalTarget(now) {
    if (!isWeekend(now) && !isHoliday(now)) {
      const start = dateAt(now, 8); const end = dateAt(now, now.getDay() === 5 ? 16 : 17);
      if (now < start) return { label: 'Inicio jornada', target: start };
      if (now < end) return { label: 'Fin jornada', target: end };
    }
    return { label: 'Próxima jornada', target: nextDiurnalStart(now) };
  }
  function renderCountdown(countdown, label, schedule) {
    if (!countdown || !label) return;
    const remaining = Math.max(0, schedule.target.getTime() - Date.now()); const hours = Math.floor(remaining / 3600000); const minutes = Math.floor((remaining % 3600000) / 60000); const seconds = Math.floor((remaining % 60000) / 1000);
    label.textContent = schedule.label; countdown.dateTime = schedule.target.toISOString(); countdown.textContent = [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }
  function updateShiftCountdowns() { const now = new Date(); renderCountdown(el.fourthCountdown, el.fourthLabel, fourthTurnTarget(now)); renderCountdown(el.diurnalCountdown, el.diurnalLabel, diurnalTarget(now)); }
  function startShiftCountdowns() { updateShiftCountdowns(); setInterval(updateShiftCountdowns, 1000); }
  const templateStorageKey = () => state.terminal ? `intercom-templates:${state.terminal.room_code}` : null;
  function loadTemplates() {
    state.templates = [];
    try { const saved = JSON.parse(localStorage.getItem(templateStorageKey()) || '[]'); if (Array.isArray(saved)) state.templates = saved.filter((template) => template && typeof template.body === 'string' && typeof template.label === 'string').slice(0, 30); }
    catch { /* Una configuración local dañada no debe bloquear el canal. */ }
  }
  function saveTemplates() {
    try { localStorage.setItem(templateStorageKey(), JSON.stringify(state.templates)); return true; }
    catch { toast('No se pudo guardar la plantilla en este navegador.', 'error'); return false; }
  }
  function useTemplate(template) { el.message.value = template.body; el.priority.value = template.priority || 'urgent'; el.message.focus(); }
  function renderCustomTemplates() {
    if (!el.customTemplates) return;
    el.customTemplates.replaceChildren();
    state.templates.forEach((template) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quick'; button.textContent = `${template.emoji || '📌'} ${template.label}`;
      button.addEventListener('click', () => useTemplate(template)); el.customTemplates.append(button);
    });
  }
  function openTemplateModal() { el.templateForm.reset(); el.templatePriority.value = 'urgent'; el.templateModal.classList.remove('hidden'); el.templateEmoji.focus(); }
  function closeTemplateModal() { el.templateModal.classList.add('hidden'); }
  function addTemplate(event) {
    event.preventDefault();
    const label = el.templateLabel.value.trim(); const body = el.templateMessage.value.trim();
    if (!label || !body) return;
    state.templates.push({ id: window.crypto?.randomUUID?.() || String(Date.now()), emoji: el.templateEmoji.value.trim() || '📌', label, body, priority: el.templatePriority.value });
    if (saveTemplates()) { renderCustomTemplates(); closeTemplateModal(); toast('Plantilla guardada para esta sala en este navegador.', 'success'); }
  }
  function updateDestinationSelection() {
    const code = el.destination.value; const room = state.rooms.find((item) => item.code === code);
    if (el.destinationName) el.destinationName.textContent = code === 'ALL' ? 'Todas las salas' : room?.name || 'Selecciona una sala';
    document.querySelectorAll('.room-item').forEach((row) => {
      const selected = row.dataset.roomCode === code; row.classList.toggle('selected', selected); row.setAttribute('aria-pressed', String(selected));
    });
  }
  function renderRoomList() {
    if (!el.roomList || !el.roomCount) return;
    el.roomCount.textContent = `${state.rooms.length} sala${state.rooms.length === 1 ? '' : 's'} registrada${state.rooms.length === 1 ? '' : 's'}`;
    el.roomList.replaceChildren();
    const addRoom = (room, detail) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'room-item'; row.dataset.roomCode = room.code; row.title = `Seleccionar ${room.name} como destino`;
      const main = document.createElement('span'); main.className = 'room-item-main'; const symbol = document.createElement('span'); symbol.className = 'room-symbol'; symbol.textContent = '◈';
      const copy = document.createElement('span'); const name = document.createElement('strong'); name.textContent = room.name; const subtitle = document.createElement('small'); subtitle.textContent = detail;
      copy.append(name, subtitle); main.append(symbol, copy); row.append(main); row.addEventListener('click', () => { el.destination.value = room.code; updateDestinationSelection(); toast(`Destino seleccionado: ${room.name}.`, 'success'); }); el.roomList.append(row);
    };
    if (state.terminal.room_code === 'THALAMUS') addRoom({ code: 'ALL', name: 'Todas las salas' }, 'Envío general');
    state.rooms.forEach((room) => addRoom(room, room.code === state.terminal.room_code ? 'Esta terminal' : 'Sala registrada'));
    updateDestinationSelection();
  }
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
  function stopPairingMonitor() { clearInterval(state.pairingTimer); clearTimeout(state.pairingRefreshTimer); state.pairingTimer = null; state.pairingRefreshTimer = null; state.pairingCode = null; }
  function startPairingMonitor() {
    if (state.pairingTimer) return;
    state.pairingTimer = setInterval(async () => {
      try {
        const { data, error } = await state.client.rpc('my_terminal_context'); if (error) throw error;
        if (data?.[0]) { stopPairingMonitor(); await boot(); }
      } catch (error) { console.error(error); }
    }, 3000);
  }
  function startTerminalWatch() {
    if (state.terminalWatchTimer) return;
    state.terminalWatchTimer = setInterval(async () => {
      try {
        const { data, error } = await state.client.rpc('my_terminal_context');
        if (error) throw error;
        if (state.terminal && !data?.[0]) {
          state.channel?.unsubscribe(); state.channel = null; state.terminal = null;
          await boot();
        }
      } catch (error) { console.error(error); }
    }, 15000);
  }
  async function requestPairing() {
    el.pairingRefresh.disabled = true; activationError(); el.pairingExpiry.textContent = 'Generando QR seguro…';
    try {
      const { data, error } = await state.client.rpc('request_terminal_pairing'); if (error) throw error;
      const pairing = data?.[0]; if (!pairing?.pairing_code) throw new Error('No fue posible generar el QR.');
      state.pairingCode = pairing.pairing_code; el.pairingQr.replaceChildren();
      if (!window.QRCode) throw new Error('No se pudo cargar el generador QR. Recarga la página.');
      new window.QRCode(el.pairingQr, { text: pairing.pairing_code, width: 250, height: 250, correctLevel: window.QRCode.CorrectLevel.M });
      const expires = new Date(pairing.expires_at); el.pairingExpiry.textContent = `QR válido hasta las ${new Intl.DateTimeFormat('es-CL', { timeStyle: 'short' }).format(expires)}. Se actualizará automáticamente.`;
      clearTimeout(state.pairingRefreshTimer); state.pairingRefreshTimer = setTimeout(() => requestPairing().catch(report), Math.max(1000, expires.getTime() - Date.now() - 20000));
      startPairingMonitor();
    } catch (error) { console.error(error); activationError(error?.message || 'No fue posible generar el QR. Comprueba la conexión y vuelve a intentarlo.'); el.pairingExpiry.textContent = 'QR no disponible.'; }
    finally { el.pairingRefresh.disabled = false; }
  }
  async function terminal() {
    const { data, error } = await state.client.rpc('my_terminal_context'); if (error) throw error; state.terminal = data?.[0] || null;
    if (!state.terminal) { el.activation.classList.remove('hidden'); el.shell.classList.add('hidden'); setConnection('Terminal pendiente de asignación', 'offline'); if (!state.pairingCode) await requestPairing(); return false; }
    stopPairingMonitor(); startTerminalWatch();
    el.activation.classList.add('hidden'); el.shell.classList.remove('hidden'); el.room.textContent = state.terminal.room_name; el.terminalLabel.textContent = state.terminal.terminal_label || `Terminal ${state.terminal.room_code}`; el.title.textContent = state.terminal.room_name; el.description.textContent = `Enviando como ${state.terminal.room_name}. Los avisos quedan registrados.`; loadTemplates(); renderCustomTemplates(); return true;
  }
  async function rooms() {
    const { data, error } = await state.client.from('rooms').select('id, code, name').eq('active', true).order('name'); if (error) throw error; state.rooms = data || [];
    el.destination.replaceChildren(); if (state.terminal.room_code === 'THALAMUS') el.destination.add(new Option('⚠️ Todas las salas', 'ALL'));
    state.rooms.forEach((room) => el.destination.add(new Option(room.name, room.code)));
    const anotherRoom = state.rooms.find((room) => room.code !== state.terminal.room_code); if (anotherRoom) el.destination.value = anotherRoom.code;
    renderRoomList();
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
    startShiftCountdowns();
    el.pairingRefresh.addEventListener('click', () => requestPairing()); el.form.addEventListener('submit', send); el.refresh.addEventListener('click', () => notices().then(() => toast('Avisos actualizados.', 'success')).catch(report)); el.sound.addEventListener('click', enableSound); el.headerSound.addEventListener('click', enableSound); el.theme?.addEventListener('click', toggleTheme); el.sidebarTheme?.addEventListener('click', toggleTheme);
    el.addTemplate.addEventListener('click', openTemplateModal); el.templateCancel.addEventListener('click', closeTemplateModal); el.templateForm.addEventListener('submit', addTemplate);
    el.destination.addEventListener('change', updateDestinationSelection);
    document.querySelectorAll('[data-quick-message]').forEach((button) => button.addEventListener('click', () => { el.message.value = button.dataset.quickMessage || ''; el.priority.value = button.dataset.priority || 'urgent'; el.message.focus(); }));
    addEventListener('online', () => boot().catch(report)); addEventListener('offline', () => setConnection('Sin conexión', 'offline'));
    try { setConnection('Autenticando terminal…'); await session(); await boot(); } catch (error) { setConnection('No se pudo conectar', 'offline'); report(error); }
  }
  addEventListener('DOMContentLoaded', start);
})();
