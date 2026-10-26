// Seeded random interleavings of local edits, edits made in Joplin, syncs and
// injected failures. Whatever happens, once failures stop the two sides must
// converge without duplicates, and a further sync must change nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import {ErrorKind, JoplinError} from '../../src/lib/errors.js';
import {assertConverged, makeHarness} from '../helpers/syncHarness.js';

const SEEDS = Number(process.env.SYNC_SEEDS) || 40;
const STEPS = 60;

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const tagOf = title => title.split('~')[0];

async function scenario(seed) {
    const random = mulberry32(seed);
    const pick = array => array[Math.floor(random() * array.length)];
    const chance = p => random() < p;
    const harness = makeHarness({
        localStart: Date.UTC(2026, 9, 1) + Math.floor(random() * 3_600_000),
        remoteStart: Date.UTC(2026, 9, 1) + Math.floor(random() * 3_600_000),
    });
    const {list, server, client} = harness;
    let tags = 0;
    let edits = 0;
    const log = [];

    const sync = async () => {
        if (chance(0.4)) {
            client.inject({
                method: pick(['createNote', 'updateNote', 'deleteNote', 'getNote', 'listNotes']),
                when: pick(['before', 'after']),
                error: chance(0.5)
                    ? new JoplinError(ErrorKind.OFFLINE, 'offline (fault)')
                    : new JoplinError(ErrorKind.HTTP, 'server error (fault)', {status: 500}),
            });
        }
        if (chance(0.2) && server.notes.size > 0)
            client.hiddenFromListing = new Set([pick([...server.notes.keys()])]);
        try {
            await harness.run();
            log.push('sync');
        } catch (error) {
            if (!(error instanceof JoplinError) || error.kind === ErrorKind.NOTEBOOK_MISSING)
                throw error;
            log.push(`sync failed: ${error.kind}`);
        }
        client.clearFaults();
        client.hiddenFromListing.clear();
    };

    await harness.run();
    const otherFolder = server.addFolder('Elsewhere');

    for (let step = 0; step < STEPS; step++) {
        const visible = list.visible();
        const remote = server.todosIn(harness.configured);
        const roll = random();
        if (roll < 0.12) {
            list.add({title: `L${++tags}`});
            log.push('local add');
        } else if (roll < 0.30 && visible.length) {
            const item = pick(visible);
            const what = pick(['title', 'description', 'due', 'completed']);
            if (what === 'title')
                list.update(item.id, {title: `${tagOf(item.title)}~l${++edits}`});
            else if (what === 'description')
                list.update(item.id, {description: `local ${++edits}`});
            else if (what === 'due')
                list.update(item.id, {due: chance(0.3) ? 0 : 1_800_000_000_000 + step});
            else
                list.setCompleted(item.id, !item.completed);
            log.push(`local edit ${what}`);
        } else if (roll < 0.36 && visible.length) {
            list.remove(pick(visible).id);
            log.push('local delete');
        } else if (roll < 0.46) {
            server.addNote({parent_id: harness.configured, title: `R${++tags}`, is_todo: 1});
            log.push('remote add');
        } else if (roll < 0.62 && remote.length) {
            const note = pick(remote);
            const what = pick(['title', 'body', 'todo_due', 'todo_completed']);
            const value = what === 'title' ? `${tagOf(note.title)}~r${++edits}`
                : what === 'body' ? `remote ${++edits}`
                    : what === 'todo_completed' ? (note.todo_completed ? 0 : server.now())
                        : 1_900_000_000_000 + step;
            server.edit(note.id, {[what]: value},
                chance(0.2) ? {updatedTime: note.updated_time - 5000} : undefined);
            log.push(`remote edit ${what}`);
        } else if (roll < 0.68 && remote.length) {
            server.trash(pick(remote).id);
            log.push('remote trash');
        } else if (roll < 0.71 && remote.length) {
            server.purge(pick(remote).id);
            log.push('remote purge');
        } else if (roll < 0.73 && remote.length) {
            server.edit(pick(remote).id, {parent_id: otherFolder});
            log.push('remote move');
        } else {
            await sync();
        }
    }

    // Failures stop: a few clean runs must settle everything.
    for (let round = 0; round < 3; round++)
        await harness.run();
    const context = `seed ${seed}: ${log.join(', ')}`;
    assertConverged(harness, context);

    const {writes, changes} = await harness.runCounting();
    assert.deepEqual(writes, [], `extra writes, ${context}`);
    assert.deepEqual(changes, [], `extra changes, ${context}`);

    const titles = server.todosIn(harness.configured).map(note => tagOf(note.title));
    assert.equal(new Set(titles).size, titles.length, `duplicates ${titles}, ${context}`);
}

test('random interleavings converge without duplicates', async () => {
    for (let seed = 1; seed <= SEEDS; seed++)
        await scenario(seed);
});
