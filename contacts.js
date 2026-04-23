// ============================================
// Contacts page
// --------------------------------------------
// Reads the 4lazy-contacts cache from localStorage and renders a list.
// The cache is populated by app.js :: syncGoogleContacts() which hits the
// People API using the Google OAuth token stored in localStorage.
// ============================================

const GOOGLE_CLIENT_ID = '190557855577-8ou5v1n1crdf842sbbuif07n0hsf1tsd.apps.googleusercontent.com';
const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/contacts.readonly'
].join(' ');

const container = document.getElementById('contactsContainer');
const statusEl = document.getElementById('contactsStatus');
const refreshBtn = document.getElementById('refreshContactsBtn');

function loadContacts() {
    return JSON.parse(localStorage.getItem('4lazy-contacts') || '[]');
}

function render() {
    const contacts = loadContacts();
    if (contacts.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">👥</div>
                <p>No contacts synced yet.<br>Tap "Sync from Google" to pull from Google Contacts.</p>
            </div>`;
        return;
    }

    // Sort alphabetically by name for stable display
    contacts.sort((a, b) => a.name.localeCompare(b.name));

    const section = document.createElement('div');
    section.innerHTML = `
        <div class="section-title">📍 ${contacts.length} contact${contacts.length !== 1 ? 's' : ''}</div>
        <div class="entry-card">
            ${contacts.map(c => `
                <div class="entry-item contact-row">
                    <div class="contact-name">${escapeHtml(c.name)}</div>
                    ${c.emails[0] ? `<div class="contact-meta">📧 ${escapeHtml(c.emails[0])}</div>` : ''}
                    ${c.phones[0] ? `<div class="contact-meta">📱 ${escapeHtml(c.phones[0])}</div>` : ''}
                </div>
            `).join('')}
        </div>`;
    container.innerHTML = '';
    container.appendChild(section);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ============================================
// Manual refresh (also used the first time a user opens this page
// before they've ever connected Google)
// ============================================
let tokenClient = null;
window.addEventListener('load', () => {
    if (typeof google !== 'undefined') {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: GOOGLE_SCOPES,
            callback: async (response) => {
                if (response.access_token) {
                    localStorage.setItem('google_access_token', response.access_token);
                    statusEl.textContent = 'Syncing…';
                    await doSync();
                }
            }
        });
    }
});

refreshBtn.addEventListener('click', async () => {
    const token = localStorage.getItem('google_access_token');
    if (!token) {
        if (!tokenClient) {
            statusEl.textContent = 'Google auth still loading. Try again in a moment.';
            return;
        }
        tokenClient.requestAccessToken();
        return;
    }
    statusEl.textContent = 'Syncing…';
    await doSync();
});

async function doSync() {
    const token = localStorage.getItem('google_access_token');
    if (!token) return;
    try {
        const url = 'https://people.googleapis.com/v1/people/me/connections'
            + '?personFields=names,emailAddresses,phoneNumbers'
            + '&pageSize=500';
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                localStorage.removeItem('google_access_token');
                statusEl.textContent = 'Google session expired. Click sync again to re-link.';
                return;
            }
            statusEl.textContent = `Sync failed (${res.status}).`;
            return;
        }
        const data = await res.json();
        const contacts = (data.connections || []).map(p => ({
            name: p.names?.[0]?.displayName || '',
            emails: (p.emailAddresses || []).map(e => e.value).filter(Boolean),
            phones: (p.phoneNumbers || []).map(p => p.value).filter(Boolean)
        })).filter(c => c.name && (c.emails.length > 0 || c.phones.length > 0));
        localStorage.setItem('4lazy-contacts', JSON.stringify(contacts));
        statusEl.textContent = `Synced ${contacts.length} contact${contacts.length !== 1 ? 's' : ''}.`;
        render();
    } catch (err) {
        console.error('Sync error:', err);
        statusEl.textContent = 'Sync failed. Check console.';
    }
}

render();
