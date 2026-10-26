// Due dates use Joplin's representation: a Unix timestamp in milliseconds, 0 for
// none. Joplin raises an alarm at that moment on desktop and mobile, so a due
// date without a time is stored at DATE_ONLY_HOUR local time, a morning
// reminder on the day. A due time of exactly that hour reads as date-only.
//
// This module is shared with the unit tests, so it must not import from gi://.

export const DATE_ONLY_HOUR = 9;

/**
 * @param {number} year full year
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @param {{hours: number, minutes: number}|null} [time] null for a date-only due date
 * @returns {number} timestamp in ms
 */
export function composeDue(year, month, day, time = null) {
    const date = time
        ? new Date(year, month - 1, day, time.hours, time.minutes, 0, 0)
        : new Date(year, month - 1, day, DATE_ONLY_HOUR, 0, 0, 0);
    return date.getTime();
}

/**
 * @param {number} due
 * @returns {boolean}
 */
export function isDateOnly(due) {
    if (!due)
        return false;
    const date = new Date(due);
    return date.getHours() === DATE_ONLY_HOUR && date.getMinutes() === 0 &&
        date.getSeconds() === 0 && date.getMilliseconds() === 0;
}

/**
 * @param {number} due
 * @returns {{year: number, month: number, day: number,
 *     time: {hours: number, minutes: number}|null}|null}
 */
export function splitDue(due) {
    if (!due)
        return null;
    const date = new Date(due);
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        time: isDateOnly(due) ? null : {hours: date.getHours(), minutes: date.getMinutes()},
    };
}

/**
 * Parses "H:MM", "HH:MM" or "HH.MM".
 *
 * @param {string} text
 * @returns {{hours: number, minutes: number}|null|undefined} null for empty
 *     text, undefined when the text isn't a valid time
 */
export function parseTime(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return null;
    const match = /^(\d{1,2})[:.](\d{2})$/.exec(trimmed);
    if (!match)
        return undefined;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59)
        return undefined;
    return {hours, minutes};
}

/**
 * @param {{hours: number, minutes: number}} time
 * @returns {string} "HH:MM"
 */
export function formatTime(time) {
    return `${String(time.hours).padStart(2, '0')}:${String(time.minutes).padStart(2, '0')}`;
}

/**
 * @param {number} timestamp
 * @returns {number} local midnight of that day
 */
export function startOfDay(timestamp) {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * @param {number} timestamp
 * @param {number} days may be negative
 * @returns {number} same local wall-clock time, `days` calendar days later
 */
export function addDays(timestamp, days) {
    const date = new Date(timestamp);
    date.setDate(date.getDate() + days);
    return date.getTime();
}

/**
 * @param {number} now
 * @returns {number} calendar days from `now` to the coming Friday, 0 on a Friday
 */
export function daysUntilFriday(now) {
    return (5 - new Date(now).getDay() + 7) % 7;
}

/**
 * Whole calendar days from `from` to `to` in local time, unaffected by DST.
 *
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function dayDifference(from, to) {
    const a = new Date(from);
    const b = new Date(to);
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((utcB - utcA) / 86400000);
}

/**
 * A date-only item is overdue once its day has passed; a timed one as soon as
 * its time has.
 *
 * @param {number} due
 * @param {number} now
 * @returns {boolean}
 */
export function isOverdue(due, now) {
    if (!due)
        return false;
    if (isDateOnly(due))
        return dayDifference(now, due) < 0;
    return due < now;
}

/**
 * @param {number} due
 * @param {number} now
 * @returns {{overdue: boolean, dateOnly: boolean, days: number}|null} days is
 *     the calendar-day distance from today (0 = today, 1 = tomorrow, -1 = yesterday)
 */
export function describeDue(due, now) {
    if (!due)
        return null;
    return {
        overdue: isOverdue(due, now),
        dateOnly: isDateOnly(due),
        days: dayDifference(now, due),
    };
}

// A date-only item is due by the end of its day, so it sorts after the timed
// items of the same day.
function dueSortKey(due) {
    return isDateOnly(due) ? addDays(startOfDay(due), 1) - 1 : due;
}

/**
 * Order for open items: overdue first, then by due date, then undated items
 * in the order they were created.
 *
 * @param {{due: number, createdTime: number}} a
 * @param {{due: number, createdTime: number}} b
 * @param {number} now
 * @returns {number}
 */
export function compareOpen(a, b, now) {
    const overdueA = isOverdue(a.due, now);
    const overdueB = isOverdue(b.due, now);
    if (overdueA !== overdueB)
        return overdueA ? -1 : 1;
    if (Boolean(a.due) !== Boolean(b.due))
        return a.due ? -1 : 1;
    if (a.due && b.due && dueSortKey(a.due) !== dueSortKey(b.due))
        return dueSortKey(a.due) - dueSortKey(b.due);
    return a.createdTime - b.createdTime;
}

/**
 * Order for completed items: most recently completed first.
 *
 * @param {{completed: number}} a
 * @param {{completed: number}} b
 * @returns {number}
 */
export function compareCompleted(a, b) {
    return b.completed - a.completed;
}
