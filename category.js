// Get category from URL
const page = window.location.pathname.split('/').pop().replace('.html', '');

const config = {
    'calendar': { icon: '📅', title: 'Calendar', label: 'event' },
    'grocery': { icon: '🛒', title: 'Grocery', label: 'item' },
    'reminders': { icon: '🔔', title: 'Reminders', label: 'reminder' },
    'todos': { icon: '✅', title: 'To-Dos', label: 'task' },
    'notes': { icon: '📝', title: 'Notes', label: 'note' }
};

const current = config[page];

// Set page header
document.getElementById('pageIcon').textContent = current.icon;
document.getElementById('pageTitle').textContent = current.title;

// Load data
const data = JSON.parse(localStorage.getItem(`4lazy-${page}`) || '[]');
const container = document.getElementById('entriesContainer');

if (data.length === 0) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-icon">${current.icon}</div>
            <p>No ${current.label}s yet.<br>Tap the mic on the home screen to add some!</p>
        </div>`;
} else {
    // Group by date
    const grouped = {};
    data.forEach(entry => {
        if (!grouped[entry.date]) grouped[entry.date] = [];
        grouped[entry.date].push(...entry.items);
    });

    // Today's label
    const today = new Date().toLocaleDateString('en-US', { 
        weekday: 'long', month: 'long', day: 'numeric' 
    });

    Object.entries(grouped).forEach(([date, items]) => {
        const isToday = date === today;
        const section = document.createElement('div');
        section.innerHTML = `
            <div class="section-title">${isToday ? '📍 Today' : date}</div>
            <div class="entry-card">
                ${items.map(item => `
                    <div class="entry-item">
                        <span>${item}</span>
                    </div>`).join('')}
            </div>`;
        container.appendChild(section);
    });
}