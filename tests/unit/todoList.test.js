import test from 'node:test';
import assert from 'node:assert/strict';

import {FORMAT_VERSION, FormatError, Origin, TodoList, isDirty} from '../../src/lib/todoList.js';
import {makeList} from '../helpers/localList.js';

test('add creates an unsynced item and reports a user change', () => {
    const {list, changes} = makeList();
    const item = list.add({title: 'Buy milk'});
    assert.match(item.id, /^[0-9a-f]{32}$/);
    assert.equal(item.base, null);
    assert.equal(item.description, '');
    assert.equal(item.due, 0);
    assert.equal(item.completed, 0);
    assert.equal(isDirty(item), true);
    assert.deepEqual(changes, [Origin.USER]);
});

test('update applies only the given fields and ignores no-ops', () => {
    const {list, changes} = makeList();
    const item = list.add({title: 'A', description: 'one'});
    const before = item.updatedTime;
    assert.equal(list.update(item.id, {title: 'A'}), false);
    assert.equal(changes.length, 1);
    assert.equal(list.update(item.id, {title: 'B'}), true);
    assert.equal(item.title, 'B');
    assert.equal(item.description, 'one');
    assert.ok(item.updatedTime > before);
    assert.deepEqual(changes, [Origin.USER, Origin.USER]);
});

test('completion is a timestamp toggled by setCompleted', () => {
    const {list} = makeList();
    const item = list.add({title: 'A'});
    assert.equal(list.setCompleted(item.id, true), true);
    assert.ok(item.completed > 0);
    assert.equal(list.setCompleted(item.id, true), false);
    assert.equal(list.setCompleted(item.id, false), true);
    assert.equal(item.completed, 0);
});

test('remove leaves a tombstone that visible() hides', () => {
    const {list} = makeList();
    const keep = list.add({title: 'keep'});
    const gone = list.add({title: 'gone'});
    assert.equal(list.remove(gone.id), true);
    assert.equal(list.remove(gone.id), false);
    assert.equal(list.get(gone.id).deleted, true);
    assert.deepEqual(list.visible().map(item => item.id), [keep.id]);
    assert.equal(list.items().length, 2);
    assert.equal(list.update(gone.id, {title: 'x'}), false);
});

test('clearCompleted removes the completed items only', () => {
    const {list, changes} = makeList();
    const a = list.add({title: 'a'});
    list.add({title: 'b'});
    const c = list.add({title: 'c'});
    list.setCompleted(a.id, true);
    list.setCompleted(c.id, true);
    changes.length = 0;
    assert.equal(list.clearCompleted(), 2);
    assert.deepEqual(list.visible().map(item => item.title), ['b']);
    assert.deepEqual(changes, [Origin.USER]);
    assert.equal(list.clearCompleted(), 0);
    assert.equal(changes.length, 1);
});

test('load and toJSON round-trip, dropping invalid items', () => {
    const {list} = makeList();
    const a = list.add({title: 'a', due: 1234.4});
    list.applySynced(a.id, {title: 'a', description: '', due: 1234, completed: 0}, a);
    list.add({title: 'b'});
    list.bindNotebook('f'.repeat(32));
    const data = JSON.parse(JSON.stringify(list.toJSON()));
    data.todos.push({id: 'not-an-id', title: 'bad'});
    data.todos.push({...data.todos[0]}); // duplicate id

    const other = new TodoList({newId: () => 'x'});
    other.load(data);
    assert.deepEqual(other.toJSON(), list.toJSON());
    assert.equal(other.notebookId, 'f'.repeat(32));
});

test('load rejects data it does not understand', () => {
    const list = new TodoList({newId: () => 'x'});
    assert.throws(() => list.load(null), FormatError);
    assert.throws(() => list.load({version: FORMAT_VERSION}), FormatError);
    assert.throws(() => list.load({version: FORMAT_VERSION + 1, todos: []}), FormatError);
});

test('applySynced keeps fields the user changed since the snapshot', () => {
    const {list, changes} = makeList();
    const item = list.add({title: 'old', description: 'd'});
    const snapshot = {...item};
    list.update(item.id, {title: 'typed during sync'});
    changes.length = 0;

    list.applySynced(item.id, {title: 'from joplin', description: 'new d', due: 0, completed: 0},
        snapshot);
    assert.equal(item.title, 'typed during sync');
    assert.equal(item.description, 'new d');
    assert.deepEqual(item.base, {title: 'from joplin', description: 'new d', due: 0, completed: 0});
    assert.deepEqual(changes, [Origin.SYNC]);

    // Nothing to change: no event.
    list.applySynced(item.id, {...item.base}, {...item, title: 'other'});
    assert.deepEqual(changes, [Origin.SYNC]);
});

test('applySynced never undoes a deletion', () => {
    const {list} = makeList();
    const item = list.add({title: 'a'});
    const snapshot = {...item};
    list.remove(item.id);
    list.applySynced(item.id, {title: 'a', description: '', due: 0, completed: 0}, snapshot);
    assert.equal(item.deleted, true);
    assert.notEqual(item.base, null);
});

test('rekey gives a fresh, unsynced identity', () => {
    const {list} = makeList();
    const item = list.add({title: 'a'});
    list.applySynced(item.id, {...item}, {...item});
    const fresh = list.rekey(item.id);
    assert.notEqual(fresh.id, item.id);
    assert.equal(fresh.base, null);
    assert.equal(fresh.title, 'a');
    assert.equal(list.get(item.id), undefined);
});

test('bindNotebook detach keeps unsynced and edited items as new ones', () => {
    const {list} = makeList();
    const synced = fields => {
        const item = list.add(fields);
        list.applySynced(item.id, {...item}, {...item});
        return item;
    };
    const untouched = synced({title: 'untouched'});
    const edited = synced({title: 'edited'});
    const deleted = synced({title: 'deleted'});
    const local = list.add({title: 'local only'});
    list.bindNotebook('1'.repeat(32));
    list.update(edited.id, {title: 'edited!'});
    list.remove(deleted.id);

    list.bindNotebook('2'.repeat(32), 'detach');
    const titles = list.items().map(item => item.title).sort();
    assert.deepEqual(titles, ['edited!', 'local only']);
    assert.equal(list.get(untouched.id), undefined);
    assert.equal(list.get(edited.id), undefined);
    assert.ok(list.get(local.id));
    assert.ok(list.items().every(item => item.base === null));
    assert.equal(list.notebookId, '2'.repeat(32));
});
