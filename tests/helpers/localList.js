import {TodoList} from '../../src/lib/todoList.js';

/**
 * A TodoList with deterministic ids and a controllable clock, recording the
 * origin of every change.
 *
 * @param {object} [options]
 * @param {number} [options.startTime]
 */
export function makeList({startTime = Date.UTC(2026, 9, 1, 7, 0, 0)} = {}) {
    let seq = 0;
    let clock = startTime;
    const changes = [];
    const list = new TodoList({
        newId: () => (++seq).toString(16).padStart(32, 'a'),
        now: () => {
            clock += 1000;
            return clock;
        },
        onChange: origin => changes.push(origin),
    });
    return {
        list,
        changes,
        setClock: time => {
            clock = time;
        },
    };
}
