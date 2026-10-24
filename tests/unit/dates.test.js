import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DATE_ONLY_HOUR, addDays, compareOpen, composeDue, dayDifference, describeDue,
    formatTime, isDateOnly, isOverdue, parseTime, splitDue, startOfDay,
} from '../../src/lib/dates.js';

// The expectations below are in local time; the npm script runs with
// TZ=Europe/Zurich, which has DST changes on 2026-03-29 and 2026-10-25.
process.env.TZ = 'Europe/Zurich';

const at = (year, month, day, hours = 0, minutes = 0) =>
    new Date(year, month - 1, day, hours, minutes).getTime();

test('a date-only due date is stored at the reminder hour', () => {
    const due = composeDue(2026, 10, 24);
    assert.equal(new Date(due).getHours(), DATE_ONLY_HOUR);
    assert.equal(isDateOnly(due), true);
    assert.deepEqual(splitDue(due), {year: 2026, month: 10, day: 24, time: null});
});

test('a due date with a time keeps it', () => {
    const due = composeDue(2026, 10, 24, {hours: 14, minutes: 30});
    assert.equal(isDateOnly(due), false);
    assert.deepEqual(splitDue(due).time, {hours: 14, minutes: 30});
    assert.equal(splitDue(0), null);
    assert.equal(isDateOnly(0), false);
});

test('only an exact reminder-hour time reads as date-only', () => {
    assert.equal(isDateOnly(at(2026, 10, 24, DATE_ONLY_HOUR, 1)), false);
    assert.equal(isDateOnly(at(2026, 10, 24, DATE_ONLY_HOUR) + 1000), false);
});

test('times parse and format', () => {
    assert.deepEqual(parseTime('9:05'), {hours: 9, minutes: 5});
    assert.deepEqual(parseTime(' 09.05 '), {hours: 9, minutes: 5});
    assert.deepEqual(parseTime('23:59'), {hours: 23, minutes: 59});
    assert.equal(parseTime(''), null);
    assert.equal(parseTime('   '), null);
    assert.equal(parseTime('24:00'), undefined);
    assert.equal(parseTime('12:60'), undefined);
    assert.equal(parseTime('noon'), undefined);
    assert.equal(formatTime({hours: 9, minutes: 5}), '09:05');
});

test('day arithmetic ignores DST shifts', () => {
    assert.equal(dayDifference(at(2026, 10, 24, 12), at(2026, 10, 26, 12)), 2);
    assert.equal(dayDifference(at(2026, 3, 28, 23, 30), at(2026, 3, 30, 0, 30)), 2);
    assert.equal(dayDifference(at(2026, 10, 24, 23, 59), at(2026, 10, 24, 0, 0)), 0);
    assert.equal(dayDifference(at(2026, 10, 24), at(2026, 10, 23, 23, 59)), -1);
    assert.equal(new Date(addDays(at(2026, 10, 24, 9), 1)).getHours(), 9);
    assert.equal(startOfDay(at(2026, 10, 25, 15, 45)), at(2026, 10, 25));
});

test('a date-only item is overdue only once its day has passed', () => {
    const due = composeDue(2026, 10, 24);
    assert.equal(isOverdue(due, at(2026, 10, 24, 8)), false);
    assert.equal(isOverdue(due, at(2026, 10, 24, 23, 59)), false);
    assert.equal(isOverdue(due, at(2026, 10, 25, 0, 1)), true);
});

test('a timed item is overdue once its time has passed', () => {
    const due = composeDue(2026, 10, 24, {hours: 10, minutes: 0});
    assert.equal(isOverdue(due, at(2026, 10, 24, 9, 59)), false);
    assert.equal(isOverdue(due, at(2026, 10, 24, 10, 1)), true);
    assert.equal(isOverdue(0, at(2026, 10, 24)), false);
});

test('describeDue gives the distance in calendar days', () => {
    const now = at(2026, 10, 24, 18);
    assert.deepEqual(describeDue(composeDue(2026, 10, 25), now),
        {overdue: false, dateOnly: true, days: 1});
    assert.deepEqual(describeDue(composeDue(2026, 10, 23, {hours: 8, minutes: 0}), now),
        {overdue: true, dateOnly: false, days: -1});
    assert.equal(describeDue(0, now), null);
});

test('open items sort overdue first, then by due date, then by creation', () => {
    const now = at(2026, 10, 24, 12);
    const items = [
        {name: 'undated-new', due: 0, createdTime: 5},
        {name: 'today-date-only', due: composeDue(2026, 10, 24), createdTime: 1},
        {name: 'tomorrow', due: composeDue(2026, 10, 25), createdTime: 2},
        {name: 'today-15:00', due: composeDue(2026, 10, 24, {hours: 15, minutes: 0}), createdTime: 3},
        {name: 'overdue', due: composeDue(2026, 10, 24, {hours: 10, minutes: 0}), createdTime: 4},
        {name: 'undated-old', due: 0, createdTime: 0},
    ];
    items.sort((a, b) => compareOpen(a, b, now));
    assert.deepEqual(items.map(item => item.name), [
        'overdue', 'today-15:00', 'today-date-only', 'tomorrow', 'undated-old', 'undated-new',
    ]);
});
