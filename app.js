// ============================================
// 4Lazy — agent-driven architecture
// --------------------------------------------
// The ElevenLabs conversational agent is the brain. When the user talks to
// it, the agent decides what to do and calls one of the tools defined in
// this file (add_calendar_event, send_email, etc.). We execute the tool
// against Google's APIs / localStorage and report the result back over
// the WebSocket, so the agent can confirm to the user in voice.
//
// At the start of each conversation we send the agent a snapshot of the
// user's current state (calendar, contacts, lists) as dynamic_variables,
// which the agent references in its system prompt. That way it can
// disambiguate ("the 2pm meeting or the 4pm meeting?") without having to
// query us.
// ============================================

// ============================================
// CONFIG
// ============================================
const AGENT_ID = 'agent_5901kppjqenze7f9aptbd0jxybvy';

// ============================================
// State
// ============================================
let isConnected = false;
let socket = null;
let audioContext = null;
let mediaStream = null;
let processor = null;
let audioContext2 = null;
let nextPlayTime = 0;

// ============================================
// DOM
// ============================================
const micButton = document.getElementById('micButton');
const transcript = document.getElementById('transcript');
const status = document.getElementById('status');

// ============================================
// Mic button
// ============================================
micButton.addEventListener('click', async () => {
    if (!isConnected) {
        await startConversation();
    } else {
        stopConversation();
    }
});

// ============================================
// Start conversation
// ============================================
async function startConversation() {
    try {
        status.textContent = 'Preparing...';

        // Build the context snapshot we'll hand to the agent as dynamic
        // variables. This is what lets the agent know your calendar and
        // contacts without having to ask us mid-sentence.
        const context = await gatherAgentContext();

        status.textContent = 'Connecting...';
        const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}`;
        socket = new WebSocket(wsUrl);

        socket.onopen = async () => {
            isConnected = true;
            micButton.classList.add('listening');
            micButton.querySelector('.mic-text').textContent = 'Tap to End';
            micButton.querySelector('.mic-icon').textContent = '🔴';
            status.textContent = 'Connected — start talking!';

            socket.send(JSON.stringify({
                type: 'conversation_initiation_client_data',
                dynamic_variables: context,
                conversation_config_override: {
                    turn: {
                        turn_timeout: 10,
                        silence_end_call_timeout: 20
                    }
                }
            }));

            await startAudioStream();
        };

        socket.onmessage = async (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }));
                return;
            }

            if (msg.type === 'user_transcript') {
                const userText = msg.user_transcription_event?.user_transcript;
                if (userText) transcript.textContent = `"${userText}"`;
                return;
            }

            if (msg.type === 'audio') {
                playAudio(msg.audio_event?.audio_base_64);
                return;
            }

            if (msg.type === 'agent_response') {
                const rawReply = msg.agent_response_event?.agent_response || '';
                const agentReply = rawReply.replace(/\[.*?\]/g, '').trim();
                status.textContent = agentReply;

                const endPhrases = ['talk soon', 'take care', 'goodbye', 'bye', 'all set', "you're all set", 'have a great', 'take it easy'];
                const isEnding = endPhrases.some(p => agentReply.toLowerCase().includes(p));
                if (isEnding) setTimeout(() => stopConversation(), 3000);
                return;
            }

            // Agent asking us to run a tool. This is the new core of the app.
            if (msg.type === 'client_tool_call') {
                await handleClientToolCall(msg.client_tool_call || msg);
                return;
            }
        };

        socket.onclose = (event) => {
            console.log('[ElevenLabs] WebSocket closed:', {
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean
            });
            isConnected = false;
            stopAudioStream();
            resetMicButton();
            status.textContent = '';
            updateCardCounts();
        };

        socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            status.textContent = 'Connection failed. Try again.';
            resetMicButton();
            isConnected = false;
        };

    } catch (error) {
        console.error('Connection error:', error);
        status.textContent = 'Could not connect. Try again.';
        resetMicButton();
    }
}

function stopConversation() {
    if (socket) {
        socket.close();
        socket = null;
    }
    stopAudioStream();
    isConnected = false;
    resetMicButton();
}

// ============================================
// Audio input
// ============================================
async function startAudioStream() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcmData = convertToPCM16(inputData);
            const base64 = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
            socket.send(JSON.stringify({ user_audio_chunk: base64 }));
        }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
}

function stopAudioStream() {
    if (processor) { processor.disconnect(); processor = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

function convertToPCM16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        int16Array[i] = Math.max(-32768, Math.min(32767, float32Array[i] * 32768));
    }
    return int16Array;
}

// ============================================
// Audio output
// ============================================
function playAudio(base64Audio) {
    if (!base64Audio) return;
    try {
        if (!audioContext2 || audioContext2.state === 'closed') {
            audioContext2 = new AudioContext();
            nextPlayTime = 0;
        }

        const binary = atob(base64Audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const int16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

        const buffer = audioContext2.createBuffer(1, float32.length, 16000);
        buffer.getChannelData(0).set(float32);

        const source = audioContext2.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext2.destination);

        const currentTime = audioContext2.currentTime;
        if (nextPlayTime < currentTime) nextPlayTime = currentTime;
        source.start(nextPlayTime);
        nextPlayTime += buffer.duration;
    } catch (e) {
        console.error('Audio play error:', e);
    }
}

function resetMicButton() {
    micButton.classList.remove('listening');
    micButton.querySelector('.mic-text').textContent = 'Tap to Speak';
    micButton.querySelector('.mic-icon').textContent = '🎤';
}

// ============================================
// Toast
// ============================================
function showToast(message, kind = 'info') {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `toast show toast-${kind}`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

// ============================================
// Gather context for the agent
// ============================================
async function gatherAgentContext() {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const contacts = loadContacts();
    const contactNamesString = contacts.length
        ? contacts.map(c => c.name).join(', ')
        : 'none yet — the user has no contacts synced';

    // Fetch upcoming events so the agent can disambiguate.
    // Includes the event ID in parentheses so the agent can pass it back
    // to the delete_calendar_event tool when the user asks to cancel.
    const upcomingEvents = await fetchUpcomingEvents();
    const upcomingEventsString = upcomingEvents.length
        ? upcomingEvents.map(e => {
            const when = new Date(e.start).toLocaleString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit'
            });
            return `"${e.summary}" on ${when} (id: ${e.id})`;
        }).join('; ')
        : 'no upcoming events';

    return {
        current_date_time: now.toLocaleString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
        }),
        timezone: timezone,
        contact_names: contactNamesString,
        upcoming_events: upcomingEventsString,
        grocery_list: flattenList('grocery').join(', ') || 'empty',
        todos_list: flattenList('todos').join(', ') || 'empty',
        reminders_list: flattenList('reminders').join(', ') || 'empty',
        notes_list: flattenList('notes').join(', ') || 'empty'
    };
}

async function fetchUpcomingEvents() {
    if (!googleAccessToken) return [];
    try {
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
            + `?timeMin=${encodeURIComponent(timeMin)}`
            + `&timeMax=${encodeURIComponent(timeMax)}`
            + '&singleEvents=true&orderBy=startTime&maxResults=25';
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${googleAccessToken}` }});
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) handleGoogleAuthFailure();
            return [];
        }
        const data = await res.json();
        return (data.items || []).map(e => ({
            id: e.id,
            summary: e.summary || '(no title)',
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date
        }));
    } catch {
        return [];
    }
}

// ============================================
// Client tool dispatcher
// --------------------------------------------
// The agent sends a client_tool_call over the WebSocket. We look up the
// matching function, run it, and send back the result.
// ============================================
async function handleClientToolCall(call) {
    const tool_call_id = call.tool_call_id;
    const tool_name = call.tool_name;
    const parameters = call.parameters || {};

    console.log('[Agent → tool]', tool_name, parameters);

    let result;
    let isError = false;
    try {
        const fn = TOOLS[tool_name];
        if (!fn) throw new Error(`Unknown tool: ${tool_name}`);
        result = await fn(parameters);
        if (result && result.error) isError = true;
    } catch (err) {
        console.error('Tool error:', err);
        result = { error: String(err?.message || err) };
        isError = true;
    }

    console.log('[Tool → agent]', tool_name, result);
    updateCardCounts();

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'client_tool_result',
            tool_call_id,
            result: typeof result === 'string' ? result : JSON.stringify(result),
            is_error: isError
        }));
    }
}

// ============================================
// Tools — the things the agent can actually do
// ============================================
const TOOLS = {
    add_calendar_event,
    list_calendar_events,
    delete_calendar_event,
    add_to_list,
    remove_from_list,
    get_list,
    send_email,
    get_contacts
};

async function add_calendar_event({ summary, start, end, description }) {
    if (!googleAccessToken) return { error: 'Not connected to Google.' };
    if (!summary || !start || !end) return { error: 'summary, start, and end are required.' };

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${googleAccessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            summary,
            description: description || '',
            start: { dateTime: start, timeZone: tz },
            end:   { dateTime: end,   timeZone: tz }
        })
    });

    if (res.ok) {
        const created = await res.json();
        appendToLocalList('calendar', `${summary} — ${formatEventTime(start)}`);
        showToast(`📅 Added "${summary}" to your calendar`, 'success');
        return { success: true, event_id: created.id, summary, start, end };
    }
    if (res.status === 401 || res.status === 403) handleGoogleAuthFailure();
    const err = await res.json().catch(() => ({}));
    return { error: `Google Calendar error (${res.status}): ${err?.error?.message || 'unknown'}` };
}

async function list_calendar_events({ from_date, to_date }) {
    if (!googleAccessToken) return { error: 'Not connected to Google.' };
    const timeMin = from_date || new Date().toISOString();
    const timeMax = to_date || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
        + `?timeMin=${encodeURIComponent(timeMin)}`
        + `&timeMax=${encodeURIComponent(timeMax)}`
        + '&singleEvents=true&orderBy=startTime&maxResults=50';

    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${googleAccessToken}` }});
    if (!res.ok) {
        if (res.status === 401 || res.status === 403) handleGoogleAuthFailure();
        return { error: `Google Calendar error (${res.status})` };
    }
    const data = await res.json();
    const events = (data.items || []).map(e => ({
        id: e.id,
        summary: e.summary || '(no title)',
        start: e.start.dateTime || e.start.date,
        end:   e.end.dateTime   || e.end.date
    }));
    return { events };
}

async function delete_calendar_event({ event_id }) {
    if (!googleAccessToken) return { error: 'Not connected to Google.' };
    if (!event_id) return { error: 'event_id is required.' };

    const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event_id)}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${googleAccessToken}` } }
    );
    if (res.ok || res.status === 204) {
        showToast('🗑️ Event removed from your calendar', 'success');
        return { success: true, event_id };
    }
    if (res.status === 401 || res.status === 403) handleGoogleAuthFailure();
    return { error: `Google Calendar delete error (${res.status})` };
}

function add_to_list({ list_name, items }) {
    const valid = ['grocery', 'todos', 'reminders', 'notes'];
    if (!valid.includes(list_name)) return { error: `list_name must be one of: ${valid.join(', ')}` };

    // Accept either an array of strings or a comma-separated string —
    // ElevenLabs' schema validator makes array params painful, so the
    // tool definition uses a CSV string. The app normalizes here.
    const itemList = normalizeItemsInput(items);
    if (itemList.length === 0) return { error: 'items must be a non-empty list (comma-separated string or array).' };

    const date = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
    });
    const existing = JSON.parse(localStorage.getItem(`4lazy-${list_name}`) || '[]');
    existing.unshift({
        items: itemList,
        date: date,
        timestamp: new Date().toISOString()
    });
    localStorage.setItem(`4lazy-${list_name}`, JSON.stringify(existing));

    showToast(`Added ${itemList.length} item${itemList.length === 1 ? '' : 's'} to ${list_name}`, 'success');
    return { success: true, added: itemList };
}

function remove_from_list({ list_name, items }) {
    const valid = ['grocery', 'todos', 'reminders', 'notes'];
    if (!valid.includes(list_name)) return { error: `list_name must be one of: ${valid.join(', ')}` };

    const itemList = normalizeItemsInput(items);
    if (itemList.length === 0) return { error: 'items must be a non-empty list (comma-separated string or array).' };

    const existing = JSON.parse(localStorage.getItem(`4lazy-${list_name}`) || '[]');
    const removed = [];

    itemList.forEach(itemToDelete => {
        const term = String(itemToDelete).toLowerCase();
        existing.forEach(entry => {
            entry.items = entry.items.filter(item => {
                const match = item.toLowerCase().includes(term);
                if (match) removed.push(item);
                return !match;
            });
        });
    });

    const cleaned = existing.filter(entry => entry.items.length > 0);
    localStorage.setItem(`4lazy-${list_name}`, JSON.stringify(cleaned));

    if (removed.length > 0) {
        showToast(`Removed ${removed.length} item${removed.length === 1 ? '' : 's'} from ${list_name}`, 'success');
    }
    return { success: true, removed };
}

function get_list({ list_name }) {
    const valid = ['grocery', 'todos', 'reminders', 'notes'];
    if (!valid.includes(list_name)) return { error: `list_name must be one of: ${valid.join(', ')}` };
    return { list_name, items: flattenList(list_name) };
}

async function send_email({ contact_name, subject, body }) {
    if (!googleAccessToken) return { error: 'Not connected to Google.' };
    if (!contact_name || !body) return { error: 'contact_name and body are required.' };

    const contacts = loadContacts();
    const nameLower = String(contact_name).toLowerCase().trim();
    const contact = contacts.find(c => c.name && c.name.toLowerCase() === nameLower)
                 || contacts.find(c => c.name && c.name.toLowerCase().includes(nameLower));

    if (!contact) return { error: `No contact named "${contact_name}" in your Google Contacts.` };
    if (!contact.emails || contact.emails.length === 0) return { error: `${contact.name} has no email on file.` };

    const to = contact.emails[0];
    const finalSubject = subject || 'A quick note';

    const mime =
        `To: ${to}\r\n` +
        `Subject: ${finalSubject}\r\n` +
        `Content-Type: text/plain; charset="UTF-8"\r\n` +
        `MIME-Version: 1.0\r\n` +
        `\r\n` +
        body;

    const raw = btoa(unescape(encodeURIComponent(mime)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${googleAccessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw })
    });

    if (res.ok) {
        showToast(`📧 Email sent to ${to}`, 'success');
        return { success: true, to, subject: finalSubject };
    }
    if (res.status === 401 || res.status === 403) handleGoogleAuthFailure();
    const err = await res.json().catch(() => ({}));
    return { error: `Gmail error (${res.status}): ${err?.error?.message || 'unknown'}` };
}

function get_contacts() {
    const contacts = loadContacts();
    return {
        contacts: contacts.map(c => ({
            name: c.name,
            email: c.emails[0] || null,
            phone: c.phones[0] || null
        }))
    };
}

// ============================================
// Helpers
// ============================================

// Accept either an array of strings OR a comma-separated string, return a
// clean array of non-empty trimmed strings. Centralised so add_to_list
// and remove_from_list can share the logic.
function normalizeItemsInput(items) {
    if (Array.isArray(items)) {
        return items.map(s => String(s).trim()).filter(Boolean);
    }
    if (typeof items === 'string') {
        return items.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
}

function flattenList(cat) {
    const data = JSON.parse(localStorage.getItem(`4lazy-${cat}`) || '[]');
    return data.flatMap(entry => entry.items || []);
}

function appendToLocalList(cat, item) {
    const date = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
    });
    const existing = JSON.parse(localStorage.getItem(`4lazy-${cat}`) || '[]');
    existing.unshift({
        items: [item],
        date: date,
        timestamp: new Date().toISOString()
    });
    localStorage.setItem(`4lazy-${cat}`, JSON.stringify(existing));
}

function loadContacts() {
    return JSON.parse(localStorage.getItem('4lazy-contacts') || '[]');
}

function formatEventTime(isoLocal) {
    try {
        const d = new Date(isoLocal);
        return d.toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
    } catch {
        return isoLocal;
    }
}

// ============================================
// Home page card counters
// ============================================
function updateCardCounts() {
    const categories = {
        calendar:  { id: 'count-calendar',  label: 'event' },
        grocery:   { id: 'count-grocery',   label: 'item' },
        reminders: { id: 'count-reminders', label: 'reminder' },
        todos:     { id: 'count-todos',     label: 'task' },
        notes:     { id: 'count-notes',     label: 'note' },
        contacts:  { id: 'count-contacts',  label: 'contact' }
    };
    Object.entries(categories).forEach(([cat, config]) => {
        const el = document.getElementById(config.id);
        if (!el) return;
        let total;
        if (cat === 'contacts') {
            total = loadContacts().length;
        } else {
            const data = JSON.parse(localStorage.getItem(`4lazy-${cat}`) || '[]');
            total = data.reduce((sum, entry) => sum + entry.items.length, 0);
        }
        el.textContent = `${total} ${config.label}${total !== 1 ? 's' : ''}`;
        if (total > 0) {
            const card = document.getElementById(`card-${cat}`);
            if (card) card.classList.add('updated');
        }
    });
}
updateCardCounts();

// ============================================
// Google OAuth — Calendar + Gmail + Contacts
// ============================================
const GOOGLE_CLIENT_ID = '190557855577-8ou5v1n1crdf842sbbuif07n0hsf1tsd.apps.googleusercontent.com';
const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/contacts.readonly'
].join(' ');

let googleAccessToken = null;
let googleTokenClient = null;

function setGoogleConnectedUI(connected) {
    const btn = document.getElementById('googleSignInBtn');
    const statusEl = document.getElementById('googleStatus');
    if (!btn || !statusEl) return;
    if (connected) {
        btn.textContent = '✅ Google Connected';
        btn.classList.add('connected');
        statusEl.textContent = 'Calendar, Gmail, and Contacts are linked.';
    } else {
        btn.textContent = '📅 Connect Google';
        btn.classList.remove('connected');
        statusEl.textContent = '';
    }
}

window.addEventListener('load', () => {
    if (typeof google === 'undefined') return;

    googleTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        callback: (response) => {
            if (response.access_token) {
                googleAccessToken = response.access_token;
                localStorage.setItem('google_access_token', response.access_token);
                setGoogleConnectedUI(true);
                syncGoogleContacts().catch(err => console.error('Contacts sync failed:', err));
            }
        }
    });

    const savedToken = localStorage.getItem('google_access_token');
    if (savedToken) {
        googleAccessToken = savedToken;
        setGoogleConnectedUI(true);
    }
});

function handleGoogleAuthFailure() {
    googleAccessToken = null;
    localStorage.removeItem('google_access_token');
    setGoogleConnectedUI(false);
    showToast('Google session expired. Tap "Connect Google" to re-link.', 'error');
}

const googleBtn = document.getElementById('googleSignInBtn');
if (googleBtn) {
    googleBtn.addEventListener('click', () => {
        if (!googleAccessToken) {
            googleTokenClient.requestAccessToken({ prompt: 'consent' });
        } else {
            googleAccessToken = null;
            localStorage.removeItem('google_access_token');
            setGoogleConnectedUI(false);
        }
    });
}

// ============================================
// Google Contacts sync (People API)
// ============================================
async function syncGoogleContacts() {
    if (!googleAccessToken) return;
    try {
        const url = 'https://people.googleapis.com/v1/people/me/connections'
            + '?personFields=names,emailAddresses,phoneNumbers'
            + '&pageSize=500';
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${googleAccessToken}` }});
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) handleGoogleAuthFailure();
            return;
        }
        const data = await res.json();
        const contacts = (data.connections || []).map(p => ({
            name: p.names?.[0]?.displayName || '',
            emails: (p.emailAddresses || []).map(e => e.value).filter(Boolean),
            phones: (p.phoneNumbers || []).map(p => p.value).filter(Boolean)
        })).filter(c => c.name && (c.emails.length > 0 || c.phones.length > 0));
        localStorage.setItem('4lazy-contacts', JSON.stringify(contacts));
        updateCardCounts();
    } catch (err) {
        console.error('Contacts sync error:', err);
    }
}

window.syncGoogleContacts = syncGoogleContacts;
