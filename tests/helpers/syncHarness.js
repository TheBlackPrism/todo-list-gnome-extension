import assert from 'node:assert/strict';

import {synchronize} from '../../src/lib/syncEngine.js';
import {noteToFields} from '../../src/lib/noteFields.js';
import {fieldsOf} from '../../src/lib/todoList.js';
import {FakeJoplinClient, FakeJoplinServer} from './fakeJoplin.js';
import {makeList} from './localList.js';

/**
 * A local list, a fake Joplin and a run() that syncs them the way the
 * extension does, saving the resolved notebook like the notebook-id setting.
 */
export function makeHarness({remoteStart, localStart} = {}) {
    const server = new FakeJoplinServer(remoteStart ? {startTime: remoteStart} : {});
    const client = new FakeJoplinClient(server);
    const local = makeList(localStart ? {startTime: localStart} : {});
    const harness = {
        server,
        client,
        ...local,
        configured: '',
        async run() {
            const result = await synchronize({
                list: local.list,
                client,
                notebookId: harness.configured,
            });
            harness.configured = result.notebookId;
            return result;
        },
        /** Runs and returns the writes made and local changes reported. */
        async runCounting() {
            client.resetCalls();
            local.changes.length = 0;
            const result = await harness.run();
            return {result, writes: client.writes(), changes: [...local.changes]};
        },
    };
    return harness;
}

const comparable = fields => ({...fields, completed: Boolean(fields.completed)});

export function localState(list) {
    return list.visible()
        .map(item => ({id: item.id, ...comparable(fieldsOf(item))}))
        .sort((a, b) => a.id.localeCompare(b.id));
}

export function remoteState(server, folderId) {
    return server.todosIn(folderId)
        .map(note => ({id: note.id, ...comparable(noteToFields(note))}))
        .sort((a, b) => a.id.localeCompare(b.id));
}

export function assertConverged(harness, message) {
    assert.deepEqual(localState(harness.list), remoteState(harness.server, harness.configured),
        message);
    for (const item of harness.list.items()) {
        assert.equal(item.deleted, false, `${message ?? ''}: tombstone left behind`);
        assert.notEqual(item.base, null, `${message ?? ''}: unsynced item left behind`);
    }
}
