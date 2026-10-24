// Drives a real GNOME Shell with the extension installed. Run it with
// tests/run-shell-smoke.sh, which starts
//   gnome-shell --headless --automation-script tests/shell/smoke.js
// The shell exits with an error if run() throws.
//
// Environment: SMOKE_OUTPUT (directory for screenshots), SMOKE_JOPLIN_URL and
// SMOKE_JOPLIN_TOKEN (a Joplin Data API to sync with).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'todo-list@theblackprism.ch';
const OUTPUT = GLib.getenv('SMOKE_OUTPUT') ?? '/tmp';
const JOPLIN_URL = GLib.getenv('SMOKE_JOPLIN_URL');
const JOPLIN_TOKEN = GLib.getenv('SMOKE_JOPLIN_TOKEN');

// Created in run(): the module is imported while the shell is still starting.
let pointer = null;
let keyboard = null;
const now = () => GLib.get_monotonic_time();

function check(condition, message) {
    if (!condition)
        throw new Error(`Check failed: ${message}`);
    console.log(`smoke: ok - ${message}`);
}

async function waitFor(condition, what, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await condition())
            return;
        await Scripting.sleep(100);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Clicks an actor with the virtual pointer.
 *
 * @param {() => Clutter.Actor} getActor looked up again after waiting, since
 *     the menu may have rebuilt its rows meanwhile
 * @param {string} what
 */
async function click(getActor, what) {
    // A freshly built row has no allocation until the next frame.
    await waitFor(() => {
        const actor = getActor();
        return actor?.is_mapped() && actor.has_allocation();
    }, `${what} to be laid out`);
    await Scripting.sleep(200);
    const actor = getActor();
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    // Sent twice: a new virtual pointer drops one axis of its first motion.
    for (let i = 0; i < 2; i++) {
        pointer.notify_absolute_motion(now(), x + width / 2, y + height / 2);
        await Scripting.sleep(100);
    }
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await Scripting.sleep(60);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await Scripting.sleep(400);
}

async function press(keyval) {
    keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
    await Scripting.sleep(40);
    keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
    await Scripting.sleep(150);
}

async function screenshot(name) {
    await Scripting.sleep(700); // let animations settle
    const path = `${OUTPUT}/${name}.png`;
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
    console.log(`smoke: screenshot ${path}`);
}

function extension() {
    return Main.extensionManager.lookup(UUID);
}

async function waitActive() {
    await waitFor(() => {
        const state = extension()?.state;
        if (state === ExtensionState.ERROR)
            throw new Error(`Extension failed: ${extension().error}`);
        return state === ExtensionState.ACTIVE;
    }, 'the extension to be active');
}

const dayAt = (days, hours = 9, minutes = 0) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
};

export async function run() {
    console.log('smoke: started');
    // GNOME 51 dropped Clutter.get_default_backend().
    const backend = global.stage.context?.get_backend() ?? Clutter.get_default_backend();
    const seat = backend.get_default_seat();
    pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    Main.overview.hide();
    await Scripting.sleep(500);

    Main.extensionManager.enableExtension(UUID);
    await waitActive();
    const ext = extension().stateObj;
    const indicator = Main.panel.statusArea[UUID];
    check(indicator, 'the indicator is in the top bar');
    await waitFor(() => ext._store.loaded, 'the list to load');

    const settings = ext.getSettings();
    if (JOPLIN_URL) {
        // A notebook of its own, so earlier runs don't show up.
        ext._client.baseUrl = JOPLIN_URL;
        ext._client.token = JOPLIN_TOKEN;
        const notebook = await ext._client.createFolder(`Smoke test ${new Date().toISOString()}`);
        settings.set_string('notebook-id', notebook.id);
        settings.set_string('joplin-url', JOPLIN_URL);
        settings.set_string('joplin-token', JOPLIN_TOKEN);
        await waitFor(() => ext._sync.status === 'ok', 'the first sync', 30000);
        check(true, `first sync with ${JOPLIN_URL}`);
    }

    // Quick add through the menu entry.
    indicator.menu.open();
    await waitFor(() => indicator._entry.clutter_text.has_key_focus(),
        'the entry to take key focus', 3000);
    check(true, 'the quick-add entry has key focus when the menu opens');
    const store = ext._store;
    const before = new Set(store.list.visible().map(item => item.id));
    indicator._entry.text = 'Buy oat milk';
    await press(Clutter.KEY_Return);
    const added = store.list.visible().find(item => !before.has(item.id));
    check(added, 'Enter in the entry adds a to-do');
    check(indicator._entry.text === '', 'the entry is cleared');

    const dentist = store.add({title: 'Call the dentist',
        description: 'Ask about the cleaning appointment', due: dayAt(1, 14, 30)});
    store.add({title: 'Pay the electricity bill', due: dayAt(-1)});
    store.add({title: 'Water the plants', due: dayAt(0)});
    store.add({title: 'Book train tickets', description: 'Zurich – Geneva, window seat'});
    const done = store.add({title: 'Renew passport'});
    store.setCompleted(done.id, true);
    const shown = () => indicator._rows.map(row => store.list.get(row.itemId)?.title);
    await waitFor(() => ['Buy oat milk', 'Call the dentist', 'Pay the electricity bill',
        'Water the plants', 'Book train tickets', 'Renew passport']
        .every(title => shown().includes(title)), 'the menu to show the to-dos');
    await screenshot('menu');

    // The checkbox toggles completion and does not open the dialog.
    const rowOf = id => indicator._rows.find(candidate => candidate.itemId === id);
    await click(() => rowOf(added.id)?._check, 'the checkbox');
    check(store.list.get(added.id).completed > 0, 'the checkbox completes the to-do');
    check(indicator._dialog === null, 'the checkbox does not open the dialog');
    check(indicator.menu.isOpen, 'the menu stays open');
    await waitFor(() => indicator._rows.some(candidate => candidate.itemId === added.id &&
        candidate._check.checked), 'the row to move to Completed');

    // Clicking the row opens the edit dialog.
    await click(() => rowOf(dentist.id)?._button, 'the row');
    const dialog = indicator._dialog;
    check(dialog?._titleEntry?.text === 'Call the dentist', 'the row opens the edit dialog');
    check(!indicator.menu.isOpen, 'the menu closes behind the dialog');

    await click(() => dialog._dateButton, 'the date button');
    check(dialog._picker.visible, 'the date button shows the date picker');
    await screenshot('dialog');

    // Return and keypad Enter insert newlines in the description and don't save.
    dialog._descriptionEntry.grab_key_focus();
    const text = dialog._descriptionEntry.clutter_text;
    text.set_cursor_position(-1);
    await press(Clutter.KEY_Return);
    await press(Clutter.KEY_KP_Enter);
    for (const key of [Clutter.KEY_o, Clutter.KEY_k])
        await press(key);
    check(dialog._descriptionEntry.text === 'Ask about the cleaning appointment\n\nok',
        `Return and KP_Enter add newlines (got ${JSON.stringify(dialog._descriptionEntry.text)})`);
    check(indicator._dialog === dialog && dialog.state === ModalDialog.State.OPENED,
        'the dialog is still open');

    // Picking a day in the calendar sets the date.
    const nextWeek = dialog._picker._days.find(day =>
        day._date.day === new Date(dayAt(7)).getDate() &&
        day._date.month === new Date(dayAt(7)).getMonth() + 1);
    await click(() => nextWeek, 'a day in the picker');
    check(!dialog._picker.visible, 'picking a day closes the picker');

    // The time field takes typing once clicked.
    await click(() => dialog._timeEntry, 'the time field');
    dialog._timeEntry.clutter_text.set_cursor_position(-1);
    for (let i = 0; i < 5; i++)
        await press(Clutter.KEY_BackSpace);
    for (const key of [Clutter.KEY_1, Clutter.KEY_6, Clutter.KEY_period, Clutter.KEY_4, Clutter.KEY_5])
        await press(key);
    check(dialog._timeEntry.text === '16.45',
        `the time field is editable (got ${JSON.stringify(dialog._timeEntry.text)})`);

    dialog._titleEntry.grab_key_focus();
    await press(Clutter.KEY_Return);
    await waitFor(() => indicator._dialog === null, 'the dialog to close');
    const saved = store.list.get(dentist.id);
    check(saved.description === 'Ask about the cleaning appointment\n\nok', 'the description was saved');
    check(saved.due === dayAt(7, 16, 45), 'the picked day and typed time were saved');

    // Screen-lock style disable/enable cycles while writes and syncs are pending.
    for (let cycle = 1; cycle <= 5; cycle++) {
        ext._store.add({title: `Cycle ${cycle}`});
        ext._sync.syncNow();
        await Scripting.sleep(cycle * 15);
        Main.extensionManager.disableExtension(UUID);
        await waitFor(() => extension().state !== ExtensionState.ACTIVE, 'disable');
        Main.extensionManager.enableExtension(UUID);
        await waitActive();
        await waitFor(() => ext._store.loaded, 'the list to reload');
    }
    const titles = ext._store.list.visible().map(item => item.title);
    for (let cycle = 1; cycle <= 5; cycle++)
        check(titles.includes(`Cycle ${cycle}`), `the item added before cycle ${cycle} survived`);

    if (JOPLIN_URL) {
        await waitFor(() => ext._sync.status === 'ok' &&
            ext._store.list.items().every(item => item.base !== null && !item.deleted),
        'everything to be synced', 30000);
        for (const item of ext._store.list.visible()) {
            const note = await ext._client.getNote(item.id);
            if (note.title !== item.title || note.body !== item.description)
                throw new Error(`Joplin has a different "${item.title}"`);
        }
        check(true, 'Joplin has every to-do with the same title and description');
    }

    const panelIndicator = Main.panel.statusArea[UUID];
    panelIndicator.menu.open();
    await waitFor(() => panelIndicator._rows.length > 0, 'the menu to fill');
    panelIndicator._completedItem.setSubmenuShown(true);
    await screenshot('menu-after');
    panelIndicator.menu.close();

    // The same menu with the light style.
    const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    desktop.set_string('color-scheme', 'prefer-light');
    await Scripting.sleep(1500);
    panelIndicator.menu.open();
    await screenshot('menu-light');
    panelIndicator.menu.close();
    desktop.set_string('color-scheme', 'default');
}
