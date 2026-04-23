# 4Lazy

Voice assistant app. The ElevenLabs conversational AI agent is the brain — it listens, decides what to do, and calls tools in the app to actually do things (create calendar events, send emails, manage lists).

## Architecture at a glance

```
[ browser mic ] ─audio─▶ [ ElevenLabs agent ] ─audio─▶ [ browser speaker ]
                               │ ▲
                               │ │ tool calls / results
                               ▼ │
                          [ app.js ] ───▶ Google Calendar / Gmail / People APIs
                                    \──▶ localStorage (lists)
```

The agent reasons about the user's request. When it wants to perform an action, it calls one of the tools defined in `app.js`. The app runs the tool, returns a result, and the agent acknowledges to the user in voice.

Claude is **not** used at runtime. (It was earlier; it's been removed in favor of the agent-driven architecture.)

## What's in the folder

```
voice-assistant-app/
├── index.html        # home page (mic + category cards + Connect Google)
├── app.js            # WebSocket, tool dispatcher, all tool implementations
├── styles.css
├── category.js       # shared page logic for calendar/grocery/etc detail views
├── calendar.html, grocery.html, reminders.html, todos.html, notes.html
├── contacts.html     # list of Google Contacts
├── contacts.js       # People API sync
├── server/           # DEPRECATED — was used for Claude intent parsing
│                     # Kept around in case you want a text-input fallback.
└── README.md
```

## Tools the agent can call

| Tool name | What it does |
|---|---|
| `add_calendar_event` | Create a new Google Calendar event |
| `list_calendar_events` | Fetch upcoming events (useful for disambiguation) |
| `delete_calendar_event` | Delete one event by its Google event ID |
| `add_to_list` | Add items to grocery/todos/reminders/notes |
| `remove_from_list` | Remove items from a list (fuzzy match) |
| `get_list` | Read current items from a list |
| `send_email` | Send an email via Gmail to a contact (by name) |
| `get_contacts` | Read the synced contacts (names and emails) |

The agent also receives a snapshot of current state as **dynamic variables** at the start of every conversation: current date/time, timezone, contact names, upcoming events (with IDs), and each list's contents. This is so the agent can answer clarifying questions without extra round trips.

## One-time setup

### 1. Google Cloud Console — enable the APIs

The OAuth client needs three APIs enabled on its project:

1. Go to https://console.cloud.google.com/apis/library
2. Enable **Google Calendar API**
3. Enable **Gmail API**
4. Enable **People API**
5. Under **APIs & Services → OAuth consent screen → Scopes** (or the new "Data Access" panel), add these scopes if they're not already there:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/contacts.readonly`
6. If the app is in Testing mode, add your Google account to the test users list.

### 2. ElevenLabs agent — tools and system prompt

The agent's dashboard at https://elevenlabs.io/app/conversational-ai needs:

- Each of the 8 tools from the table above defined as a **client tool** with the correct parameter schema (see the companion setup doc or ask for the schemas).
- A system prompt that references the dynamic variables (e.g. `{{current_date_time}}`, `{{upcoming_events}}`) and describes when to call each tool.
- An underlying LLM that handles tool use well (GPT-4o, Claude Sonnet, Gemini — any of the tool-capable models in the ElevenLabs dashboard).

### 3. Run the frontend

No backend is needed anymore. Serve the folder with any static server:

```bash
cd ~/Documents/voice-assistant-app
python3 -m http.server 5500
```

Then open http://localhost:5500.

## Using the app

1. Click **Connect Google** on the home page. Approve Calendar, Gmail, and Contacts.
2. Your contacts sync automatically.
3. Tap the mic and talk to the agent. It'll use the tools to do what you ask:
   - "I have a dentist appointment Tuesday at 3pm for half an hour." → agent creates the event.
   - "Send my grocery list to Mom." → agent pulls the list, sends via Gmail.
   - "Cancel my 2pm meeting." → agent looks at upcoming events, identifies the right one by ID, deletes it.

## Known limitations

- **Email only — no SMS.** All messaging goes via Gmail. Twilio was intentionally skipped to avoid paid phone numbers.
- **Contact matching is by name only.** If you have two Sarahs, the agent might ask which one (if the system prompt tells it to) or pick the first match.
- **Google OAuth token lives in localStorage.** Standard for client-side Google apps. Tokens last ~1 hour; the app clears expired tokens automatically and prompts you to reconnect.
