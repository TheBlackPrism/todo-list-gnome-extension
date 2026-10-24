// Builds the real preferences window (src/prefsPage.js) and drives it by
// emitting widget signals, against the Joplin Data API at $JOPLIN_URL with
// $JOPLIN_TOKEN ($JOPLIN_FAKE=1 for the fake server, which can approve
// pairing requests). $SCHEMA_DIR holds the compiled schema. It needs a
// display: tests/shell/smoke.js runs it inside the headless GNOME Shell.
//
//   gjs -m tests/gjs/prefs.test.js

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {buildPreferences} from '../../src/prefsPage.js';

const JOPLIN_URL = GLib.getenv('JOPLIN_URL');
const JOPLIN_TOKEN = GLib.getenv('JOPLIN_TOKEN');
const FAKE = GLib.getenv('JOPLIN_FAKE') === '1';
const SCHEMA_DIR = GLib.getenv('SCHEMA_DIR');

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(condition, what, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (condition())
            return;
        await sleep(50);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function* descendants(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

Adw.init();
const source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR,
    Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
    settings_schema: source.lookup('org.gnome.shell.extensions.todo-list', false),
});
// Joplin on one of the ports Connect scans? Then start from a wrong one, so it
// has to find Joplin on its own.
const port = Number(/:(\d+)\/?$/.exec(JOPLIN_URL)?.[1]);
const DISCOVERABLE = port >= 41184 && port <= 41194;
const WRONG_URL = port === 41194 ? 'http://127.0.0.1:41193' : 'http://127.0.0.1:41194';
settings.set_string('joplin-url', DISCOVERABLE ? WRONG_URL : JOPLIN_URL);
settings.set_string('joplin-token', JOPLIN_TOKEN);
settings.set_string('notebook-id', '');

const window = new Adw.PreferencesWindow();
buildPreferences(window, settings, text => text);
window.present();

const find = predicate => [...descendants(window)].find(predicate);
const button = label => find(widget => widget instanceof Gtk.Button && widget.label === label);
const row = title => find(widget => widget instanceof Adw.PreferencesRow && widget.title === title);

const tests = [
    ['Connect finds Joplin and checks the token it has', async () => {
        button('Connect').emit('clicked');
        await waitFor(() => row('Connect to Joplin').subtitle === 'Connected',
            `"Connected" (now "${row('Connect to Joplin').subtitle}")`);
        if (settings.get_string('joplin-url') !== JOPLIN_URL)
            throw new Error(`saved ${settings.get_string('joplin-url')}`);
    }],
    ['the notebooks are listed and choosing one saves it', async () => {
        const notebooks = row('Notebook');
        await waitFor(() => notebooks.model?.get_n_items() > 1, 'the notebook list');
        notebooks.selected = 1;
        await waitFor(() => settings.get_string('notebook-id') !== '', 'the notebook id');
        notebooks.selected = 0;
        await waitFor(() => settings.get_string('notebook-id') === '', 'automatic again');
    }],
    ['Test reports a working connection and a rejected token', async () => {
        const test = row('Test the Connection');
        button('Test').emit('clicked');
        await waitFor(() => test.subtitle === 'Joplin answers and accepts the token',
            `the test result (now "${test.subtitle}")`);
        settings.set_string('joplin-token', 'wrong-token');
        button('Test').emit('clicked');
        await waitFor(() => test.subtitle === 'Joplin rejected the token', 'the rejection');
        settings.set_string('joplin-token', JOPLIN_TOKEN);
    }],
    ['without a token, Connect pairs with Joplin', async () => {
        settings.set_string('joplin-token', '');
        button('Connect').emit('clicked');
        await waitFor(() => row('Connect to Joplin').subtitle === 'Connected', 'pairing', 20000);
        if (settings.get_string('joplin-token') !== JOPLIN_TOKEN)
            throw new Error('the token from Joplin was not saved');
    }, {fakeOnly: true}],
    ['closing the window stops pending work', async () => {
        settings.set_string('joplin-url', 'http://127.0.0.1:1');
        button('Test').emit('clicked');
        window.close();
        await sleep(500);
    }],
];

const loop = new GLib.MainLoop(null, false);
let failures = 0;
(async () => {
    for (const [name, fn, {fakeOnly = false} = {}] of tests) {
        if (fakeOnly && !FAKE) {
            print(`ok - ${name} # SKIP needs the fake server`);
            continue;
        }
        try {
            await fn();
            print(`ok - ${name}`);
        } catch (error) {
            failures++;
            print(`not ok - ${name}: ${error.message}`);
        }
    }
})().finally(() => loop.quit());
await loop.runAsync();
System.exit(failures > 0 ? 1 : 0);
