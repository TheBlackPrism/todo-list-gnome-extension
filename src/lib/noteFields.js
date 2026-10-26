// Mapping between local to-do fields and Joplin note properties. Shared by the
// real client, the sync engine and the test fakes: no gi:// imports.

/** Note properties requested when listing a notebook. */
export const LIST_FIELDS = [
    'id', 'title', 'body', 'is_todo', 'todo_due', 'todo_completed',
    'created_time', 'updated_time', 'is_conflict',
];

/** Note properties requested for a single note. They are enough to tell why a
 * note left the notebook listing. */
export const NOTE_FIELDS = [...LIST_FIELDS, 'parent_id', 'deleted_time'];

const REMOTE_NAMES = Object.freeze({
    title: 'title',
    description: 'body',
    due: 'todo_due',
    completed: 'todo_completed',
});

/**
 * @param {object} note a Joplin note
 * @returns {{title: string, description: string, due: number, completed: number}}
 */
export function noteToFields(note) {
    return {
        title: typeof note.title === 'string' ? note.title : '',
        description: typeof note.body === 'string' ? note.body : '',
        due: Math.max(0, Math.round(Number(note.todo_due) || 0)),
        completed: Math.max(0, Math.round(Number(note.todo_completed) || 0)),
    };
}

/**
 * Builds a note patch. Joplin's PUT does no type coercion, so numbers are
 * sent as integers.
 *
 * @param {object} fields local fields
 * @param {string[]} [keys] which fields to include (default: all)
 * @returns {object}
 */
export function fieldsToNote(fields, keys = Object.keys(REMOTE_NAMES)) {
    const note = {};
    for (const key of keys) {
        const value = fields[key];
        note[REMOTE_NAMES[key]] = typeof value === 'number' ? Math.round(value) : value;
    }
    return note;
}

/**
 * Whether a note from a notebook listing belongs in the list. The notebook
 * endpoint already leaves out trashed notes, but not conflict copies.
 *
 * @param {object} note
 * @returns {boolean}
 */
export function isListedTodo(note) {
    return Number(note.is_todo) === 1 && !Number(note.is_conflict);
}

/**
 * Whether a single note (fetched with NOTE_FIELDS) is still one of the
 * notebook's to-dos.
 *
 * @param {object} note
 * @param {string} folderId
 * @returns {boolean}
 */
export function isActiveTodoIn(note, folderId) {
    return isListedTodo(note) && note.parent_id === folderId && !Number(note.deleted_time);
}

/**
 * Collects every page of a paginated Data API listing. Joplin reports
 * `has_more` whenever a page is full, so the last page can be empty.
 *
 * @param {(page: number) => Promise<{items: object[], has_more: boolean}>} fetchPage
 * @param {number} [maxPages] guard against a server that never stops
 * @returns {Promise<object[]>}
 */
export async function fetchAllPages(fetchPage, maxPages = 1000) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
        const result = await fetchPage(page);
        const pageItems = Array.isArray(result?.items) ? result.items : [];
        items.push(...pageItems);
        if (!result?.has_more || pageItems.length === 0)
            break;
    }
    return items;
}
