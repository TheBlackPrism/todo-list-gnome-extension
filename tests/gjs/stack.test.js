// Tests the GJS layer (libsoup client, file store, sync manager) together with
// the sync engine, against a Joplin Data API at $JOPLIN_URL with $JOPLIN_TOKEN:
// the fake server (tests/run-gjs.sh starts one) or a real Joplin.
// $JOPLIN_FAKE=1 enables the checks only the fake can support. $SCHEMA_DIR
// holds the compiled GSettings schema; run with GSETTINGS_BACKEND=memory.
//
//   gjs -m tests/gjs/stack.test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {ErrorKind} from '../../src/lib/errors.js';
import {JoplinClient} from '../../src/lib/joplinClient.js';
import {FILE_NAME, TodoStore, createWriteQueue} from '../../src/lib/store.js';
import {synchronize} from '../../src/lib/syncEngine.js';
import {SyncManager, SyncStatus} from '../../src/lib/syncManager.js';

const JOPLIN_URL = GLib.getenv('JOPLIN_URL') ?? 'http://127.0.0.1:41184';
const JOPLIN_TOKEN = GLib.getenv('JOPLIN_TOKEN') ?? '';
const FAKE = GLib.getenv('JOPLIN_FAKE') === '1';
const SCHEMA_DIR = GLib.getenv('SCHEMA_DIR');

const tests = [];
const test = (name, fn, {fakeOnly = false} = {}) => tests.push({name, fn, fakeOnly});

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${message}: ${a} !== ${b}`);
}

async function assertRejects(promise, kind, message) {
    try {
        await promise;
    } catch (error) {
        if (error.kind !== kind) {
            throw new Error(`${message}: expected ${kind}, got ${error.kind ?? error}`,
                {cause: error});
        }
        return error;
    }
    throw new Error(`${message}: did not reject`);
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(condition, message, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await condition())
            return;
        await sleep(50);
    }
    throw new Error(`Timed out: ${message}`);
}

const tempDir = () => GLib.dir_make_tmp('todo-list-test-XXXXXX');
const newClient = (options = {}) =>
    new JoplinClient({baseUrl: JOPLIN_URL, token: JOPLIN_TOKEN, ...options});

/** Accepts connections and never answers. */
function silentServer() {
    const service = new Gio.SocketService();
    const port = service.add_any_inet_port(null);
    const connections = [];
    service.connect('incoming', (_service, connection) => {
        connections.push(connection);
        return true;
    });
    service.start();
    return {
        url: `http://127.0.0.1:${port}`,
        stop: () => {
            service.stop();
            service.close();
            for (const connection of connections)
                connection.close(null);
        },
    };
}

/** Counts the writes a client makes. */
function countingClient(client) {
    const counts = {createNote: 0, updateNote: 0, deleteNote: 0, createFolder: 0};
    const proxy = new Proxy(client, {
        get(target, property) {
            const value = target[property];
            if (typeof value !== 'function')
                return value;
            return (...args) => {
                if (property in counts)
                    counts[property]++;
                return value.apply(target, args);
            };
        },
    });
    return {proxy, counts};
}

function readFile(path) {
    const [, contents] = Gio.File.new_for_path(path).load_contents(null);
    return new TextDecoder().decode(contents);
}

test('ping recognises Joplin and nothing else', async () => {
    const client = newClient();
    assert(await client.ping(), `no Joplin at ${JOPLIN_URL}`);
    assert(!await client.ping('http://127.0.0.1:1'), 'a closed port answered');
    client.destroy();
});

test('a wrong token is reported as AUTH', async () => {
    const client = newClient({token: 'wrong-token'});
    await assertRejects(client.checkToken(), ErrorKind.AUTH, 'checkToken');
    await assertRejects(client.listFolders(), ErrorKind.AUTH, 'listFolders');
    client.destroy();
});

test('an invalid address is reported as OFFLINE', async () => {
    const client = newClient({baseUrl: 'not a url'});
    await assertRejects(client.listFolders(), ErrorKind.OFFLINE, 'listFolders');
    client.destroy();
});

test('a server that never answers times out as OFFLINE', async () => {
    const silent = silentServer();
    const client = newClient({baseUrl: silent.url, timeout: 1});
    const started = Date.now();
    await assertRejects(client.listFolders(), ErrorKind.OFFLINE, 'listFolders');
    assert(Date.now() - started < 5000, 'the timeout took too long');
    client.destroy();
    silent.stop();
});

test('destroy() cancels a request in flight', async () => {
    const silent = silentServer();
    const client = newClient({baseUrl: silent.url, timeout: 30});
    const request = client.listFolders();
    await sleep(100);
    client.destroy();
    await assertRejects(request, ErrorKind.CANCELLED, 'listFolders');
    silent.stop();
});

test('the store saves privately and reloads', async () => {
    const directory = tempDir();
    const store = new TodoStore({directory, writeQueue: createWriteQueue()});
    assert(await store.load(), 'load');
    store.add({title: 'one', description: 'multi\nline'});
    store.add({title: 'two', due: 1_800_000_000_000});
    await store.flushed();

    const info = Gio.File.new_for_path(store.path).query_info('unix::mode', 0, null);
    assertEqual(info.get_attribute_uint32('unix::mode') & 0o777, 0o600, 'file mode');
    const again = new TodoStore({directory, writeQueue: createWriteQueue()});
    await again.load();
    assertEqual(again.list.toJSON(), store.list.toJSON(), 'reloaded contents');
});

test('an unreadable file is moved aside, not overwritten', async () => {
    const directory = tempDir();
    GLib.file_set_contents(`${directory}/${FILE_NAME}`, 'this is not json');
    const store = new TodoStore({directory, writeQueue: createWriteQueue()});
    await store.load();
    assertEqual(store.list.visible().length, 0, 'empty list');
    const names = [];
    const children = Gio.File.new_for_path(directory).enumerate_children('standard::name', 0, null);
    for (let info = children.next_file(null); info; info = children.next_file(null))
        names.push(info.get_name());
    const aside = names.find(name => name.startsWith(`${FILE_NAME}.corrupt-`));
    assert(aside, `no corrupt copy in ${names}`);
    assertEqual(readFile(`${directory}/${aside}`), 'this is not json', 'corrupt copy');
});

test('load waits for the previous instance to finish writing', async () => {
    const directory = tempDir();
    const queue = createWriteQueue();
    const first = new TodoStore({directory, writeQueue: queue});
    await first.load();
    for (let i = 0; i < 50; i++)
        first.add({title: `item ${i}`});
    first.destroy(); // as on screen lock: no await
    const second = new TodoStore({directory, writeQueue: queue});
    await second.load();
    assertEqual(second.list.visible().length, 50, 'items after reload');
});

test('a full round trip through the Data API', async () => {
    const store = new TodoStore({directory: tempDir(), writeQueue: createWriteQueue()});
    await store.load();
    const client = newClient();
    const due = new Date(2027, 0, 15, 9, 0).getTime();
    const item = store.add({title: 'Buy milk', description: 'two litres\nsemi-skimmed', due});

    const {notebookId} = await synchronize({list: store.list, client, notebookId: ''});
    let note = await client.getNote(item.id);
    assertEqual([note.is_todo, note.parent_id, note.todo_due, note.body],
        [1, notebookId, due, 'two litres\nsemi-skimmed'], 'created note');

    await client.updateNote(item.id, {title: 'Buy oat milk'});
    await synchronize({list: store.list, client, notebookId});
    assertEqual(store.list.get(item.id).title, 'Buy oat milk', 'pulled title');

    store.setCompleted(item.id, true);
    await synchronize({list: store.list, client, notebookId});
    note = await client.getNote(item.id);
    assert(note.todo_completed > 0, 'completion pushed');

    const {proxy, counts} = countingClient(client);
    await synchronize({list: store.list, client: proxy, notebookId});
    assertEqual(counts, {createNote: 0, updateNote: 0, deleteNote: 0, createFolder: 0},
        'writes on an idle sync');

    store.remove(item.id);
    await synchronize({list: store.list, client, notebookId});
    note = await client.getNote(item.id);
    assert(Number(note.deleted_time) > 0, 'deleted note is in the trash');
    assert(!store.list.get(item.id), 'deleted item is gone locally');
    client.destroy();
});

test('listings longer than one page are read completely', async () => {
    const client = newClient();
    const folder = await client.createFolder(`Paging ${Date.now()}`);
    for (let i = 0; i < 105; i++)
        await client.createNote({parent_id: folder.id, title: `todo ${i}`, is_todo: 1});
    const notes = await client.listNotes(folder.id);
    assertEqual(notes.length, 105, 'notes listed');
    assertEqual(new Set(notes.map(note => note.id)).size, 105, 'distinct notes');
    client.destroy();
});

test('the pairing flow returns the token once approved', async () => {
    const client = newClient({token: ''});
    const authToken = await client.requestAuthorisation();
    let reply = await client.checkAuthorisation(authToken);
    assertEqual(reply.status, 'waiting', 'first check');
    while (reply.status === 'waiting')
        reply = await client.checkAuthorisation(authToken);
    assertEqual(reply, {status: 'accepted', token: JOPLIN_TOKEN}, 'approval');
    client.destroy();
}, {fakeOnly: true});

function makeSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR,
        Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup('org.gnome.shell.extensions.todo-list', false);
    return new Gio.Settings({settings_schema: schema});
}

test('the sync manager pushes a user change and reports the result', async () => {
    const settings = makeSettings();
    settings.set_string('joplin-url', JOPLIN_URL);
    settings.set_string('joplin-token', JOPLIN_TOKEN);
    settings.set_string('notebook-id', '');
    const store = new TodoStore({directory: tempDir(), writeQueue: createWriteQueue()});
    await store.load();
    const client = new JoplinClient();
    const manager = new SyncManager({store, client, settings});
    manager.start();
    await waitFor(() => manager.status === SyncStatus.OK, 'first sync');
    assert(settings.get_string('notebook-id') !== '', 'notebook saved in settings');

    const item = store.add({title: 'via the manager'});
    await waitFor(async () => {
        try {
            return (await client.getNote(item.id)).title === 'via the manager';
        } catch {
            return false;
        }
    }, 'the item reaches Joplin', 8000);

    settings.set_string('joplin-url', 'http://127.0.0.1:1');
    await waitFor(() => manager.status === SyncStatus.OFFLINE, 'offline status');

    manager.destroy();
    client.destroy();
    store.destroy();
});

const loop = new GLib.MainLoop(null, false);
let failures = 0;
(async () => {
    for (const {name, fn, fakeOnly} of tests) {
        if (fakeOnly && !FAKE) {
            print(`ok - ${name} # SKIP needs the fake server`);
            continue;
        }
        try {
            await fn();
            print(`ok - ${name}`);
        } catch (error) {
            failures++;
            print(`not ok - ${name}\n#   ${error.message}\n${error.stack.replace(/^/gm, '#   ')}`);
        }
    }
    print(`# ${tests.length - failures}/${tests.length} passed`);
})().finally(() => loop.quit());
await loop.runAsync();
System.exit(failures > 0 ? 1 : 0);
