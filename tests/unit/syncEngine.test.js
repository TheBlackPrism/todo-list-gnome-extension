import test from 'node:test';
import assert from 'node:assert/strict';

import {ErrorKind, JoplinError} from '../../src/lib/errors.js';
import {DEFAULT_NOTEBOOK_TITLE} from '../../src/lib/syncEngine.js';
import {assertConverged, makeHarness} from '../helpers/syncHarness.js';

/** A harness that has already completed one sync with the given local items. */
async function synced(titles = ['one']) {
    const harness = makeHarness();
    const items = titles.map(title => harness.list.add({title}));
    await harness.run();
    return {harness, items};
}

const httpError = () => new JoplinError(ErrorKind.HTTP, 'read-only (fault)', {status: 500});

test('first sync creates the Todos notebook, pushes local items and pulls remote to-dos', async () => {
    const harness = makeHarness();
    const {server, list} = harness;
    server.addFolder('Work');
    const local = list.add({title: 'local', description: 'from GNOME', due: 1_800_000_000_000});

    const result = await harness.run();
    const folder = server.folders.get(result.notebookId);
    assert.equal(folder.title, DEFAULT_NOTEBOOK_TITLE);
    assert.equal(folder.parent_id, '');
    const note = server.notes.get(local.id);
    assert.equal(note.is_todo, 1);
    assert.equal(note.parent_id, folder.id);
    assert.equal(note.body, 'from GNOME');
    assert.equal(note.todo_due, 1_800_000_000_000);
    assert.equal(result.stats.created, 1);
    assertConverged(harness);
});

test('an existing Todos notebook is reused and only its to-dos are pulled', async () => {
    const harness = makeHarness();
    const {server, list} = harness;
    const folder = server.addFolder(DEFAULT_NOTEBOOK_TITLE);
    server.addFolder(DEFAULT_NOTEBOOK_TITLE, folder); // nested namesake: ignored
    const todo = server.addNote({parent_id: folder, title: 'remote', is_todo: 1, body: 'b'});
    server.addNote({parent_id: folder, title: 'a plain note'});
    const conflict = server.addNote({parent_id: folder, title: 'remote', is_todo: 1});
    server.notes.get(conflict).is_conflict = 1;

    const result = await harness.run();
    assert.equal(result.notebookId, folder);
    assert.equal(server.folders.size, 2);
    assert.deepEqual(list.visible().map(item => [item.id, item.title, item.description]),
        [[todo, 'remote', 'b']]);
    assertConverged(harness);
});

test('a second sync with nothing new makes no writes and no local changes', async () => {
    const {harness} = await synced(['a', 'b']);
    harness.server.addNote({parent_id: harness.configured, title: 'remote', is_todo: 1,
        todo_completed: 123});
    await harness.run();

    const {writes, changes} = await harness.runCounting();
    assert.deepEqual(writes, []);
    assert.deepEqual(changes, []);
});

test('a local edit pushes only the changed field', async () => {
    const {harness, items: [item]} = await synced();
    harness.list.update(item.id, {title: 'renamed'});

    const {writes} = await harness.runCounting();
    assert.deepEqual(writes.map(write => write.args), [[item.id, {title: 'renamed'}]]);
    assert.equal(harness.server.notes.get(item.id).title, 'renamed');
    assertConverged(harness);
});

test('a remote edit is pulled without writing back', async () => {
    const {harness, items: [item]} = await synced();
    harness.server.edit(item.id, {body: 'added in Joplin', todo_completed: 42});

    const {writes} = await harness.runCounting();
    assert.deepEqual(writes, []);
    assert.equal(harness.list.get(item.id).description, 'added in Joplin');
    assert.equal(harness.list.get(item.id).completed, 42);
    assertConverged(harness);
});

test('edits to different fields on both sides are merged', async () => {
    const {harness, items: [item]} = await synced();
    harness.list.update(item.id, {title: 'local title'});
    harness.server.edit(item.id, {body: 'remote body'});

    const {writes} = await harness.runCounting();
    assert.deepEqual(writes.map(write => write.args[1]), [{title: 'local title'}]);
    assert.equal(harness.list.get(item.id).description, 'remote body');
    assertConverged(harness);
});

test('when both sides change the same field, the newer edit wins', async () => {
    // Local clock behind Joplin's: the remote edit is newer.
    let harness = makeHarness({localStart: Date.UTC(2026, 0, 1), remoteStart: Date.UTC(2026, 5, 1)});
    let item = harness.list.add({title: 'start'});
    await harness.run();
    harness.list.update(item.id, {title: 'older local'});
    harness.server.edit(item.id, {title: 'newer remote'});
    await harness.run();
    assert.equal(harness.list.get(item.id).title, 'newer remote');
    assertConverged(harness);

    // Local clock ahead: the local edit is newer.
    harness = makeHarness({localStart: Date.UTC(2026, 5, 1), remoteStart: Date.UTC(2026, 0, 1)});
    item = harness.list.add({title: 'start'});
    await harness.run();
    harness.server.edit(item.id, {title: 'older remote'});
    harness.list.update(item.id, {title: 'newer local'});
    await harness.run();
    assert.equal(harness.server.notes.get(item.id).title, 'newer local');
    assertConverged(harness);
});

test('completing on both sides at different times is not a conflict', async () => {
    const {harness, items: [item]} = await synced();
    harness.list.setCompleted(item.id, true);
    harness.server.edit(item.id, {todo_completed: 5});

    const {writes} = await harness.runCounting();
    assert.deepEqual(writes, []);
    assert.ok(harness.list.get(item.id).completed > 0);
    assertConverged(harness);
});

test('a local deletion moves the note to the trash', async () => {
    const {harness, items: [item]} = await synced();
    harness.list.remove(item.id);
    await harness.run();
    assert.ok(harness.server.notes.get(item.id).deleted_time > 0);
    assert.equal(harness.list.get(item.id), undefined);
    assertConverged(harness);
});

test('a note trashed or deleted in Joplin disappears locally', async () => {
    const {harness, items: [trashed, purged]} = await synced(['trashed', 'purged']);
    harness.server.trash(trashed.id);
    harness.server.purge(purged.id);
    const {result, writes} = await harness.runCounting();
    assert.deepEqual(writes, []);
    assert.equal(result.stats.removedLocal, 2);
    assert.equal(harness.list.size, 0);
});

test('an edit in Joplin beats a local deletion', async () => {
    const {harness, items: [item]} = await synced();
    harness.list.remove(item.id);
    harness.server.edit(item.id, {title: 'still needed'});
    const {writes} = await harness.runCounting();
    assert.deepEqual(writes, []);
    assert.equal(harness.list.get(item.id).deleted, false);
    assert.equal(harness.list.get(item.id).title, 'still needed');
    assertConverged(harness);
});

test('a local edit restores a note trashed in Joplin', async () => {
    const {harness, items: [item]} = await synced();
    harness.server.edit(item.id, {body: 'remote'});
    harness.server.trash(item.id);
    harness.list.update(item.id, {title: 'edited offline'});

    await harness.run();
    const note = harness.server.notes.get(item.id);
    assert.equal(note.deleted_time, 0);
    assert.equal(note.title, 'edited offline');
    assert.equal(harness.list.get(item.id).description, 'remote');
    assertConverged(harness);
});

test('a local edit survives a permanent deletion in Joplin as a new note', async () => {
    const {harness, items: [item]} = await synced();
    harness.server.purge(item.id);
    harness.list.update(item.id, {title: 'edited offline'});

    await harness.run();
    assert.equal(harness.list.get(item.id), undefined);
    const [survivor] = harness.list.visible();
    assert.equal(survivor.title, 'edited offline');
    assert.notEqual(survivor.id, item.id);
    assertConverged(harness);
});

test('notes moved away or turned into plain notes leave the list', async () => {
    const {harness, items: [moved, converted]} = await synced(['moved', 'converted']);
    const other = harness.server.addFolder('Elsewhere');
    harness.server.edit(moved.id, {parent_id: other});
    harness.server.edit(converted.id, {is_todo: 0});
    await harness.run();
    assert.equal(harness.list.size, 0);
    assert.equal(harness.server.notes.get(moved.id).parent_id, other);
    assert.equal(harness.server.notes.get(converted.id).deleted_time, 0);
});

test('a create whose reply was lost is adopted, not duplicated', async () => {
    const harness = makeHarness();
    const item = harness.list.add({title: 'once'});
    harness.client.inject({method: 'createNote', when: 'after'});
    await assert.rejects(harness.run(), {kind: ErrorKind.OFFLINE});
    assert.equal(harness.list.get(item.id).base, null);

    harness.list.update(item.id, {description: 'typed meanwhile'});
    await harness.run();
    assert.equal(harness.server.todosIn(harness.configured).length, 1);
    assert.equal(harness.server.notes.get(item.id).body, 'typed meanwhile');
    assertConverged(harness);
});

test('a create that fails although Joplin stored the note is adopted', async () => {
    const harness = makeHarness();
    const item = harness.list.add({title: 'once'});
    harness.client.inject({method: 'createNote', when: 'after', error: httpError()});
    await harness.run();
    assert.equal(harness.server.todosIn(harness.configured).length, 1);
    assertConverged(harness);
    assert.equal(harness.list.get(item.id).title, 'once');
});

test('an id already taken in Joplin gets a fresh one', async () => {
    const harness = makeHarness();
    const item = harness.list.add({title: 'mine'});
    harness.server.addNote({id: item.id, title: 'someone else', parent_id: ''});
    harness.server.trash(item.id);

    await harness.run();
    const [created] = harness.list.visible();
    assert.notEqual(created.id, item.id);
    assert.equal(harness.server.notes.get(created.id).title, 'mine');
    assert.equal(harness.server.notes.get(item.id).title, 'someone else');
    assertConverged(harness);
});

test('a missing or trashed notebook stops the sync and keeps the local list', async () => {
    const {harness} = await synced(['a', 'b']);
    harness.list.update(harness.list.visible()[0].id, {title: 'pending'});
    const before = JSON.stringify(harness.list.toJSON());

    harness.server.trashFolder(harness.configured);
    await assert.rejects(harness.run(), {kind: ErrorKind.NOTEBOOK_MISSING});
    assert.equal(JSON.stringify(harness.list.toJSON()), before);

    harness.configured = 'e'.repeat(32);
    await assert.rejects(harness.run(), {kind: ErrorKind.NOTEBOOK_MISSING});
    assert.equal(JSON.stringify(harness.list.toJSON()), before);
});

test('switching notebooks flushes pending changes to the old one first', async () => {
    const {harness, items: [item]} = await synced(['old item']);
    const oldFolder = harness.configured;
    const newFolder = harness.server.addFolder('Groceries');
    const remote = harness.server.addNote({parent_id: newFolder, title: 'eggs', is_todo: 1});
    harness.list.update(item.id, {title: 'edited before switching'});
    const unsynced = harness.list.add({title: 'added before switching'});

    harness.configured = newFolder;
    await harness.run();
    assert.equal(harness.server.notes.get(item.id).title, 'edited before switching');
    assert.equal(harness.server.notes.get(item.id).parent_id, oldFolder);
    assert.equal(harness.server.notes.get(unsynced.id).parent_id, oldFolder);
    assert.deepEqual(harness.list.visible().map(entry => entry.id), [remote]);
    assertConverged(harness);
});

test('switching away from a deleted notebook keeps local edits as new items', async () => {
    const {harness, items: [edited]} = await synced(['edited', 'untouched']);
    harness.list.update(edited.id, {title: 'edited offline'});
    harness.server.trashFolder(harness.configured);
    harness.configured = harness.server.addFolder('New home');

    await harness.run();
    assert.deepEqual(harness.list.visible().map(item => item.title), ['edited offline']);
    assertConverged(harness);
});

test('a user edit made during the sync is kept and pushed next time', async () => {
    const {harness, items: [item]} = await synced();
    harness.server.edit(item.id, {body: 'remote body'});
    harness.list.update(item.id, {title: 'first'});
    harness.client.beforeCall = method => {
        if (method === 'updateNote') {
            harness.client.beforeCall = null;
            harness.list.update(item.id, {title: 'typed while syncing'});
        }
    };

    await harness.run();
    assert.equal(harness.list.get(item.id).title, 'typed while syncing');
    assert.equal(harness.list.get(item.id).description, 'remote body');
    assert.equal(harness.server.notes.get(item.id).title, 'first');
    await harness.run();
    assert.equal(harness.server.notes.get(item.id).title, 'typed while syncing');
    assertConverged(harness);
});

test('a deletion made while the item is being pushed is not undone', async () => {
    const {harness, items: [item]} = await synced();
    harness.list.update(item.id, {title: 'edited'});
    harness.client.beforeCall = method => {
        if (method === 'updateNote') {
            harness.client.beforeCall = null;
            harness.list.remove(item.id);
        }
    };
    await harness.run();
    assert.equal(harness.list.get(item.id).deleted, true);
    await harness.run();
    assert.ok(harness.server.notes.get(item.id).deleted_time > 0);
    assert.equal(harness.list.get(item.id), undefined);
    assertConverged(harness);
});

test('items skipped or repeated by the listing are neither lost nor duplicated', async () => {
    const {harness, items: [hidden, repeated, gone]} = await synced(['hidden', 'repeated', 'gone']);
    harness.server.edit(hidden.id, {title: 'hidden but edited'});
    harness.list.remove(gone.id);
    harness.client.hiddenFromListing = new Set([hidden.id, gone.id]);
    harness.client.duplicatedInListing = new Set([repeated.id]);

    await harness.run();
    assert.equal(harness.list.get(hidden.id).title, 'hidden but edited');
    assert.ok(harness.server.notes.get(gone.id).deleted_time > 0);
    assert.equal(harness.list.visible().length, 2);
    harness.client.hiddenFromListing.clear();
    harness.client.duplicatedInListing.clear();
    assertConverged(harness);
});

test('changes are detected even when updated_time moves backwards', async () => {
    const {harness, items: [item]} = await synced();
    const before = harness.server.notes.get(item.id).updated_time;
    harness.server.edit(item.id, {title: 'synced from a phone'}, {updatedTime: before - 60_000});
    await harness.run();
    assert.equal(harness.list.get(item.id).title, 'synced from a phone');
    assertConverged(harness);
});

test('one failing item does not stop the others', async () => {
    const {harness, items: [stuck, fine]} = await synced(['stuck', 'fine']);
    harness.list.update(stuck.id, {title: 'stuck!'});
    harness.list.update(fine.id, {title: 'fine!'});
    harness.client.inject({method: 'updateNote', match: ([id]) => id === stuck.id,
        error: httpError()});

    const {result} = await harness.runCounting();
    assert.equal(result.stats.failed, 1);
    assert.equal(harness.server.notes.get(fine.id).title, 'fine!');
    assert.equal(harness.server.notes.get(stuck.id).title, 'stuck');
    await harness.run();
    assertConverged(harness);
});

test('going offline mid-run leaves a state the next run completes', async () => {
    const {harness, items: [a, b]} = await synced(['a', 'b']);
    harness.list.update(a.id, {title: 'a!'});
    harness.list.update(b.id, {title: 'b!'});
    harness.list.add({title: 'c'});
    harness.client.inject({method: 'updateNote', match: ([id]) => id === b.id});

    await assert.rejects(harness.run(), {kind: ErrorKind.OFFLINE});
    await harness.run();
    assertConverged(harness);
    assert.deepEqual(harness.list.visible().map(item => item.title).sort(), ['a!', 'b!', 'c']);
});

test('an invalid token aborts the run', async () => {
    const {harness} = await synced();
    harness.client.inject({method: 'listNotes',
        error: new JoplinError(ErrorKind.AUTH, 'bad token', {status: 403})});
    await assert.rejects(harness.run(), {kind: ErrorKind.AUTH});
});
