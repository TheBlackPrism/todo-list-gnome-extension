import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ErrorKind, isKind} from './lib/errors.js';
import {JoplinClient} from './lib/joplinClient.js';
import {DEFAULT_NOTEBOOK_TITLE} from './lib/syncEngine.js';

// The preferences window. Kept apart from prefs.js, which only hands over
// the settings and the translation function, so that the tests can build it
// without the Extensions app.
//
// String.prototype.format() is set up by GNOME Shell, not in this process,
// so placeholders are filled in with replace().

/** How long to wait for the user to approve the request in Joplin. */
const PAIRING_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1000;

/**
 * @param {Array<{id: string, title: string, parent_id: string}>} folders
 * @param {string} untitled name for a notebook without a title
 * @returns {Array<{id: string, path: string}>} sorted by path, e.g. "Work › Todos"
 */
function notebookPaths(folders, untitled) {
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const pathOf = folder => {
        const names = [];
        for (let current = folder, depth = 0; current && depth < 50; depth++) {
            names.unshift(current.title || untitled);
            current = byId.get(current.parent_id);
        }
        return names.join(' › ');
    };
    return folders.map(folder => ({id: folder.id, path: pathOf(folder)}))
        .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Fills the preferences window.
 *
 * @param {Adw.PreferencesWindow} window
 * @param {Gio.Settings} settings the extension's settings
 * @param {(text: string) => string} _ the extension's gettext
 */
export function buildPreferences(window, settings, _) {
    const client = new JoplinClient();
    const sources = new Set();
    let closed = false;

    const sleep = ms => new Promise(resolve => {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            sources.delete(id);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        sources.add(id);
    });
    const useSettings = () => {
        client.baseUrl = settings.get_string('joplin-url');
        client.token = settings.get_string('joplin-token');
    };
    const describe = error => {
        if (isKind(error, ErrorKind.OFFLINE))
            return _('Can’t reach Joplin at %s').replace('%s', client.baseUrl);
        if (isKind(error, ErrorKind.AUTH))
            return _('Joplin rejected the token');
        return _('Something went wrong: %s').replace('%s', error.message);
    };

    const page = new Adw.PreferencesPage({
        title: _('General'),
        icon_name: 'preferences-system-symbolic',
    });
    window.add(page);

    // Joplin connection

    const joplin = new Adw.PreferencesGroup({
        title: _('Joplin'),
        description: _('The list syncs through the Joplin Data API. In Joplin desktop, ' +
            'turn it on under Tools › Options › Web Clipper. With the terminal app, ' +
            'run “joplin server start”.'),
    });
    page.add(joplin);

    const connectRow = new Adw.ActionRow({
        title: _('Connect to Joplin'),
        subtitle: _('Finds Joplin on this computer and asks it for access'),
    });
    const connectButton = new Gtk.Button({
        label: _('Connect'),
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    connectRow.add_suffix(connectButton);
    joplin.add(connectRow);

    const urlRow = new Adw.EntryRow({
        title: _('Address'),
        text: settings.get_string('joplin-url'),
        show_apply_button: true,
    });
    urlRow.connect('apply', () => settings.set_string('joplin-url', urlRow.text.trim()));
    joplin.add(urlRow);

    const tokenRow = new Adw.PasswordEntryRow({
        title: _('Authorisation Token'),
        text: settings.get_string('joplin-token'),
        show_apply_button: true,
    });
    tokenRow.connect('apply', () => settings.set_string('joplin-token', tokenRow.text.trim()));
    joplin.add(tokenRow);

    const testRow = new Adw.ActionRow({
        title: _('Test the Connection'),
        subtitle: _('The token is stored in your GNOME settings. It only gives access ' +
            'to Joplin on this computer.'),
    });
    const testButton = new Gtk.Button({label: _('Test'), valign: Gtk.Align.CENTER});
    testRow.add_suffix(testButton);
    joplin.add(testRow);

    // Notebook

    const notebookGroup = new Adw.PreferencesGroup({
        title: _('Notebook'),
        description: _('The to-dos of this Joplin notebook make up the list. Changing ' +
            'it first syncs pending changes to the old notebook.'),
    });
    page.add(notebookGroup);
    const notebookRow = new Adw.ComboRow({title: _('Notebook')});
    const refreshButton = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        tooltip_text: _('Reload the notebooks'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    notebookRow.add_suffix(refreshButton);
    notebookGroup.add(notebookRow);

    let notebookIds = [];
    let updatingNotebooks = false;
    const showNotebooks = (notebooks, subtitle) => {
        const current = settings.get_string('notebook-id');
        const entries = [{
            id: '',
            path: _('Automatic (“%s”, created if needed)').replace('%s', DEFAULT_NOTEBOOK_TITLE),
        }, ...notebooks];
        if (current && !entries.some(entry => entry.id === current))
            entries.push({id: current, path: _('The current notebook')});
        updatingNotebooks = true;
        notebookIds = entries.map(entry => entry.id);
        notebookRow.model = Gtk.StringList.new(entries.map(entry => entry.path));
        notebookRow.selected = Math.max(0, notebookIds.indexOf(current));
        notebookRow.subtitle = subtitle;
        updatingNotebooks = false;
    };
    notebookRow.connect('notify::selected', () => {
        if (updatingNotebooks || notebookRow.selected >= notebookIds.length)
            return;
        settings.set_string('notebook-id', notebookIds[notebookRow.selected]);
    });

    const loadNotebooks = async () => {
        useSettings();
        if (!client.token) {
            showNotebooks([], _('Connect to Joplin to choose a notebook'));
            return;
        }
        notebookRow.subtitle = _('Loading…');
        try {
            const folders = await client.listFolders();
            if (!closed)
                showNotebooks(notebookPaths(folders, _('Untitled')), '');
        } catch (error) {
            if (!closed && !isKind(error, ErrorKind.CANCELLED))
                showNotebooks([], describe(error));
        }
    };
    refreshButton.connect('clicked', () => loadNotebooks());

    // Sync and appearance

    const syncGroup = new Adw.PreferencesGroup({title: _('Sync')});
    page.add(syncGroup);
    const enabledRow = new Adw.SwitchRow({title: _('Sync with Joplin')});
    settings.bind('sync-enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    syncGroup.add(enabledRow);
    const intervalRow = new Adw.SpinRow({
        title: _('Sync Interval'),
        subtitle: _('Minutes between syncs. Changes are also sent right after you make them.'),
        adjustment: new Gtk.Adjustment({lower: 1, upper: 120, step_increment: 1, page_increment: 10}),
    });
    settings.bind('sync-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('sync-enabled', intervalRow, 'sensitive', Gio.SettingsBindFlags.GET);
    syncGroup.add(intervalRow);

    const appearanceGroup = new Adw.PreferencesGroup({title: _('Appearance')});
    page.add(appearanceGroup);
    const countRow = new Adw.SwitchRow({
        title: _('Show the Number of Open To-Dos'),
        subtitle: _('Next to the icon in the top bar'),
    });
    settings.bind('show-count', countRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    appearanceGroup.add(countRow);

    // Actions

    const connect = async () => {
        connectButton.sensitive = false;
        useSettings();
        try {
            connectRow.subtitle = _('Looking for Joplin…');
            const found = await client.discover();
            if (closed)
                return;
            if (!found) {
                connectRow.subtitle = _('Joplin isn’t running, or its Web Clipper ' +
                    'service is turned off');
                return;
            }
            if (found !== settings.get_string('joplin-url')) {
                settings.set_string('joplin-url', found);
                urlRow.text = found;
            }
            client.baseUrl = found;

            if (client.token) {
                try {
                    await client.checkToken();
                    connectRow.subtitle = _('Connected');
                    await loadNotebooks();
                    return;
                } catch (error) {
                    if (!isKind(error, ErrorKind.AUTH))
                        throw error;
                }
            }

            connectRow.subtitle = _('Approve the request in Joplin…');
            const authToken = await client.requestAuthorisation();
            const deadline = Date.now() + PAIRING_TIMEOUT_MS;
            while (!closed && Date.now() < deadline) {
                // One request at a time, a second after each answer.
                const reply = await client.checkAuthorisation(authToken);
                if (reply?.status === 'accepted' && reply.token) {
                    settings.set_string('joplin-token', reply.token);
                    tokenRow.text = reply.token;
                    connectRow.subtitle = _('Connected');
                    await loadNotebooks();
                    return;
                }
                if (reply?.status === 'rejected') {
                    connectRow.subtitle = _('The request was declined in Joplin');
                    return;
                }
                await sleep(POLL_INTERVAL_MS);
            }
            if (!closed)
                connectRow.subtitle = _('Joplin didn’t answer. Try again.');
        } catch (error) {
            if (closed || isKind(error, ErrorKind.CANCELLED))
                return;
            // Joplin keeps one pending request; a newer one replaces ours.
            connectRow.subtitle = isKind(error, ErrorKind.HTTP)
                ? _('Another request replaced this one. Try again.')
                : describe(error);
        } finally {
            if (!closed)
                connectButton.sensitive = true;
        }
    };
    connectButton.connect('clicked', () => connect());

    const test = async () => {
        testButton.sensitive = false;
        useSettings();
        try {
            if (!await client.ping()) {
                testRow.subtitle = _('No Joplin at %s').replace('%s', client.baseUrl);
                return;
            }
            await client.checkToken();
            testRow.subtitle = _('Joplin answers and accepts the token');
        } catch (error) {
            if (!closed && !isKind(error, ErrorKind.CANCELLED))
                testRow.subtitle = describe(error);
        } finally {
            if (!closed)
                testButton.sensitive = true;
        }
    };
    testButton.connect('clicked', () => test());

    const settingsIds = [
        settings.connect('changed::notebook-id', () => {
            const index = notebookIds.indexOf(settings.get_string('notebook-id'));
            if (index >= 0 && index !== notebookRow.selected) {
                updatingNotebooks = true;
                notebookRow.selected = index;
                updatingNotebooks = false;
            }
        }),
    ];

    window.connect('close-request', () => {
        closed = true;
        for (const id of sources)
            GLib.source_remove(id);
        sources.clear();
        for (const id of settingsIds)
            settings.disconnect(id);
        client.destroy();
        return false;
    });

    loadNotebooks();
}
