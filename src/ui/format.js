// Human-readable due dates and sync states for the shell UI.

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as DateUtils from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {describeDue} from '../lib/dates.js';
import {SyncStatus} from '../lib/syncManager.js';

/**
 * @param {{year: number, month: number, day: number}} date
 * @param {number} [now]
 * @returns {string} e.g. "Today", "Tomorrow", "Friday", "Mon 27 Oct"
 */
export function formatDay({year, month, day}, now = Date.now()) {
    const date = new Date(year, month - 1, day);
    const info = describeDue(date.getTime(), now);
    if (info.days === 0)
        return _('Today');
    if (info.days === 1)
        return _('Tomorrow');
    if (info.days === -1)
        return _('Yesterday');
    if (info.days > 1 && info.days < 7)
        return DateUtils.formatDateWithCFormatString(date, '%A');
    if (year === new Date(now).getFullYear()) {
        /* Translators: a due date in the current year, e.g. "Mon 27 Oct". See
           strftime(3) for the format specifiers. */
        return DateUtils.formatDateWithCFormatString(date, _('%a %-d %b'));
    }
    /* Translators: a due date in another year, e.g. "Mon 27 Oct 2027". */
    return DateUtils.formatDateWithCFormatString(date, _('%a %-d %b %Y'));
}

/**
 * @param {number} due timestamp in ms, not 0
 * @param {number} [now]
 * @returns {string} e.g. "Tomorrow", "Today 14:30", "Mon 27 Oct 9:00 AM"
 */
export function formatDue(due, now = Date.now()) {
    const date = new Date(due);
    const day = formatDay({
        year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    }, now);
    if (describeDue(due, now).dateOnly)
        return day;
    /* Translators: a due date followed by its time, e.g. "Tomorrow 14:30" */
    return _('%s %s').format(day, DateUtils.formatTime(date, {timeOnly: true}).trim());
}

/**
 * @param {number} lastSync timestamp in ms
 * @param {number} [now]
 * @returns {string}
 */
function formatAgo(lastSync, now = Date.now()) {
    const minutes = Math.floor((now - lastSync) / 60000);
    if (minutes < 1)
        return _('Synced just now');
    if (minutes < 60)
        return ngettext('Synced %d minute ago', 'Synced %d minutes ago', minutes).format(minutes);
    const hours = Math.floor(minutes / 60);
    return ngettext('Synced %d hour ago', 'Synced %d hours ago', hours).format(hours);
}

/**
 * @param {import('../lib/syncManager.js').SyncManager} sync
 * @returns {{text: string, problem: boolean}}
 */
export function describeSync(sync) {
    switch (sync.status) {
    case SyncStatus.NOT_CONFIGURED:
        return {text: _('Not connected to Joplin'), problem: true};
    case SyncStatus.DISABLED:
        return {text: _('Sync with Joplin is off'), problem: false};
    case SyncStatus.SYNCING:
        return {text: _('Syncing…'), problem: false};
    case SyncStatus.OK:
        return {text: formatAgo(sync.lastSync), problem: false};
    case SyncStatus.PARTIAL:
        return {
            text: ngettext('%d to-do could not be synced', '%d to-dos could not be synced',
                sync.failedCount).format(sync.failedCount),
            problem: true,
        };
    case SyncStatus.OFFLINE:
        return {text: _('Joplin isn’t running; changes are kept here'), problem: true};
    case SyncStatus.AUTH_FAILED:
        return {text: _('Joplin rejected the token'), problem: true};
    case SyncStatus.NOTEBOOK_MISSING:
        return {text: _('The Joplin notebook is gone'), problem: true};
    default:
        return {text: _('Sync failed'), problem: true};
    }
}
