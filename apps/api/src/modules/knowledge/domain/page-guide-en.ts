import { block, type GuidePage, ol, p, page, ul } from './page-guide-kit.js'

/**
 * Краткое руководство на английском (вопрос N88): те же страницы и блоки, что в
 * `page-guide.ts`, в том же порядке. Подписи кнопок — дословно из словаря `en`
 * (значение того же ключа, что и русская подпись). Правя русское руководство,
 * поправьте и эту страницу.
 */

/** Корневая страница: вступление и оглавление. */
export const GUIDE_ROOT_EN = page(
  'How to work in the KChS Portal',
  block(
    'What this is',
    p(
      'A short guide to the platform: where things are and how to do the main tasks. ',
      'The full version, in Russian, is in the project documentation, folder docs/06-guides.',
    ),
    p(
      'Button labels here are given exactly as they appear in the interface. ',
      'If a page differs from what you see on the screen, the screen is right — ',
      'let the page owner know.',
    ),
  ),
  block(
    'Contents',
    ul(
      'First sign-in and the workspace',
      'My day and Inbox',
      'Files and folders',
      'Data and dashboards',
      'Maps',
      'Documents',
      'Assignments and control',
      'Calendar, meetings and chats',
      'Knowledge base and data forms',
      'Profile, notifications and assistant',
    ),
    p('The pages are nested under this one — you can see them in the tree on the left.'),
  ),
  block(
    'If something does not work',
    ul(
      'A section is missing from the rail — the feature is turned off for the whole installation, or you do not have the rights.',
      'A button is missing — your access level to the object is not enough; ask the owner or the space administrator.',
      '“No access” on an object — open “Share” → the shield icon: it explains why you have access or not.',
    ),
  ),
)

/** Вложенные страницы по порядку — как в русском руководстве. */
export const GUIDE_PAGES_EN: readonly GuidePage[] = [
  page(
    'First sign-in and the workspace',
    block(
      'Signing in',
      ol(
        'Enter “Login or email” and “Password”, then press “Sign in”.',
        'If two-factor authentication is on, enter the six-digit “Code” from your authenticator app and press “Confirm”. No phone at hand — enter a recovery code in the same field.',
        'Signed in with a temporary password — the system will ask you to “Set your own password” (at least 12 characters).',
      ),
      p(
        'The “Sign in with corporate account” and “Sign in with a passkey” buttons ',
        'appear only if that method is set up in your organization.',
      ),
    ),
    block(
      'What the screen is made of',
      ul(
        'The rail on the left: “My day”, “Data”, “Maps”, “Documents”, “Files”, “Tasks”, “Chats”, “Meetings”, “Knowledge”, “Calendar”; at the bottom — “Search”, “Inbox”, “Notifications”, “Assistant”, “Settings”.',
        'The navigator: “Favorites”, “Spaces”, “Recent”, the “New space” button and the trash.',
        'Tabs: everything opens in tabs; the tab menu has “Pin”, “Open in split”, “Close others”.',
        'The context panel on the right: “Info”, “Links”, “Discussion”, “Activity”, “Assistant”.',
        'The command palette on ⌘K: objects, spaces and commands, including “Data forms”, “Alerts”, “Territories”, “Trash”.',
      ),
    ),
    block(
      'Keyboard shortcuts',
      ul(
        '⌘K — command palette, ⌘B — navigator, ⌘. — context panel',
        '⌘T — new tab, ⌘W — close, ⌘⇧T — reopen closed tab, ⌘\\ — split pane',
        'G H — “My day”, G I — “Inbox”, G F — “Files”',
        'Shift+? — the full cheat sheet',
      ),
      p('Shortcuts match physical keys, so any keyboard layout works.'),
    ),
    block(
      'Back to where you left off',
      p(
        'Your set of tabs is saved automatically and restored at your next sign-in. ',
        'To save a layout under a name, open the “Workspaces” menu → ',
        '“Save tabs as…”. Saved sets appear in the “Continue” widget on “My day”.',
      ),
    ),
  ),
  page(
    'My day and Inbox',
    block(
      'My day',
      p(
        'The first screen after sign-in. At the top are the “Inbox”, “Overdue”, “Today” and ',
        '“Delegation” tiles, below them the widgets: “Inbox”, “Today”, “My tasks and instructions”, ',
        '“Assigned by me”, “Team”, “Announcements”, “Continue”, “Recent”, “Pinned”.',
      ),
      p('Choose and order the widgets with the “Customize” button.'),
    ),
    block(
      'Inbox: what it is',
      p(
        'Items waiting for your action: approve, sign, acknowledge, ',
        'accept an assignment, answer an invitation, submit a report. A notification can ',
        'simply be read; an item is closed only by an action.',
      ),
    ),
    block(
      'How to handle an item',
      ol(
        'Open “Inbox” (G I).',
        'Pick an item in the list on the left — a card with the object, the due date and the buttons opens on the right.',
        'Press the action you need: “Approve”, “Remarks”, “Reject”, “Sign”, “Acknowledge”, “Accept”, “Report” and so on.',
        'If a comment, a new due date or a confirmation code is needed, fill it in in the dialog that opens.',
      ),
      p(
        'Not ready to decide now — “Snooze” (or the S key): the item comes back tomorrow. ',
        'J and K move through the list, E opens the related object.',
      ),
    ),
    block(
      'Delegation',
      p(
        'The “All” / “Mine only” / “Delegated” switch at the top separates your items from those ',
        'of the people you stand in for. A deputy is appointed in your profile, in the “Delegation” section; ',
        'every action taken “on behalf of” someone is recorded in the audit log.',
      ),
    ),
  ),
  page(
    'Files and folders',
    block(
      'Where files live',
      p(
        'Files live in spaces. Rail → “Files”; at the top are the breadcrumbs ',
        'of the space and folders, on the right — “New folder” and “Upload”.',
      ),
    ),
    block(
      'Upload and share',
      ol(
        'Press “Upload” or drag files onto the screen.',
        'Open a file — it opens in a tab with a preview.',
        'Press “Share”, add people and choose a level: “View”, “Comment”, “Edit”, “Manage”.',
        'Press “Add”.',
      ),
      p(
        'For people without an account there is the “Link sharing” section: ',
        '“Create link” with a password, an expiry date and a limit on opens. The address is shown only once.',
      ),
    ),
    block(
      'Versions and preview',
      ul(
        'A new revision — the “New version” button on the file card, with a “Version note” field; earlier ones stay on the “Versions” tab.',
        'An earlier version comes back with “Go back to version N” — it becomes a new version with a note.',
        'To move a file or folder, use “Move” in its row or drag it onto a folder; “Rename” is there too.',
        'Previews are built for images, PDF and office files; text files are shown as text.',
        'Office files may have an “Open in editor” button — you edit right in the browser, and the result is saved as a new version.',
        'Deleted items stay in the trash for 30 days: the trash button at the bottom of the navigator, then “Restore”.',
      ),
    ),
  ),
  page(
    'Data and dashboards',
    block(
      'Upload a table',
      ol(
        'Rail → “Data” → “Upload file” (CSV, Excel, JSON, GeoJSON, Shapefile, GeoPackage, KML, GPX).',
        'The wizard walks you through “File” → “Structure” → “Mapping” → “Review and run”.',
        'At the “Mapping” step, check the field types and tick “Key” if rows should be updated by repeated uploads.',
        'Press “Run import” — the summary shows how many rows were added, changed and with which errors.',
      ),
    ),
    block(
      'What a dataset has',
      ul(
        '“Table” — search, sorting, cell editing, a row card with history and assignments.',
        '“Schema” — field types and semantics, the row key, lookups, table settings.',
        '“Versions” — every upload and edit creates a version; anyone with “Manage” access can roll back.',
        '“Quality” — rules and the “Check now” button; the result shows as a badge in the catalog.',
        '“Access” — row and column policies.',
      ),
    ),
    block(
      'Look at data in different ways',
      p(
        'The “Explore” button opens the builder: “Filters”, “Group by”, “Measures”, ',
        '“Sort”. The result switches between “Chart” and “Table”, ',
        'and “Save as chart” turns it into an object.',
      ),
      p(
        'Then the chart goes onto a dashboard as a tile (“Dashboard” in the catalog → “Edit” → ',
        '“Tile”), and for an analysis with text and conclusions there is the “Notebook”.',
      ),
      p(
        'If AI is set up in the installation, “Ask the data” works in “Explore”: ',
        'a question in plain language becomes a query that you can then edit by hand.',
      ),
    ),
  ),
  page(
    'Maps',
    block(
      'A layer is a dataset',
      p(
        'A dataset with a geometry field goes onto a map. The quick way: on the dataset, ',
        'press “On the map”. The long way: “Maps” → “Create map” → “Add layer”.',
      ),
    ),
    block(
      'What you can do on a map',
      ul(
        '“Box select” — select objects; the selection is shared with the table next to the map.',
        '“Identify” — see what is at a point.',
        '“Measure distance” and “Measure area”.',
        '“Bookmarks” — save the map view under a name.',
        '“Attributes” in the layer menu — a table of objects with the “Within the map extent” toggle.',
        '“Print and export” — an A4 or A3 sheet with a legend and a scale bar, as PNG or PDF.',
      ),
      p('Do not forget to “Save map”: the view, the layers and the basemap are saved together.'),
    ),
    block(
      'Color the districts',
      p(
        'The “Choropleth” button opens a wizard: source, territory level, measure ',
        '(count, sum, average), normalization by population or area, ',
        'classes and palette. The result is a new layer and a new dataset.',
      ),
    ),
  ),
  page(
    'Documents',
    block(
      'Register an incoming document',
      ol(
        'Rail → “Documents” → “Register”.',
        'Drag the scan onto the left side — it opens next to the card.',
        'Fill in the details: “Subject”, “Correspondent”, “Received on”, and if needed “Deadline” and “Classification”.',
        'Press “Register” — the number is assigned from the registration journal.',
      ),
      p(
        'Outgoing and internal documents are created with the “Create” button and registered from ',
        'the card when the document is ready.',
      ),
    ),
    block(
      'Approval and signing',
      ol(
        'On the card — “Send for approval”; choose the route and the approvers.',
        'Progress is shown on the “Route” tab: steps, deadlines, who has already decided.',
        'Make your decision with “Approve”, “Remarks”, “Reject” — on the card or right in the Inbox.',
        'Signing is the decision at the “Signature” step; a mark with the version hash stays in the “Signatures” section.',
      ),
      p(
        'While the route is running, the document file is frozen: a new version comes after it is returned.',
      ),
    ),
    block(
      'Resolutions, acknowledgment, case files',
      ul(
        '“Add a resolution” — text, responsible executor, co-executors, deadline and control; assignments are created at once.',
        '“Send for acknowledgment” — to employees and units, with a deadline and, if needed, a confirmation code.',
        '“File in a case” — the document goes into the case nomenclature; then the case file is closed and handed over to the archive.',
        '“Print” — “Approval sheet”, “Signature sheet”, “Acknowledgment sheet” and other forms.',
      ),
    ),
  ),
  page(
    'Assignments and control',
    block(
      'Give an assignment',
      ol(
        'Rail → “Tasks” → the “Assignment” button.',
        'Fill in “Title” and “Assignee”, and if needed “Co-assignees” and “Controller”.',
        'Set the due date as a date or a number of working days — it is calculated using the business calendar.',
        'Press “Create”: the assignee gets an item in the Inbox.',
      ),
    ),
    block(
      'How it is carried out',
      ol(
        'The assignee: “Accept for work”.',
        'Done — “Report”: what was done and the report materials.',
        'The author or controller: “Accept report” (the assignment is closed) or “Return for rework” with remarks.',
      ),
      p(
        'Running late — “Request an extension” with a new due date and a reason; ',
        'the author approves or declines. An extended assignment is marked “Extended”.',
      ),
    ),
    block(
      'Control',
      p(
        'The “Control” button opens “Execution control”: a matrix of units ',
        'and states (“On track”, “Due today”, “Overdue”, “Extended”, ',
        '“Done on time”, “Done late”), with export to XLSX and CSV. ',
        'Next to it is “Workload” by employee and week.',
      ),
    ),
  ),
  page(
    'Calendar, meetings and chats',
    block(
      'Calendar',
      p(
        'Views: “Day”, “Week”, “Month”, “Agenda”. Create an event by dragging ',
        'across the grid or with the “Create” button. On the left are your own and other people’s ',
        'calendars, resources (meeting rooms) and the “Deadlines” group with the due dates of assignments and documents.',
      ),
      p(
        'Not sure when everyone is free — “Find a time”: participants’ busy times and ',
        'a list of free slots.',
      ),
    ),
    block(
      'Meetings',
      ol(
        'Turn on “Online meeting” in a calendar event — the room is created automatically.',
        'Join with the “Join” button from the event card, the “Meetings” screen or the Inbox.',
        'In the room: microphone, camera, “Share screen”, “Raise hand”, recording, “Show to everyone”.',
        'A guest without an account gets a “Guest link”; they wait until the organizer presses “Admit”.',
      ),
      p(
        'After the meeting, the “Minutes” tab collects the questions, decisions and assignments. ',
        '“Confirm” turns the assignment blocks into real assignments.',
      ),
    ),
    block(
      'Chats',
      ul(
        'Direct chats, groups and space channels; the “Unread”, “Direct”, “Channels”, “Discussions” and “Discover” sections.',
        'From the message menu: “Reply in thread”, “Pin message”, “Forward”, “Create assignment”, “Attach to object”, “Translate”.',
        'Comments on a document or a file work the same way: the context panel, the “Discussion” tab.',
      ),
    ),
  ),
  page(
    'Knowledge base and data forms',
    block(
      'Knowledge base',
      p(
        'Rail → “Knowledge”. On the left are the space’s page tree and full-text search. ',
        'Create a page with the “New page” button and pick a template: ',
        '“Instruction”, “Policy”, “Reference”, “FAQ” or “Blank”.',
      ),
      ul(
        'Text is edited together; there is no separate save button.',
        '“Publish” takes a version and sets the “Next review”.',
        'The “Versions” tab — comparison and rollback; “Review” — owner, due date and acknowledgment.',
        '“Print” → “Page” builds a PDF.',
      ),
    ),
    block(
      'Data forms',
      p(
        'A form collects the same kind of report from units straight into a dataset. ',
        'Open the screen from the command palette (⌘K → “Data forms”).',
      ),
      ol(
        'If a form is assigned to you, it appears in the “To submit” block and in the Inbox as “Submit report”.',
        'Open the form, choose the “Period” and press “Open period”.',
        'Fill in the fields and press “Submit” (or “Save draft”).',
        'If the report is returned, fix it according to the comment and submit it again.',
      ),
    ),
  ),
  page(
    'Profile, notifications and assistant',
    block(
      'Profile',
      ul(
        '“Appearance” — theme, density, language.',
        '“Two-factor authentication” — setup and recovery codes; keep the codes safe, they are shown only once.',
        '“Passkeys” — sign in with a fingerprint or the device PIN.',
        '“Telegram” and “Browser notifications” — where to send notifications.',
        '“Change password”, “Devices and sessions”, “Delegation”.',
      ),
    ),
    block(
      'Notifications',
      p(
        'Rail → “Notifications”. There is an “Unread only” toggle and the ',
        '“Mark all as read” button. What to send to Telegram is set in your ',
        'profile, on the “Telegram” card.',
      ),
    ),
    block(
      'Assistant',
      p(
        'The “Assistant” button at the bottom of the rail and the “Assistant” tab in the context panel ',
        'of an open object. The assistant searches and reads only what you have access to, ',
        'shows its steps and links to sources, and creates nothing on its own: an assignment ',
        'appears only if you press “Create an instruction”.',
      ),
      p(
        'If AI is not set up in the installation, the panel says so plainly: “The assistant is off”.',
      ),
    ),
  ),
]
